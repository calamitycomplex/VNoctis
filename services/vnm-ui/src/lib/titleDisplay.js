/**
 * Pure display helpers for the Title-centric library UI.
 *
 * Title is the catalog identity; ArchiveItems and their compatibility Games are
 * nested data. These helpers never mutate input and never promote an implicit
 * primary ArchiveItem/Game.
 */

/** ArchiveItems for a Title DTO, safely. */
export function archiveItemsOf(title) {
  return title?.archiveItems ?? [];
}

/**
 * The single compatibility Game for a one-ArchiveItem Title, else null.
 * Multi-release Titles deliberately return null (no implicit primary).
 */
export function singleGameFor(title) {
  const items = archiveItemsOf(title);
  return items.length === 1 ? items[0].game ?? null : null;
}

/**
 * Cacheable display name.
 * Single release keeps the familiar precedence (VNDB title first).
 * Multi-release prefers the Title name so conflicting Game metadata is never merged.
 */
export function displayTitleFor(title) {
  if (!title) return 'Unknown';
  const items = archiveItemsOf(title);
  const metadataTitle = title.metadata?.vndbTitle;
  if (items.length === 1) {
    const game = items[0].game;
    return metadataTitle || title.name || game?.vndbTitle || game?.extractedTitle || items[0].directoryName || 'Unknown';
  }
  return metadataTitle || title.name || items[0]?.directoryName || 'Unknown';
}

/**
 * Logical metadata for display: Title.metadata is authoritative, with the
 * single compatibility Game used only as a fallback during the compatibility
 * period. Multi-release Titles never borrow a nested Game (no implicit primary).
 */
export function logicalMetadataFor(title) {
  const meta = title?.metadata ?? {};
  const game = singleGameFor(title);
  const pick = (field) => meta[field] ?? game?.[field] ?? null;
  return {
    vndbId: pick('vndbId'),
    vndbTitle: pick('vndbTitle'),
    vndbTitleOriginal: pick('vndbTitleOriginal'),
    synopsis: pick('synopsis'),
    developer: pick('developer'),
    releaseDate: pick('releaseDate'),
    lengthMinutes: pick('lengthMinutes'),
    vndbRating: pick('vndbRating'),
    metadataSource: pick('metadataSource'),
    tags: meta.tags ?? game?.tags ?? [],
    screenshots: meta.screenshots ?? game?.screenshots ?? [],
    coverPath: meta.coverPath ?? game?.coverPath ?? null,
  };
}

/**
 * Cover Game for DISPLAY ONLY.
 * Returns a Game only when exactly one ArchiveItem has a usable cover; otherwise
 * null so the existing gradient fallback is used. Never implies a primary source.
 */
export function pickCoverGame(title) {
  const withCover = archiveItemsOf(title)
    .map((item) => item.game)
    .filter((game) => game?.coverPath);
  return withCover.length === 1 ? withCover[0] : null;
}

/** True when a Title has more than one ArchiveItem (a multi-release Title). */
export function isMultiRelease(title) {
  return archiveItemsOf(title).length > 1;
}

/** True when the Title can safely run Game-keyed actions (exactly one Game). */
export function hasRuntimeActions(title) {
  return singleGameFor(title) !== null;
}
