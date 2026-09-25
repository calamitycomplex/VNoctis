import {
  enrichGame,
  enrichGameById,
  enrichGameBySteamId,
  enrichTitle,
  enrichTitleById,
  enrichTitleBySteamId,
} from '../services/enrichment.js';

/** Title IDs are UUIDs, unlike the legacy 32-character Game fingerprint. */
const TITLE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Metadata refresh route plugin.
 *
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function metadataRoutes(fastify) {
  // ── VNDB search ─────────────────────────────────────────

  /**
   * GET /metadata/vndb/search?q=<text>
   *
   * Searches VNDB for visual novels matching a title string.
   * Used by the MetadataEditModal autocomplete dropdown.
   *
   * Query params:
   *   q  - Search text (minimum 3 characters)
   *
   * Returns an array of slim VN objects:
   *   [{ id, title, alttitle, developer, released }]
   */
  fastify.get('/metadata/vndb/search', async (request, reply) => {
    const q = (request.query.q || '').trim();

    if (q.length < 3) {
      return reply.code(400).send({
        code: 'QUERY_TOO_SHORT',
        message: 'Search query must be at least 3 characters.',
      });
    }

    const vndbClient = fastify.vndbClient;

    if (!vndbClient) {
      return reply.code(503).send({
        code: 'VNDB_CLIENT_UNAVAILABLE',
        message: 'VNDB client is not configured.',
      });
    }

    try {
      const results = await vndbClient.searchByTitle(q);

      // Return a slim payload for the dropdown
      const slim = results.map((vn) => ({
        id: vn.id,
        title: vn.title || '',
        alttitle: vn.alttitle || '',
        developer: vn.developers?.[0]?.name || '',
        released: vn.released || '',
      }));

      return slim;
    } catch (err) {
      request.log.error({ err: err.message, q }, 'VNDB search failed');
      return reply.code(500).send({
        code: 'VNDB_SEARCH_ERROR',
        message: err.message || 'VNDB search failed.',
      });
    }
  });

  // ── Steam search ────────────────────────────────────────

  /**
   * GET /metadata/steam/search?q=<text>
   *
   * Searches the locally-cached Steam app list for games matching a name.
   * Used by the MetadataEditModal autocomplete dropdown (Steam tab).
   *
   * Query params:
   *   q  - Search text (minimum 3 characters)
   *
   * Returns an array of Steam app objects:
   *   [{ appid, name, score }]
   */
  fastify.get('/metadata/steam/search', {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    const q = (request.query.q || '').trim();

    if (q.length < 3) {
      return reply.code(400).send({
        code: 'QUERY_TOO_SHORT',
        message: 'Search query must be at least 3 characters.',
      });
    }

    const steamClient = fastify.steamClient;

    if (!steamClient) {
      return reply.code(503).send({
        code: 'STEAM_CLIENT_UNAVAILABLE',
        message: 'Steam client is not configured.',
      });
    }

    try {
      const results = await steamClient.searchByName(q, 10);
      return results;
    } catch (err) {
      request.log.error({ err: err.message, q }, 'Steam search failed');
      return reply.code(500).send({
        code: 'STEAM_SEARCH_ERROR',
        message: err.message || 'Steam search failed.',
      });
    }
  });

  // ── Metadata refresh (VNDB + Steam) ─────────────────────

  /**
   * POST /metadata/:gameId/refresh
   *
   * Re-fetches metadata for a game from VNDB or Steam.
   *
   * When the Game is mapped to a Title, the refresh runs against that Title
   * (Title becomes authoritative) and mirrors logical fields to every nested
   * Game. Unmapped legacy Games keep the original Game-only behavior.
   *
   * Optional body:
   *   { vndbId: "v12345" }    - Force-link to a VNDB entry.
   *   { steamAppId: "12345" } - Force-link to a Steam app.
   *
   * Returns the updated game object (backward compatible).
   */
  fastify.post('/metadata/:gameId/refresh', async (request, reply) => {
    const { gameId } = request.params;

    if (!gameId || gameId.length !== 32) {
      return reply.code(400).send({
        code: 'INVALID_GAME_ID',
        message: 'gameId must be a 32-character hex string.',
      });
    }

    // Verify game exists and resolve its Title mapping when present.
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

    const vndbClient = fastify.vndbClient;
    const steamClient = fastify.steamClient;
    const coversPath = fastify.coversPath;
    const screenshotsPath = fastify.screenshotsPath;

    try {
      const body = request.body || {};
      const mappedTitle = game.archiveItem?.title ?? null;

      // ── Title-authoritative bridge ─────────────────────
      if (mappedTitle) {
        const games = await fastify.prisma.game.findMany({
          where: { archiveItem: { titleId: mappedTitle.id } },
          select: { id: true, sourceAvailable: true },
        });

        if (body.steamAppId) {
          if (!/^\d+$/.test(String(body.steamAppId))) {
            return reply.code(400).send({
              code: 'INVALID_STEAM_APP_ID',
              message: 'steamAppId must be a numeric value.',
            });
          }
          if (!steamClient) {
            return reply.code(503).send({
              code: 'STEAM_CLIENT_UNAVAILABLE',
              message: 'Steam client is not configured.',
            });
          }
          await enrichTitleBySteamId(
            body.steamAppId, mappedTitle, games, fastify.prisma, steamClient,
            coversPath, screenshotsPath, request.log, { steamAppIdTarget: gameId },
          );
        } else if (body.vndbId) {
          if (!vndbClient) {
            return reply.code(503).send({
              code: 'VNDB_CLIENT_UNAVAILABLE',
              message: 'VNDB client is not configured.',
            });
          }
          await enrichTitleById(
            body.vndbId, mappedTitle, games, fastify.prisma, vndbClient,
            coversPath, screenshotsPath, request.log,
          );
        } else if (game.steamAppId && steamClient) {
          await enrichTitleBySteamId(
            game.steamAppId, mappedTitle, games, fastify.prisma, steamClient,
            coversPath, screenshotsPath, request.log, { steamAppIdTarget: gameId },
          );
        } else if (mappedTitle.vndbId && vndbClient) {
          await enrichTitleById(
            mappedTitle.vndbId, mappedTitle, games, fastify.prisma, vndbClient,
            coversPath, screenshotsPath, request.log,
          );
        } else {
          if (!vndbClient) {
            return reply.code(503).send({
              code: 'VNDB_CLIENT_UNAVAILABLE',
              message: 'VNDB client is not configured.',
            });
          }
          await enrichTitle(
            mappedTitle, games, fastify.prisma, vndbClient,
            coversPath, screenshotsPath, request.log,
          );
        }

        return await fastify.prisma.game.findUnique({ where: { id: gameId } });
      }

      // ── Unmapped legacy Game fallback (original behavior) ──
      let updated;

      if (body.steamAppId) {
        if (!/^\d+$/.test(String(body.steamAppId))) {
          return reply.code(400).send({
            code: 'INVALID_STEAM_APP_ID',
            message: 'steamAppId must be a numeric value.',
          });
        }
        if (!steamClient) {
          return reply.code(503).send({
            code: 'STEAM_CLIENT_UNAVAILABLE',
            message: 'Steam client is not configured.',
          });
        }
        updated = await enrichGameBySteamId(
          body.steamAppId, game, fastify.prisma, steamClient, coversPath, screenshotsPath, request.log,
        );
        return updated;
      }

      if (body.vndbId) {
        if (!vndbClient) {
          return reply.code(503).send({
            code: 'VNDB_CLIENT_UNAVAILABLE',
            message: 'VNDB client is not configured.',
          });
        }
        updated = await enrichGameById(
          body.vndbId, game, fastify.prisma, vndbClient, coversPath, screenshotsPath, request.log,
        );
        return updated;
      }

      if (game.steamAppId && steamClient) {
        updated = await enrichGameBySteamId(
          game.steamAppId, game, fastify.prisma, steamClient, coversPath, screenshotsPath, request.log,
        );
        return updated;
      }

      if (game.vndbId && vndbClient) {
        updated = await enrichGameById(
          game.vndbId, game, fastify.prisma, vndbClient, coversPath, screenshotsPath, request.log,
        );
        return updated;
      }

      if (!vndbClient) {
        return reply.code(503).send({
          code: 'VNDB_CLIENT_UNAVAILABLE',
          message: 'VNDB client is not configured.',
        });
      }

      updated = await enrichGame(
        game, fastify.prisma, vndbClient, coversPath, screenshotsPath, request.log,
      );
      return updated;
    } catch (err) {
      request.log.error({ err: err.message, gameId }, 'Metadata refresh failed');
      return reply.code(500).send({
        code: 'ENRICHMENT_ERROR',
        message: err.message || 'Metadata refresh failed.',
      });
    }
  });

  /**
   * POST /metadata/titles/:titleId/refresh
   *
   * Title-authoritative refresh. UUID identity; writes logical metadata to the
   * Title and mirrors it to every nested compatibility Game.
   *
   * Body: { vndbId } or { steamAppId } to force-link; empty to resolve from the
   * stored Title.vndbId or search VNDB by the Title name.
   */
  fastify.post('/metadata/titles/:titleId/refresh', async (request, reply) => {
    const { titleId } = request.params;

    if (!TITLE_UUID.test(titleId)) {
      return reply.code(400).send({
        error: { code: 'INVALID_TITLE_ID', message: 'titleId must be a UUID.' },
      });
    }

    const title = await fastify.prisma.title.findUnique({ where: { id: titleId } });
    if (!title) {
      return reply.code(404).send({
        error: { code: 'TITLE_NOT_FOUND', message: `Title with id "${titleId}" not found.` },
      });
    }

    const vndbClient = fastify.vndbClient;
    const steamClient = fastify.steamClient;
    const coversPath = fastify.coversPath;
    const screenshotsPath = fastify.screenshotsPath;

    try {
      const body = request.body || {};
      const games = await fastify.prisma.game.findMany({
        where: { archiveItem: { titleId } },
        select: { id: true, sourceAvailable: true },
      });

      if (body.steamAppId) {
        if (!/^\d+$/.test(String(body.steamAppId))) {
          return reply.code(400).send({
            error: { code: 'INVALID_STEAM_APP_ID', message: 'steamAppId must be a numeric value.' },
          });
        }
        if (!steamClient) {
          return reply.code(503).send({
            error: { code: 'STEAM_CLIENT_UNAVAILABLE', message: 'Steam client is not configured.' },
          });
        }
        return await enrichTitleBySteamId(
          body.steamAppId, title, games, fastify.prisma, steamClient,
          coversPath, screenshotsPath, request.log,
        );
      }

      if (body.vndbId) {
        if (!vndbClient) {
          return reply.code(503).send({
            error: { code: 'VNDB_CLIENT_UNAVAILABLE', message: 'VNDB client is not configured.' },
          });
        }
        return await enrichTitleById(
          body.vndbId, title, games, fastify.prisma, vndbClient,
          coversPath, screenshotsPath, request.log,
        );
      }

      if (title.vndbId && vndbClient) {
        return await enrichTitleById(
          title.vndbId, title, games, fastify.prisma, vndbClient,
          coversPath, screenshotsPath, request.log,
        );
      }

      if (!vndbClient) {
        return reply.code(503).send({
          error: { code: 'VNDB_CLIENT_UNAVAILABLE', message: 'VNDB client is not configured.' },
        });
      }

      return await enrichTitle(
        title, games, fastify.prisma, vndbClient, coversPath, screenshotsPath, request.log,
      );
    } catch (err) {
      request.log.error({ err: err.message, titleId }, 'Title metadata refresh failed');
      return reply.code(500).send({
        error: { code: 'ENRICHMENT_ERROR', message: err.message || 'Title metadata refresh failed.' },
      });
    }
  });
}
