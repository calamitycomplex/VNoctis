/**
 * Deterministic, idempotent Title -> ArchiveItem -> Game catalog mapping.
 *
 * Model roles:
 *   - Title       = logical visual novel
 *   - ArchiveItem = one physical archive/source directory
 *   - Game        = legacy/runtime compatibility record (still required by
 *                   builds, playback, favorites, covers and publishing)
 *
 * One discovered source gets one ArchiveItem and — until VNDB/manual merging
 * exists — one Title, plus the compatibility Game that already existed.
 *
 * This module operates on Prisma transaction clients only and performs no
 * filesystem access, so it can never mutate the read-only archive source.
 *
 * Conflicts are reported, never silently repaired: no conflicting row is
 * deleted, and no duplicate Title/ArchiveItem is created around a conflict.
 */

/** Source fields that must stay consistent between a Game and its ArchiveItem. */
export const MAPPING_SOURCE_FIELDS = ['directoryPath', 'directoryName', 'sourceAvailable'];

/** Machine-readable conflict codes returned by {@link ensureArchiveMapping}. */
export const MAPPING_CONFLICT = {
  ARCHIVE_ITEM_MISSING: 'ARCHIVE_ITEM_MISSING',
  TITLE_MISSING: 'TITLE_MISSING',
  INCONSISTENT_MAPPING: 'INCONSISTENT_MAPPING',
  DIRECTORY_PATH_CONFLICT: 'DIRECTORY_PATH_CONFLICT',
};

function conflict(code, message) {
  return { status: 'conflict', code, message };
}

/** Merge caller-supplied source fields over the Game's current values. */
function desiredSource(game, source) {
  return {
    directoryPath: source.directoryPath ?? game.directoryPath,
    directoryName: source.directoryName ?? game.directoryName,
    sourceAvailable: source.sourceAvailable ?? game.sourceAvailable,
  };
}

/**
 * Ensure a Game has a consistent Title/ArchiveItem mapping, creating it when
 * the Game is not yet mapped. Adoption reuses the existing Game untouched
 * except for `archiveItemId`; it never recreates the Game.
 *
 * @param {object} tx Prisma transaction client.
 * @param {object} game Existing or freshly created Game row. `id`, `archiveItemId`
 *   and the source fields must be present.
 * @param {object} [options]
 * @param {string} [options.titleName] Name used when creating a Title, or to fill
 *   a NULL existing name; a non-null name is never overwritten.
 * @param {object} [options.source] New source fields (partial allowed); defaults
 *   to the Game's own values.
 * @param {boolean} [options.apply=true] When false, only reads are performed.
 * @param {{createdAt: Date, updatedAt: Date}} [options.timestamps] Timestamps to
 *   preserve on created rows and the Game link update.
 * @returns {Promise<{status: 'linked'|'created'|'would-create'|'conflict',
 *   item?: object, title?: object, code?: string, message?: string}>}
 */
export async function ensureArchiveMapping(tx, game, options = {}) {
  const { apply = true, titleName, timestamps } = options;
  const source = desiredSource(game, options.source || {});

  if (game.archiveItemId) {
    const item = await tx.archiveItem.findUnique({ where: { id: game.archiveItemId } });
    if (!item) {
      return conflict(MAPPING_CONFLICT.ARCHIVE_ITEM_MISSING, `Missing ArchiveItem ${game.archiveItemId}`);
    }

    const title = await tx.title.findUnique({ where: { id: item.titleId } });
    if (!title) {
      return conflict(MAPPING_CONFLICT.TITLE_MISSING, `Missing Title ${item.titleId}`);
    }

    const mismatches = MAPPING_SOURCE_FIELDS.filter((field) => item[field] !== game[field]);
    if (mismatches.length) {
      return conflict(
        MAPPING_CONFLICT.INCONSISTENT_MAPPING,
        `ArchiveItem source fields differ from Game: ${mismatches.join(', ')}`,
      );
    }

    if (!apply) return { status: 'linked', item, title };

    const sourceDiffers = MAPPING_SOURCE_FIELDS.some((field) => item[field] !== source[field]);
    if (sourceDiffers) {
      await tx.archiveItem.update({ where: { id: item.id }, data: source });
    }

    // One-time fill only: manual/VNDB canonical naming arrives in a later slice.
    if (title.name == null && titleName) {
      await tx.title.update({ where: { id: title.id }, data: { name: titleName } });
      title.name = titleName;
    }

    return { status: 'linked', item, title };
  }

  const occupied = await tx.archiveItem.findUnique({ where: { directoryPath: source.directoryPath } });
  if (occupied) {
    return conflict(
      MAPPING_CONFLICT.DIRECTORY_PATH_CONFLICT,
      `ArchiveItem ${occupied.id} already occupies ${source.directoryPath}; manual review required`,
    );
  }

  if (!apply) return { status: 'would-create' };

  const preserved = timestamps ? { createdAt: timestamps.createdAt, updatedAt: timestamps.updatedAt } : {};
  const title = await tx.title.create({ data: { name: titleName || game.directoryName || null, ...preserved } });
  const item = await tx.archiveItem.create({ data: { titleId: title.id, ...source, ...preserved } });
  await tx.game.update({
    where: { id: game.id },
    data: {
      archiveItemId: item.id,
      ...(timestamps ? { updatedAt: timestamps.updatedAt } : {}),
    },
  });

  return { status: 'created', item, title };
}
