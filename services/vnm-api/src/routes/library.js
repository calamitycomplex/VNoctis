import { rm, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { scanGamesDirectory } from '../services/scanner.js';
import {
  runBatchTitleEnrichment,
  applyTitleLogicalWrite,
  pickMediaStorageGame,
  TITLE_LOGICAL_FIELDS,
} from '../services/enrichment.js';
import { downloadCover } from '../services/coverDownloader.js';
import { removeScreenshots } from '../services/screenshotDownloader.js';
import {
  TITLE_SELECT,
  loadFavoriteGameIds,
  parsePagination,
  buildTitleWhere,
  serializeTitle,
} from '../services/titleCatalog.js';

/**
 * Parse JSON string fields (tags, screenshots) on a game object.
 * Returns the game with tags/screenshots as parsed arrays.
 *
 * @param {object} game - A Game record from Prisma.
 * @returns {object} The game with parsed JSON fields.
 */
function parseGameJsonFields(game) {
  if (!game) return game;
  return {
    ...game,
    tags: safeJsonParse(game.tags, []),
    screenshots: safeJsonParse(game.screenshots, []),
  };
}

/**
 * Safely parse a JSON string, returning a fallback on failure.
 */
function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/** Valid sort columns */
const VALID_SORT_FIELDS = ['extractedTitle', 'vndbRating', 'releaseDate', 'createdAt', 'builtAt'];

/** Alias map for query-friendly sort names */
const SORT_ALIAS = {
  title: 'extractedTitle',
  rating: 'vndbRating',
  releaseDate: 'releaseDate',
  createdAt: 'createdAt',
  builtAt: 'builtAt',
};

/** Valid build status values */
const VALID_BUILD_STATUSES = ['not_built', 'queued', 'building', 'built', 'failed', 'stale'];

/** Valid metadata source values */
const VALID_METADATA_SOURCES = ['auto', 'manual', 'unmatched'];

/** Title logical fields editable through PATCH /library/titles/:titleId. */
const TITLE_EDITABLE_FIELDS = [
  'name',
  'vndbId',
  'vndbTitle',
  'vndbTitleOriginal',
  'synopsis',
  'developer',
  'releaseDate',
  'lengthMinutes',
  'vndbRating',
  'tags',
  'screenshots',
  'coverPath',
];

/**
 * Library CRUD route plugin.
 *
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function libraryRoutes(fastify) {
  const gamesPath = process.env.GAMES_PATH || '/games';

  /**
   * GET /library
   * Returns all games with optional filtering and sorting.
   *
   * Query params:
   *   search       - Filter by title (case-insensitive contains)
   *   sort         - title | rating | releaseDate | createdAt (default: title)
   *   order        - asc | desc (default: asc)
   *   buildStatus  - Filter by build status
   *   metadataSource - Filter by metadata source
   *   sourceAvailable - true | false (omit for all availability states)
   */
  fastify.get('/library', async (request, reply) => {
    const {
      search,
      sort = 'title',
      order = 'asc',
      buildStatus,
      metadataSource,
      includeHidden,
      sourceAvailable,
    } = request.query;

    // Build the where clause
    const where = {};

    if (search) {
      where.extractedTitle = { contains: search };
    }

    if (sourceAvailable !== undefined) {
      if (sourceAvailable !== 'true' && sourceAvailable !== 'false') {
        return reply.code(400).send({
          error: { code: 'INVALID_SOURCE_AVAILABLE', message: 'sourceAvailable must be true or false.' },
        });
      }
      where.sourceAvailable = sourceAvailable === 'true';
    }

    if (buildStatus) {
      if (!VALID_BUILD_STATUSES.includes(buildStatus)) {
        return { error: { code: 'INVALID_BUILD_STATUS', message: `Invalid buildStatus. Must be one of: ${VALID_BUILD_STATUSES.join(', ')}` } };
      }
      where.buildStatus = buildStatus;
    }

    if (metadataSource) {
      if (!VALID_METADATA_SOURCES.includes(metadataSource)) {
        return { error: { code: 'INVALID_METADATA_SOURCE', message: `Invalid metadataSource. Must be one of: ${VALID_METADATA_SOURCES.join(', ')}` } };
      }
      where.metadataSource = metadataSource;
    }

    // Exclude hidden games by default
    if (includeHidden !== 'true') {
      where.hidden = false;
    }

    // Resolve sort field
    const sortField = SORT_ALIAS[sort] || sort;
    if (!VALID_SORT_FIELDS.includes(sortField)) {
      return { error: { code: 'INVALID_SORT', message: `Invalid sort field. Must be one of: title, rating, releaseDate, createdAt` } };
    }

    const orderDir = order === 'desc' ? 'desc' : 'asc';

    const games = await fastify.prisma.game.findMany({
      where,
      orderBy: { [sortField]: orderDir },
    });

    // Attach per-user favorite status
    const userId = request.user?.userId;
    let favoriteSet = new Set();
    if (userId) {
      const userFavorites = await fastify.prisma.userFavorite.findMany({
        where: { userId },
        select: { gameId: true },
      });
      favoriteSet = new Set(userFavorites.map(f => f.gameId));
    }

    return games.map(g => ({
      ...parseGameJsonFields(g),
      favorite: favoriteSet.has(g.id),
    }));
  });

  /** Title IDs are UUIDs, unlike the legacy 32-character Game fingerprint. */
  const TITLE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /**
   * GET /library/titles
   * Title-centric paginated catalog read. Compatibility: /library and
   * /library/:gameId remain Game-centric and unchanged.
   *
   * Query params:
   *   search          - case-insensitive match on Title.name, ArchiveItem
   *                     directoryName, or compatibility Game title fields
   *   sort            - name (only supported field; default name)
   *   order           - asc | desc (default asc)
   *   sourceAvailable - true | false (Title-level aggregate)
   *   page            - 1-based page (default 1)
   *   pageSize        - items per page (default 50, max 100)
   */
  fastify.get('/library/titles', async (request, reply) => {
    const { search, sort = 'name', order = 'asc', sourceAvailable } = request.query;

    if (sort !== 'name') {
      return reply.code(400).send({ error: { code: 'INVALID_SORT', message: 'sort must be name.' } });
    }
    if (order !== 'asc' && order !== 'desc') {
      return reply.code(400).send({ error: { code: 'INVALID_ORDER', message: 'order must be asc or desc.' } });
    }
    if (sourceAvailable !== undefined && sourceAvailable !== 'true' && sourceAvailable !== 'false') {
      return reply.code(400).send({
        error: { code: 'INVALID_SOURCE_AVAILABLE', message: 'sourceAvailable must be true or false.' },
      });
    }

    const pagination = parsePagination(request.query);
    if (pagination.error) return reply.code(400).send({ error: pagination.error });

    const where = buildTitleWhere({ search, sourceAvailable });
    const orderBy = [{ name: order === 'desc' ? 'desc' : 'asc' }, { id: 'asc' }];

    const [totalItems, titles] = await Promise.all([
      fastify.prisma.title.count({ where }),
      fastify.prisma.title.findMany({
        where,
        select: TITLE_SELECT,
        orderBy,
        skip: (pagination.page - 1) * pagination.pageSize,
        take: pagination.pageSize,
      }),
    ]);

    const favoriteGameIds = await loadFavoriteGameIds(fastify.prisma, request.user?.userId, titles);

    return {
      items: titles.map((title) => serializeTitle(title, favoriteGameIds)),
      pagination: {
        page: pagination.page,
        pageSize: pagination.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pagination.pageSize),
      },
    };
  });

  /**
   * GET /library/titles/:titleId
   * Full Title detail, including every ArchiveItem and its nested compatibility Game.
   */
  fastify.get('/library/titles/:titleId', async (request, reply) => {
    const { titleId } = request.params;

    if (!TITLE_UUID.test(titleId)) {
      return reply.code(400).send({
        error: { code: 'INVALID_TITLE_ID', message: 'titleId must be a UUID.' },
      });
    }

    const title = await fastify.prisma.title.findUnique({
      where: { id: titleId },
      select: TITLE_SELECT,
    });

    if (!title) {
      return reply.code(404).send({
        error: { code: 'TITLE_NOT_FOUND', message: `Title with id "${titleId}" not found.` },
      });
    }

    const favoriteGameIds = await loadFavoriteGameIds(fastify.prisma, request.user?.userId, [title]);
    return serializeTitle(title, favoriteGameIds);
  });

  /**
   * PATCH /library/titles/:titleId
   * Manual logical-metadata edit on the authoritative Title. Sets
   * Title.metadataSource='manual' and mirrors compatible logical fields to every
   * nested compatibility Game. Title.name has no Game equivalent and stays
   * Title-only; Game.extractedTitle is never touched.
   */
  fastify.patch('/library/titles/:titleId', async (request, reply) => {
    const { titleId } = request.params;

    if (!TITLE_UUID.test(titleId)) {
      return reply.code(400).send({
        error: { code: 'INVALID_TITLE_ID', message: 'titleId must be a UUID.' },
      });
    }

    const title = await fastify.prisma.title.findUnique({ where: { id: titleId }, select: { id: true } });
    if (!title) {
      return reply.code(404).send({
        error: { code: 'TITLE_NOT_FOUND', message: `Title with id "${titleId}" not found.` },
      });
    }

    const body = request.body;
    if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
      return reply.code(400).send({ error: { code: 'EMPTY_BODY', message: 'Request body must include at least one field.' } });
    }

    const updateData = {};
    for (const field of TITLE_EDITABLE_FIELDS) {
      if (!(field in body)) continue;
      let value = body[field];
      if ((field === 'tags' || field === 'screenshots') && Array.isArray(value)) value = JSON.stringify(value);
      if (field === 'releaseDate' && value !== null) value = new Date(value);
      updateData[field] = value;
    }

    if (Object.keys(updateData).length === 0) {
      return reply.code(400).send({
        error: { code: 'NO_VALID_FIELDS', message: `Allowed fields: ${TITLE_EDITABLE_FIELDS.join(', ')}` },
      });
    }

    const games = await fastify.prisma.game.findMany({
      where: { archiveItem: { titleId } },
      select: { id: true, sourceAvailable: true },
    });

    // Optional remote cover: download once through the temporary media-storage
    // adapter Game, then mirror the resulting logical path.
    if (updateData.coverPath && /^https?:\/\//.test(updateData.coverPath)) {
      const storageGame = pickMediaStorageGame(games);
      if (storageGame) {
        const coversPath = fastify.coversPath || '/covers';
        try {
          const existing = await readdir(coversPath);
          for (const file of existing) {
            if (file.startsWith(storageGame.id)) await rm(join(coversPath, file), { force: true });
          }
        } catch { /* covers dir may not exist yet */ }

        const localPath = await downloadCover(updateData.coverPath, storageGame.id, coversPath);
        if (localPath) updateData.coverPath = localPath;
        else return reply.code(400).send({
          error: { code: 'COVER_DOWNLOAD_FAILED', message: 'Failed to download the cover image from the provided URL.' },
        });
      }
    }

    updateData.metadataSource = 'manual';
    await fastify.prisma.$transaction((tx) => applyTitleLogicalWrite(tx, titleId, updateData, games));

    const full = await fastify.prisma.title.findUnique({ where: { id: titleId }, select: TITLE_SELECT });
    const favoriteGameIds = await loadFavoriteGameIds(fastify.prisma, request.user?.userId, [full]);
    return serializeTitle(full, favoriteGameIds);
  });

  /**
   * POST /library/unhide-all
   * Bulk unhide all hidden games.
   */
  fastify.post('/library/unhide-all', async (request, reply) => {
    const result = await fastify.prisma.game.updateMany({
      where: { hidden: true },
      data: { hidden: false },
    });
    return { unhiddenCount: result.count };
  });

  /**
   * GET /library/:gameId
   * Returns full detail for one game.
   */
  fastify.get('/library/:gameId', async (request, reply) => {
    const { gameId } = request.params;

    if (!gameId || gameId.length !== 32) {
      return reply.code(400).send({
        code: 'INVALID_GAME_ID',
        message: 'gameId must be a 32-character hex string.',
      });
    }

    const game = await fastify.prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) {
      return reply.code(404).send({
        code: 'GAME_NOT_FOUND',
        message: `Game with id "${gameId}" not found.`,
      });
    }

    // Attach per-user favorite status
    const userId = request.user?.userId;
    let isFavorite = false;
    if (userId) {
      const fav = await fastify.prisma.userFavorite.findUnique({
        where: { userId_gameId: { userId, gameId } },
      });
      isFavorite = !!fav;
    }

    return {
      ...parseGameJsonFields(game),
      favorite: isFavorite,
    };
  });

  /**
   * POST /library/scan
   * Triggers a full directory rescan. Returns immediately with a job ID.
   */
  fastify.post('/library/scan', async (request, reply) => {
    // Create a scan job record
    const scanJob = await fastify.prisma.scanJob.create({
      data: {
        status: 'running',
      },
    });

    // Run the scan asynchronously (don't await)
    runScanAsync(scanJob.id, gamesPath, fastify.prisma, fastify.vndbClient, fastify.coversPath, fastify.screenshotsPath, fastify.log);

    reply.code(202);
    return { jobId: scanJob.id };
  });

  /**
   * GET /library/scan/:jobId
   * Returns scan job status.
   */
  fastify.get('/library/scan/:jobId', async (request, reply) => {
    const { jobId } = request.params;

    const job = await fastify.prisma.scanJob.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      return reply.code(404).send({
        code: 'JOB_NOT_FOUND',
        message: `Scan job with id "${jobId}" not found.`,
      });
    }

    return job;
  });

  /**
   * PATCH /library/:gameId
   * Updates manual overrides for metadata fields.
   */
  fastify.patch('/library/:gameId', async (request, reply) => {
    const { gameId } = request.params;

    if (!gameId || gameId.length !== 32) {
      return reply.code(400).send({
        code: 'INVALID_GAME_ID',
        message: 'gameId must be a 32-character hex string.',
      });
    }

    const game = await fastify.prisma.game.findUnique({
      where: { id: gameId },
      include: { archiveItem: { include: { title: true } } },
    });

    if (!game) {
      return reply.code(404).send({
        code: 'GAME_NOT_FOUND',
        message: `Game with id "${gameId}" not found.`,
      });
    }

    const body = request.body;
    if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
      return reply.code(400).send({
        code: 'EMPTY_BODY',
        message: 'Request body must include at least one field to update.',
      });
    }

    // Whitelist of editable fields
    const editableFields = [
      'extractedTitle',
      'vndbId',
      'steamAppId',
      'vndbTitle',
      'vndbTitleOriginal',
      'synopsis',
      'developer',
      'releaseDate',
      'lengthMinutes',
      'vndbRating',
      'coverPath',
      'tags',
      'screenshots',
      'hidden',
    ];

    const updateData = {};
    for (const field of editableFields) {
      if (field in body) {
        let value = body[field];

        // Serialize arrays/objects to JSON strings for tags/screenshots
        if ((field === 'tags' || field === 'screenshots') && Array.isArray(value)) {
          value = JSON.stringify(value);
        }

        // Parse releaseDate string to Date
        if (field === 'releaseDate' && value !== null) {
          value = new Date(value);
        }

        updateData[field] = value;
      }
    }

    if (Object.keys(updateData).length === 0) {
      return reply.code(400).send({
        code: 'NO_VALID_FIELDS',
        message: `No valid editable fields provided. Allowed: ${editableFields.join(', ')}`,
      });
    }

    // If coverPath looks like a URL, download it locally
    if (updateData.coverPath && /^https?:\/\//.test(updateData.coverPath)) {
      const coversPath = fastify.coversPath || '/covers';

      // Remove existing cover so downloadCover doesn't skip
      try {
        const existingCovers = await readdir(coversPath);
        for (const f of existingCovers) {
          if (f.startsWith(gameId)) {
            await rm(join(coversPath, f), { force: true });
          }
        }
      } catch {
        // covers dir may not exist yet — downloadCover will create it
      }

      const localPath = await downloadCover(updateData.coverPath, gameId, coversPath);
      if (localPath) {
        updateData.coverPath = localPath;
      } else {
        return reply.code(400).send({
          code: 'COVER_DOWNLOAD_FAILED',
          message: 'Failed to download the cover image from the provided URL.',
        });
      }
    }

    // When the Game is mapped to a Title, Title is authoritative for logical
    // metadata: write Title and mirror to every sibling Game in one transaction.
    const mappedTitle = game.archiveItem?.title ?? null;
    if (mappedTitle) {
      const logicalUpdate = {};
      const gameUpdate = {};
      for (const key of Object.keys(updateData)) {
        if (TITLE_LOGICAL_FIELDS.includes(key)) logicalUpdate[key] = updateData[key];
        else gameUpdate[key] = updateData[key];
      }

      const hasLogical = Object.keys(logicalUpdate).length > 0;
      if (hasLogical) logicalUpdate.metadataSource = 'manual';

      const titleGames = await fastify.prisma.game.findMany({
        where: { archiveItem: { titleId: mappedTitle.id } },
        select: { id: true },
      });

      await fastify.prisma.$transaction(async (tx) => {
        if (hasLogical) await applyTitleLogicalWrite(tx, mappedTitle.id, logicalUpdate, titleGames);
        if (Object.keys(gameUpdate).length > 0) {
          await tx.game.update({ where: { id: gameId }, data: gameUpdate });
        }
      });

      const bridged = await fastify.prisma.game.findUnique({ where: { id: gameId } });
      return parseGameJsonFields(bridged);
    }

    // Unmapped legacy Game: preserve the original Game-only behavior.
    const nonHiddenFields = Object.keys(updateData).filter(k => k !== 'hidden');
    if (nonHiddenFields.length > 0) {
      updateData.metadataSource = 'manual';
    }

    const updated = await fastify.prisma.game.update({
      where: { id: gameId },
      data: updateData,
    });

    return parseGameJsonFields(updated);
  });

  /**
   * POST /library/:gameId/mark-playable
   *
   * Manually marks a game as playable by verifying that a valid web build
   * already exists on disk at /web-builds/<directoryName>/index.html.
   *
   * This is useful when:
   *  - A pre-built ZIP was manually extracted into /web-builds/
   *  - The automatic ZIP import during scan failed or was incomplete
   *  - The user wants to bypass the normal build process
   *
   * Returns 200 with the updated game on success, or 422 if no valid
   * web build is found on disk.
   */
  fastify.post('/library/:gameId/mark-playable', async (request, reply) => {
    const { gameId } = request.params;

    if (!gameId || gameId.length !== 32) {
      return reply.code(400).send({
        code: 'INVALID_GAME_ID',
        message: 'gameId must be a 32-character hex string.',
      });
    }

    const game = await fastify.prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) {
      return reply.code(404).send({
        code: 'GAME_NOT_FOUND',
        message: `Game with id "${gameId}" not found.`,
      });
    }

    const webBuildsPath = process.env.WEB_BUILDS_PATH || '/web-builds';
    const webBuildDir = join(webBuildsPath, game.directoryName);
    const indexPath = join(webBuildDir, 'index.html');

    // Verify a valid web build exists on disk
    try {
      await access(indexPath);
    } catch {
      return reply.code(422).send({
        code: 'NO_WEB_BUILD',
        message: `No valid web build found. Expected index.html at: /web-builds/${game.directoryName}/index.html`,
      });
    }

    const updated = await fastify.prisma.game.update({
      where: { id: gameId },
      data: {
        buildStatus: 'built',
        webBuildPath: `/web-builds/${game.directoryName}`,
        builtAt: new Date(),
      },
    });

    request.log.info(
      { gameId, webBuildPath: `/web-builds/${game.directoryName}` },
      'Game manually marked as playable'
    );

    return parseGameJsonFields(updated);
  });

  /**
   * DELETE /library/:gameId
   * Removes a library entry and application-owned generated artifacts:
   * web-build assets, cached covers/screenshots, build logs, and BuildJob records.
   * The source game/archive directory is never modified or deleted.
   */
  fastify.delete('/library/:gameId', async (request, reply) => {
    const { gameId } = request.params;

    if (!gameId || gameId.length !== 32) {
      return reply.code(400).send({
        code: 'INVALID_GAME_ID',
        message: 'gameId must be a 32-character hex string.',
      });
    }

    const game = await fastify.prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) {
      return reply.code(404).send({
        code: 'GAME_NOT_FOUND',
        message: `Game with id "${gameId}" not found.`,
      });
    }

    const webBuildsPath = process.env.WEB_BUILDS_PATH || '/web-builds';
    const coversPath = fastify.coversPath || '/covers';
    const screenshotsPath = fastify.screenshotsPath || '/screenshots';

    // 1. Delete web-build directory: /web-builds/<directoryName>/
    try {
      await rm(join(webBuildsPath, game.directoryName), { recursive: true, force: true });
      request.log.info({ path: join(webBuildsPath, game.directoryName) }, 'Deleted web-build directory');
    } catch (err) {
      request.log.warn({ err: err.message }, 'Failed to delete web-build directory');
    }

    // 2. Delete web-build zip: /web-builds/<directoryName>.zip
    try {
      await rm(join(webBuildsPath, `${game.directoryName}.zip`), { force: true });
    } catch (err) {
      request.log.warn({ err: err.message }, 'Failed to delete web-build zip');
    }

    // 3. Delete cover images: /covers/<gameId>.*
    try {
      const coverFiles = await readdir(coversPath);
      for (const file of coverFiles) {
        if (file.startsWith(gameId)) {
          await rm(join(coversPath, file), { force: true });
        }
      }
    } catch (err) {
      request.log.warn({ err: err.message }, 'Failed to clean up cover files');
    }

    // 4. Delete cached screenshots: /screenshots/<gameId>/
    try {
      await removeScreenshots(gameId, screenshotsPath);
      request.log.info({ gameId }, 'Deleted cached screenshots');
    } catch (err) {
      request.log.warn({ err: err.message }, 'Failed to clean up screenshot files');
    }

    // 5. Delete build logs for related BuildJobs
    const buildJobs = await fastify.prisma.buildJob.findMany({
      where: { gameId },
      select: { id: true },
    });
    for (const job of buildJobs) {
      try {
        await rm(join(webBuildsPath, 'logs', `${job.id}.log`), { force: true });
      } catch {
        // Best-effort log cleanup
      }
    }

    // 6. Delete BuildJob DB records
    await fastify.prisma.buildJob.deleteMany({ where: { gameId } });

    // 7. Delete the Game DB record
    await fastify.prisma.game.delete({ where: { id: gameId } });

    request.log.info({ gameId, title: game.extractedTitle }, 'Library entry deleted; source directory preserved');
    reply.code(204);
    return;
  });
}

