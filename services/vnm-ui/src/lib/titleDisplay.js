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
  if (items.length === 1) {
    const game = items[0].game;
    return game?.vndbTitle || title.name || game?.extractedTitle || items[0].directoryName || 'Unknown';
  }
  return title.name || items[0]?.directoryName || 'Unknown';
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
