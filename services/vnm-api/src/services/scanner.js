import { readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { extractTitleFromOptions, cleanDirectoryName } from './titleExtractor.js';
import { ensureArchiveMapping, MAPPING_CONFLICT } from './archiveCatalog.js';

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

/** Log a mapping conflict without repairing the catalog link. */
function warnMappingConflict(log, game, mapping) {
  if (mapping.code === MAPPING_CONFLICT.DIRECTORY_PATH_CONFLICT) {
    log.warn?.(
      { gameId: game.id, directoryPath: game.directoryPath },
      'ArchiveItem directoryPath already occupied; Game left unmapped',
    );
    return;
  }
  log.warn?.(
    { gameId: game.id, archiveItemId: game.archiveItemId },
    'Missing or inconsistent archive mapping; linked ArchiveItem left unchanged',
  );
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
 * 6. Ensures each discovered source has a deterministic Title -> ArchiveItem -> Game mapping.
 * 7. Games in DB not discovered in this scan are marked unavailable and retained.
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
        // Manual titles remain the display identity; otherwise use the fresh
        // extraction. Validate the OLD source before moving the ArchiveItem.
        const nextExtractedTitle =
          existing.metadataSource !== 'manual' ? extractedTitle : existing.extractedTitle;
        const mapping = await ensureArchiveMapping(tx, existing, { titleName: nextExtractedTitle, source });
        if (mapping.status === 'conflict') warnMappingConflict(log, existing, mapping);
        await tx.game.update({
          where: { id },
          data: {
            ...source,
            // Preserve manually edited titles and all metadata/runtime fields.
            ...(existing.metadataSource !== 'manual' ? { extractedTitle } : {}),
          },
        });
      } else {
        const created = await tx.game.create({ data: { id, ...source, extractedTitle } });
        // Adopt the new compatibility Game into the archive catalog immediately.
        const mapping = await ensureArchiveMapping(tx, created, { titleName: extractedTitle, source });
        if (mapping.status === 'conflict') warnMappingConflict(log, created, mapping);
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
      const mapping = await ensureArchiveMapping(tx, game, {
        titleName: game.extractedTitle || game.directoryName,
        source: { sourceAvailable: false },
      });
      if (mapping.status === 'conflict') warnMappingConflict(log, game, mapping);
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
