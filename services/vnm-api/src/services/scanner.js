import { readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { extractTitleFromOptions, cleanDirectoryName } from './titleExtractor.js';

/**
 * Generate a stable fingerprint ID from a directory name.
 * Uses the first 32 hex characters of a SHA-256 hash.
 *
 * @param {string} dirName - The directory name to fingerprint.
 * @returns {string} A 32-character hex string.
 */
function generateFingerprint(dirName) {
  return createHash('sha256').update(dirName).digest('hex').slice(0, 32);
}

/** Update only a consistent existing mapping; never infer or repair identity. */
async function syncArchiveItem(tx, game, source, log) {
  if (!game.archiveItemId) return;
  const item = await tx.archiveItem.findUnique({ where: { id: game.archiveItemId } });
  const title = item && await tx.title.findUnique({ where: { id: item.titleId } });
  const fields = ['directoryPath', 'directoryName', 'sourceAvailable'];
  if (!item || !title || fields.some((field) => item[field] !== game[field])) {
    log.warn?.(
      { gameId: game.id, archiveItemId: game.archiveItemId },
      'Missing or inconsistent archive mapping; linked ArchiveItem left unchanged',
    );
    return;
  }
  await tx.archiveItem.update({ where: { id: item.id }, data: source });
}

/**
 * Inventory every top-level archive directory without importing or building it.
 * Filesystem access is read-only; artifact cleanup belongs to explicit maintenance.
 *
 * 1. Reads all entries in gamesPath.
 * 2. Includes every subdirectory regardless of engine or contents.
 * 3. Generates a stable ID from the directory name.
 * 4. Extracts the game title from options.rpy (fallback: cleaned dir name).
 * 5. Upserts into DB: new games are created, existing games get path and availability updated.
 * 6. Games in DB not discovered in this scan are marked unavailable and retained.
 *
 * @param {string} gamesPath - The root directory to scan (e.g. "/games").
 * @param {import('@prisma/client').PrismaClient} prisma - Prisma client instance.
 * @param {import('pino').Logger} [logger] - Optional logger.
 * @returns {Promise<{ found: number, new: number, unavailable: number, imported: number, orphansRemoved: number }>}
 */
export async function scanGamesDirectory(gamesPath, prisma, logger) {
  const log = logger || console;

  // Verify the games directory exists
  try {
    await access(gamesPath);
  } catch {
    throw new Error(`Games directory not accessible: ${gamesPath}`);
  }

  const entries = await readdir(gamesPath, { withFileTypes: true });
  const subdirs = entries.filter((e) => e.isDirectory());

  const discoveredIds = [];
  let newCount = 0;

  for (const entry of subdirs) {
    const dirPath = join(gamesPath, entry.name);

    const id = generateFingerprint(entry.name);
    discoveredIds.push(id);

    // Extract title
    const optionsTitle = await extractTitleFromOptions(dirPath);
    const extractedTitle = optionsTitle || cleanDirectoryName(entry.name);

    const source = { directoryPath: dirPath, directoryName: entry.name, sourceAvailable: true };
    await prisma.$transaction(async (tx) => {
      const existing = await tx.game.findUnique({ where: { id } });
      if (existing) {
        await syncArchiveItem(tx, existing, source, log);
        await tx.game.update({
          where: { id },
          data: {
            ...source,
            // Preserve manually edited titles and all metadata/runtime fields.
            ...(existing.metadataSource !== 'manual' ? { extractedTitle } : {}),
          },
        });
      } else {
        await tx.game.create({ data: { id, ...source, extractedTitle } });
        newCount++;
      }
    });
    log.info?.({ id, title: extractedTitle }, 'Inventoried archive directory');
  }

  // Preserve missing games and synchronize only their existing catalog mappings.
  const unavailableGames = await prisma.game.findMany({
    where: { id: { notIn: discoveredIds } },
    select: { id: true },
  });
  let unavailableCount = 0;
  for (const { id } of unavailableGames) {
    const markedUnavailable = await prisma.$transaction(async (tx) => {
      const game = await tx.game.findUnique({ where: { id } });
      if (!game) {
        log.warn?.({ gameId: id }, 'Game deleted before unavailable processing; skipping');
        return false;
      }
      await syncArchiveItem(tx, game, { sourceAvailable: false }, log);
      await tx.game.update({ where: { id }, data: { sourceAvailable: false } });
      return true;
    });
    if (markedUnavailable) unavailableCount++;
  }
  if (unavailableCount > 0) {
    log.info?.({ count: unavailableCount }, 'Marked undiscovered game sources unavailable');
  }

  return {
    found: discoveredIds.length,
    new: newCount,
    unavailable: unavailableCount,
    imported: 0, // Legacy result field: inventory never imports ZIPs
    orphansRemoved: 0, // Legacy result field: inventory never deletes artifacts
  };
}
