/**
 * Read-only Title-centric catalog projections.
 *
 * Title is the logical visual novel; ArchiveItem is a physical source
 * directory; Game is nested legacy/runtime compatibility data owned by the
 * ArchiveItem. This module only shapes reads — no writes, no filesystem access.
 */

/** Default and maximum page sizes for the Title list endpoint. */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

/** Compatibility Game fields safe to expose on a Title read. */
const GAME_SELECT = {
  id: true,
  extractedTitle: true,
  buildStatus: true,
  builtAt: true,
  webBuildPath: true,
  publishStatus: true,
  publishedAt: true,
  publishedVersion: true,
  hidden: true,
  metadataSource: true,
  vndbId: true,
  steamAppId: true,
  vndbTitle: true,
  vndbTitleOriginal: true,
  synopsis: true,
  developer: true,
  releaseDate: true,
  lengthMinutes: true,
  vndbRating: true,
  coverPath: true,
  tags: true,
  screenshots: true,
};

/**
 * Prisma select for a Title read. Uses relation select so Prisma batches the
 * ArchiveItem/Game reads instead of issuing one query per Title row.
 */
export const TITLE_SELECT = {
  id: true,
  name: true,
  createdAt: true,
  updatedAt: true,
  archiveItems: {
    select: {
      id: true,
      directoryName: true,
      directoryPath: true,
      sourceAvailable: true,
      game: { select: GAME_SELECT },
    },
    orderBy: [{ directoryName: 'asc' }, { id: 'asc' }],
  },
};

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * Serialize a nested compatibility Game. `favoriteGameIds` is an optional Set
 * of the requesting user's favorited Game IDs.
 */
export function serializeGame(game, favoriteGameIds) {
  if (!game) return null;
  return {
    ...game,
    tags: safeJsonParse(game.tags, []),
    screenshots: safeJsonParse(game.screenshots, []),
    favorite: favoriteGameIds ? favoriteGameIds.has(game.id) : false,
  };
}

/** Serialize one ArchiveItem, keeping the compatibility Game nested under it. */
export function serializeArchiveItem(item, favoriteGameIds) {
  return {
    id: item.id,
    directoryName: item.directoryName,
    directoryPath: item.directoryPath,
    sourceAvailable: item.sourceAvailable,
    game: serializeGame(item.game, favoriteGameIds),
  };
}

/**
 * Serialize a logical Title.
 *
 * Title.sourceAvailable is aggregated: true when AT LEAST ONE ArchiveItem is
 * available, false only when NONE are. No ArchiveItem is treated as primary.
 */
export function serializeTitle(title, favoriteGameIds) {
  const archiveItems = title.archiveItems.map((item) => serializeArchiveItem(item, favoriteGameIds));
  return {
    id: title.id,
    name: title.name,
    createdAt: title.createdAt,
    updatedAt: title.updatedAt,
    sourceAvailable: archiveItems.some((item) => item.sourceAvailable),
    archiveItems,
  };
}

/** Collect favorited Game IDs for the nested Games on the given Titles. */
export async function loadFavoriteGameIds(prisma, userId, titles) {
  if (!userId) return new Set();
  const gameIds = titles
    .flatMap((title) => title.archiveItems.map((item) => item.game?.id))
    .filter(Boolean);
  if (gameIds.length === 0) return new Set();
  const favorites = await prisma.userFavorite.findMany({
    where: { userId, gameId: { in: gameIds } },
    select: { gameId: true },
  });
  return new Set(favorites.map((favorite) => favorite.gameId));
}

/**
 * Parse `page`/`pageSize` query values.
 *
 * @returns {{page: number, pageSize: number} | {error: {code: string, message: string}}}
 */
export function parsePagination(query = {}) {
  const pagination = { page: 1, pageSize: DEFAULT_PAGE_SIZE };

  if (query.page !== undefined) {
    if (typeof query.page !== 'string' || !/^\d+$/.test(query.page) || Number(query.page) < 1) {
      return { error: { code: 'INVALID_PAGE', message: 'page must be a positive integer.' } };
    }
    pagination.page = Number(query.page);
  }

  if (query.pageSize !== undefined) {
    if (typeof query.pageSize !== 'string' || !/^\d+$/.test(query.pageSize) || Number(query.pageSize) < 1) {
      return { error: { code: 'INVALID_PAGE_SIZE', message: 'pageSize must be a positive integer.' } };
    }
    if (Number(query.pageSize) > MAX_PAGE_SIZE) {
      return { error: { code: 'INVALID_PAGE_SIZE', message: `pageSize must be at most ${MAX_PAGE_SIZE}.` } };
    }
    pagination.pageSize = Number(query.pageSize);
  }

  return pagination;
}

/**
 * Build the Prisma `where` for Title list filtering.
 *
 * `sourceAvailable=true`  -> Titles with at least one available ArchiveItem.
 * `sourceAvailable=false` -> Titles with zero available ArchiveItems
 *                            (NOT "has at least one unavailable item").
 *
 * `search` is case-insensitive `contains` over Title.name, ArchiveItem
 * directoryName, and the compatibility Game extractedTitle/vndbTitle.
 */
export function buildTitleWhere({ search, sourceAvailable } = {}) {
  const where = {};

  if (sourceAvailable === 'true') {
    where.archiveItems = { some: { sourceAvailable: true } };
  } else if (sourceAvailable === 'false') {
    where.archiveItems = { none: { sourceAvailable: true } };
  }

  if (search) {
    where.OR = [
      { name: { contains: search } },
      { archiveItems: { some: { directoryName: { contains: search } } } },
      { archiveItems: { some: { game: { extractedTitle: { contains: search } } } } },
      { archiveItems: { some: { game: { vndbTitle: { contains: search } } } } },
    ];
  }

  return where;
}