/**
 * Run a scan in the background, then trigger batch enrichment for newly
 * discovered games. Updates the ScanJob record when done.
 */
async function runScanAsync(jobId, gamesPath, prisma, vndbClient, coversPath, screenshotsPath, logger) {
  try {
    const result = await scanGamesDirectory(gamesPath, prisma, logger);

    await prisma.scanJob.update({
      where: { id: jobId },
      data: {
        status: 'completed',
        gamesFound: result.found,
        gamesNew: result.new,
        gamesUnavailable: result.unavailable,
        gamesRemoved: 0, // Legacy field: scans now retain games with unavailable sources.
        completedAt: new Date(),
      },
    });

    logger.info({ jobId, ...result }, 'Library scan completed');

    // Trigger batch enrichment for any games needing metadata
    if (vndbClient && coversPath) {
      logger.info('Starting post-scan batch VNDB enrichment');
      try {
        const enrichResult = await runBatchTitleEnrichment(prisma, vndbClient, coversPath, screenshotsPath, logger);
        logger.info(
          {
            enriched: enrichResult.enriched,
            failed: enrichResult.failed,
            skipped: enrichResult.skipped,
          },
          'Post-scan batch enrichment completed'
        );
      } catch (enrichErr) {
        logger.warn({ err: enrichErr.message }, 'Post-scan batch enrichment failed');
      }
    }
  } catch (err) {
    logger.error({ jobId, err: err.message }, 'Library scan failed');

    await prisma.scanJob.update({
      where: { id: jobId },
      data: {
        status: 'failed',
        error: err.message,
        completedAt: new Date(),
      },
    });
  }
}
