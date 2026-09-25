import { access } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createReadStream } from 'node:fs';

/** Map file extensions to MIME types for cover images. */
const MIME_MAP = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};

const TITLE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a stored coverPath to an absolute file path. */
function resolveCoverFile(coversDir, coverPath) {
  return coverPath.startsWith('/') ? coverPath : join(coversDir, coverPath);
}

/**
 * Cover image serving route plugin.
 *
 * `GET /covers/:gameId` is the unchanged legacy Game-keyed route.
 * `GET /covers/titles/:titleId` is the Title-owned route: it serves the
 * Title-owned file when present, otherwise a single unambiguous legacy Game
 * cover, and never guesses a primary Game for multi-release Titles.
 *
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function coversRoutes(fastify) {
  const coversDir = process.env.COVERS_PATH || '/covers';

  /** Stream a resolved cover file with cache headers. */
  async function serveCover(reply, coverFile) {
    const ext = extname(coverFile).toLowerCase();
    const contentType = MIME_MAP[ext] || 'application/octet-stream';
    reply.header('Content-Type', contentType);
    reply.header('Cache-Control', 'public, max-age=86400');
    return reply.send(createReadStream(coverFile));
  }

  /**
   * GET /covers/:gameId
   * Serves the cached cover image file for a game.
   */
  fastify.get('/covers/:gameId', async (request, reply) => {
    const { gameId } = request.params;

    if (!gameId || gameId.length !== 32) {
      return reply.code(400).send({
        code: 'INVALID_GAME_ID',
        message: 'gameId must be a 32-character hex string.',
      });
    }

    // Look up the game to find its coverPath
    const game = await fastify.prisma.game.findUnique({
      where: { id: gameId },
      select: { coverPath: true },
    });

    if (!game) {
      return reply.code(404).send({
        code: 'GAME_NOT_FOUND',
        message: `Game with id "${gameId}" not found.`,
      });
    }

    if (!game.coverPath) {
      return reply.code(404).send({
        code: 'COVER_NOT_FOUND',
        message: 'No cover image available for this game.',
      });
    }

    // Resolve the cover file path
    const coverFile = resolveCoverFile(coversDir, game.coverPath);

    if (!(await fileExists(coverFile))) {
      return reply.code(404).send({
        code: 'COVER_NOT_FOUND',
        message: 'Cover image file not found on disk.',
      });
    }

    return serveCover(reply, coverFile);
  });

  /**
   * GET /covers/titles/:titleId
   * Serves the Title-owned cover, falling back to exactly one usable legacy
   * Game cover. Ambiguous legacy covers are not arbitrarily selected.
   */
  fastify.get('/covers/titles/:titleId', async (request, reply) => {
    const { titleId } = request.params;

    if (!TITLE_UUID.test(titleId)) {
      return reply.code(400).send({
        code: 'INVALID_TITLE_ID',
        message: 'titleId must be a UUID.',
      });
    }

    const title = await fastify.prisma.title.findUnique({
      where: { id: titleId },
      select: {
        id: true,
        coverPath: true,
        archiveItems: { select: { game: { select: { coverPath: true } } } },
      },
    });

    if (!title) {
      return reply.code(404).send({
        code: 'TITLE_NOT_FOUND',
        message: `Title with id "${titleId}" not found.`,
      });
    }

    // 1. Title-owned cover file
    if (title.coverPath) {
      const titleOwnedFile = resolveCoverFile(coversDir, title.coverPath);
      if (await fileExists(titleOwnedFile)) {
        return serveCover(reply, titleOwnedFile);
      }
    }

    // 2. Exactly one distinct usable legacy Game cover
    const legacyPaths = [
      ...new Set(
        title.archiveItems
          .map((item) => item.game?.coverPath)
          .filter(Boolean),
      ),
    ];
    const usableLegacyFiles = [];
    for (const coverPath of legacyPaths) {
      const file = resolveCoverFile(coversDir, coverPath);
      if (await fileExists(file)) usableLegacyFiles.push(file);
    }
    const uniqueUsable = [...new Set(usableLegacyFiles)];

    if (uniqueUsable.length === 1) {
      return serveCover(reply, uniqueUsable[0]);
    }

    return reply.code(404).send({
      code: 'COVER_NOT_FOUND',
      message: 'No cover image available for this title.',
    });
  });
}
