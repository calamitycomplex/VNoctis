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
 * Cover URL for DISPLAY ONLY.
 *
 * Prefers the Title-owned `metadata.coverUrl` (which is safe for both
 * Title-owned media and a single unambiguous legacy fallback). Falls back to a
 * single Game's legacy cover URL for older payloads. Returns null for ambiguous
 * multi-release Titles so the existing gradient fallback is used — never picks a
 * primary Game.
 */
export function coverUrlFor(title) {
  if (!title) return null;
  if (title.metadata?.coverUrl) return title.metadata.coverUrl;
  const game = singleGameFor(title);
  if (game?.coverPath) return `/api/v1/covers/${game.id}`;
  return null;
}

/**
 * Screenshot URLs for display. Prefers Title-owned metadata screenshot URLs and
 * falls back to a single Game's screenshots. Multi-release Titles with no Title
 * screenshots must not borrow an arbitrary release's set.
 */
export function screenshotUrlsFor(title) {
  if (!title) return [];
  const urls = title.metadata?.screenshotUrls;
  if (urls?.length) return urls;
  const game = singleGameFor(title);
  return game?.screenshots ?? [];
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

/**
 * Original / native title for display.
 *
 * Uses Title.metadata first (single-Game fallback only), and returns null when
 * the value is empty or effectively identical to the primary display title, so
 * cards never show a duplicated title line.
 */
export function originalTitleFor(title) {
  const meta = title?.metadata ?? {};
  const game = singleGameFor(title);
  const original = meta.vndbTitleOriginal ?? game?.vndbTitleOriginal ?? null;
  if (typeof original !== 'string') return null;
  const trimmed = original.trim();
  if (!trimmed) return null;
  const primary = displayTitleFor(title);
  if (primary && primary.trim().toLowerCase() === trimmed.toLowerCase()) return null;
  return trimmed;
}

/**
 * Compact runtime length label: "45m", "18h", "2h 30m". Null when unknown.
 */
export function formatLengthMinutes(minutes) {
  if (minutes == null) return null;
  const total = Number(minutes);
  if (!Number.isFinite(total) || total <= 0) return null;
  const whole = Math.round(total);
  const hours = Math.floor(whole / 60);
  const mins = whole % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

/**
 * Release year for display. Title metadata first, single-Game fallback only.
 * Handles partial VNDB dates ("2024-09") and plain years.
 */
export function releaseYearFor(title) {
  const meta = title?.metadata ?? {};
  const game = singleGameFor(title);
  const raw = meta.releaseDate ?? game?.releaseDate ?? null;
  if (!raw) return null;
  const date = new Date(raw);
  if (!Number.isNaN(date.getTime())) return String(date.getUTCFullYear());
  const match = String(raw).match(/(\d{4})/);
  return match ? match[1] : null;
}

/**
 * Compact card facts derived from Title metadata (single-Game fallback only).
 * Missing facts are null so callers can omit them without empty separators.
 * Multi-release Titles never borrow one Game's metadata.
 */
export function cardFactsFor(title) {
  if (!title) return { rating: null, year: null, length: null };
  const meta = logicalMetadataFor(title);
  return {
    rating: meta.vndbRating ?? null,
    year: releaseYearFor(title),
    length: formatLengthMinutes(meta.lengthMinutes),
  };
}

/**
 * Non-spoiler tag names, capped, stable order. Title metadata is preferred with
 * a single-Game fallback; malformed input is treated as empty.
 */
function nonSpoilerTagNames(title, max) {
  const meta = title?.metadata ?? {};
  const game = singleGameFor(title);
  const source = Array.isArray(meta.tags) && meta.tags.length > 0
    ? meta.tags
    : (Array.isArray(game?.tags) ? game.tags : []);
  return source
    .filter((tag) => tag && typeof tag.name === 'string' && tag.name.trim())
    .filter((tag) => !(tag.spoiler && tag.spoiler > 0))
    .slice(0, max)
    .map((tag) => tag.name.trim());
}

/** Display-only tag names for the compact card. */
export function cardTagsFor(title, max = 3) {
  return nonSpoilerTagNames(title, max);
}

/** Display-only tag names for the richer detail modal (larger cap). */
export function detailTagsFor(title, max = 16) {
  return nonSpoilerTagNames(title, max);
}

/**
 * Detail facts derived from Title metadata (single-Game fallback only).
 * Missing values are null so the detail modal can omit them cleanly.
 */
export function detailFactsFor(title) {
  if (!title) return { rating: null, year: null, length: null, developer: null };
  const meta = logicalMetadataFor(title);
  return {
    rating: meta.vndbRating ?? null,
    year: releaseYearFor(title),
    length: formatLengthMinutes(meta.lengthMinutes),
    developer: meta.developer ?? null,
  };
}

/** True when a Title has more than one ArchiveItem (a multi-release Title). */
export function isMultiRelease(title) {
  return archiveItemsOf(title).length > 1;
}

/** True when the Title can safely run Game-keyed actions (exactly one Game). */
export function hasRuntimeActions(title) {
  return singleGameFor(title) !== null;
}
