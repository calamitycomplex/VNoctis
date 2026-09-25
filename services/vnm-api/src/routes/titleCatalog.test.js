import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import libraryRoutes from './library.js';

const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const gid = (n) => String(n).padStart(32, '0');
const contains = (haystack, needle) => (haystack || '').toLowerCase().includes(needle.toLowerCase());

const mkGame = (n, overrides = {}) => ({
  id: gid(n), extractedTitle: `Game ${n}`, buildStatus: 'not_built', builtAt: null,
  webBuildPath: null, publishStatus: 'not_published', publishedAt: null, publishedVersion: null,
  hidden: false, metadataSource: 'auto', vndbId: null, steamAppId: null, vndbTitle: null,
  vndbTitleOriginal: null, synopsis: null, developer: null, releaseDate: null, lengthMinutes: null,
  vndbRating: null, coverPath: null, tags: '[]', screenshots: '[]', sourceAvailable: true,
  ...overrides,
});

const mkItem = (id, { available = true, game = null } = {}) => ({
  id: `item-${id}`, directoryName: `Dir ${id}`, directoryPath: `/games/Dir ${id}`,
  sourceAvailable: available, game,
});

const mkTitle = (n, name, archiveItems) => ({
  id: uuid(n), name, createdAt: new Date('2020-01-01'), updatedAt: new Date('2021-01-01'), archiveItems,
});

function matchesTitle(title, where = {}) {
  if (where.OR && !where.OR.some((predicate) => matchesPredicate(title, predicate))) return false;
  if (where.archiveItems?.some) {
    const target = where.archiveItems.some.sourceAvailable;
    if (!title.archiveItems.some((item) => item.sourceAvailable === target)) return false;
  }
  if (where.archiveItems?.none) {
    const target = where.archiveItems.none.sourceAvailable;
    if (title.archiveItems.some((item) => item.sourceAvailable === target)) return false;
  }
  return true;
}

function matchesPredicate(title, predicate) {
  if (predicate.name) return contains(title.name, predicate.name.contains);
  const some = predicate.archiveItems?.some;
  if (some?.directoryName) return title.archiveItems.some((item) => contains(item.directoryName, some.directoryName.contains));
  if (some?.game?.extractedTitle) return title.archiveItems.some((item) => item.game && contains(item.game.extractedTitle, some.game.extractedTitle.contains));
  if (some?.game?.vndbTitle) return title.archiveItems.some((item) => item.game && contains(item.game.vndbTitle, some.game.vndbTitle.contains));
  return false;
}

function matchesGame(game, where = {}) {
  for (const field of ['hidden', 'sourceAvailable', 'buildStatus', 'metadataSource']) {
    if (where[field] !== undefined && game[field] !== where[field]) return false;
  }
  if (where.extractedTitle?.contains && !contains(game.extractedTitle, where.extractedTitle.contains)) return false;
  return true;
}

function comparator(orderBy = []) {
  return (a, b) => {
    for (const spec of orderBy) {
      const [field, dir] = Object.entries(spec)[0];
      const cmp = String(a[field] ?? '').localeCompare(String(b[field] ?? ''));
      if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
    }
    return 0;
  };
}

async function fixture(t, { titles = [], games = [], favorites = [] } = {}) {
  const state = { titles, games, favorites };
  const titleQueries = [];
  const prisma = {
    title: {
      count: async ({ where }) => state.titles.filter((title) => matchesTitle(title, where)).length,
      findMany: async ({ where, orderBy, skip, take }) => {
        titleQueries.push({ where, orderBy, skip, take });
        return state.titles
          .filter((title) => matchesTitle(title, where))
          .sort(comparator(orderBy))
          .slice(skip, skip + take);
      },
      findUnique: async ({ where }) => state.titles.find((title) => title.id === where.id) || null,
    },
    game: {
      findMany: async ({ where, orderBy }) =>
        state.games.filter((game) => matchesGame(game, where)).sort(comparator(orderBy ? [orderBy] : [])),
      findUnique: async ({ where }) => state.games.find((game) => game.id === where.id) || null,
    },
    userFavorite: {
      findMany: async ({ where }) =>
        state.favorites
          .filter((favorite) => favorite.userId === where.userId)
          .filter((favorite) => !where.gameId?.in || where.gameId.in.includes(favorite.gameId))
          .map((favorite) => ({ gameId: favorite.gameId })),
      findUnique: async ({ where }) =>
        state.favorites.find((favorite) => favorite.userId === where.userId_gameId.userId && favorite.gameId === where.userId_gameId.gameId) || null,
    },
  };

  const app = Fastify();
  app.decorate('prisma', prisma);
  app.addHook('onRequest', async (request) => { request.user = { userId: 'user' }; });
  await app.register(libraryRoutes);
  t.after(() => app.close());

  return { app, state, titleQueries };
}

test('empty Title catalog returns items=[] with correct pagination', async (t) => {
  const { app } = await fixture(t);
  const response = await app.inject('/library/titles');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { items: [], pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 } });
});

test('a normal Title uses Title identity, nests its ArchiveItem Game, and aggregates availability', async (t) => {
  const { app } = await fixture(t, {
    titles: [mkTitle(1, 'Alpha VN', [mkItem('a', { game: mkGame(101, { vndbTitle: 'Alpha' }) })])],
  });
  const response = await app.inject('/library/titles');
  assert.equal(response.statusCode, 200);
  const { items, pagination } = response.json();
  assert.equal(pagination.totalItems, 1);
  assert.equal(items.length, 1);
  const [title] = items;
  assert.equal(title.id, uuid(1));
  assert.equal(title.name, 'Alpha VN');
  assert.equal(title.sourceAvailable, true);
  assert.equal(title.archiveItems.length, 1);
  assert.equal(title.archiveItems[0].directoryName, 'Dir a');
  assert.equal(title.archiveItems[0].game.id, gid(101));
  assert.equal(title.archiveItems[0].game.favorite, false);
});

test('pagination bounds, defaults, and maximum page size are enforced', async (t) => {
  const { app } = await fixture(t, {
    titles: Array.from({ length: 12 }, (_, i) => mkTitle(i + 1, `Title ${String(i + 1).padStart(2, '0')}`, [mkItem(`i${i}`)])),
  });

  const first = await app.inject('/library/titles?pageSize=5');
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().items.length, 5);
  assert.deepEqual(first.json().pagination, { page: 1, pageSize: 5, totalItems: 12, totalPages: 3 });

  const last = await app.inject('/library/titles?page=3&pageSize=5');
  assert.equal(last.json().items.length, 2);
  assert.equal(last.json().pagination.totalPages, 3);

  const beyond = await app.inject('/library/titles?page=4&pageSize=5');
  assert.equal(beyond.statusCode, 200);
  assert.deepEqual(beyond.json().items, []);

  const max = await app.inject('/library/titles?pageSize=100');
  assert.equal(max.statusCode, 200);
  assert.equal(max.json().pagination.pageSize, 100);

  for (const query of ['page=0', 'page=-1', 'page=abc', 'pageSize=0', 'pageSize=101', 'pageSize=abc']) {
    const response = await app.inject(`/library/titles?${query}`);
    assert.equal(response.statusCode, 400, query);
    assert.equal(response.json().error.code, query.startsWith('pageSize') ? 'INVALID_PAGE_SIZE' : 'INVALID_PAGE');
  }
});

test('search covers Title.name, ArchiveItem.directoryName, Game.extractedTitle and Game.vndbTitle', async (t) => {
  const { app } = await fixture(t, {
    titles: [
      mkTitle(1, 'Name Match', [mkItem('a', { game: mkGame(1) })]),
      mkTitle(2, 'Plain', [mkItem('needle-dir', { game: mkGame(2) })]),
      mkTitle(3, 'Plain', [mkItem('c', { game: mkGame(3, { extractedTitle: 'needle game' }) })]),
      mkTitle(4, 'Plain', [mkItem('d', { game: mkGame(4, { vndbTitle: 'needle vndb' }) })]),
      mkTitle(5, 'No Match', [mkItem('e', { game: mkGame(5) })]),
    ],
  });

  const byName = await app.inject('/library/titles?search=Name');
  assert.deepEqual(byName.json().items.map((title) => title.id), [uuid(1)]);

  const byDir = await app.inject('/library/titles?search=needle-dir');
  assert.deepEqual(byDir.json().items.map((title) => title.id), [uuid(2)]);

  const byExtracted = await app.inject('/library/titles?search=needle game');
  assert.deepEqual(byExtracted.json().items.map((title) => title.id), [uuid(3)]);

  const byVndb = await app.inject('/library/titles?search=NEEDLE VNDB');
  assert.deepEqual(byVndb.json().items.map((title) => title.id), [uuid(4)]);
});

test('sort supports name asc/desc with deterministic secondary ordering', async (t) => {
  const { app } = await fixture(t, {
    titles: [
      mkTitle(3, 'Same', [mkItem('c')]), mkTitle(1, 'Same', [mkItem('a')]),
      mkTitle(2, 'Alpha', [mkItem('b')]),
    ],
  });

  const asc = await app.inject('/library/titles?sort=name&order=asc');
  assert.deepEqual(asc.json().items.map((title) => title.id), [uuid(2), uuid(1), uuid(3)]);

  const desc = await app.inject('/library/titles?sort=name&order=desc');
  assert.deepEqual(desc.json().items.map((title) => title.id), [uuid(1), uuid(3), uuid(2)]);

  const invalidSort = await app.inject('/library/titles?sort=title');
  assert.equal(invalidSort.statusCode, 400);
  assert.equal(invalidSort.json().error.code, 'INVALID_SORT');
  const invalidOrder = await app.inject('/library/titles?order=sideways');
  assert.equal(invalidOrder.statusCode, 400);
  assert.equal(invalidOrder.json().error.code, 'INVALID_ORDER');
});

test('sourceAvailable filter uses the Title-level aggregate', async (t) => {
  const { app } = await fixture(t, {
    titles: [
      mkTitle(1, 'Available', [mkItem('a', { game: mkGame(1) })]),
      mkTitle(2, 'Missing', [mkItem('b', { available: false, game: mkGame(2) })]),
      mkTitle(3, 'Mixed', [mkItem('c', { available: true }), mkItem('d', { available: false })]),
      mkTitle(4, 'No Items', []),
    ],
  });

  const available = await app.inject('/library/titles?sourceAvailable=true');
  assert.deepEqual(available.json().items.map((title) => title.name).sort(), ['Available', 'Mixed']);

  const unavailable = await app.inject('/library/titles?sourceAvailable=false');
  assert.deepEqual(unavailable.json().items.map((title) => title.name).sort(), ['Missing', 'No Items']);

  const invalid = await app.inject('/library/titles?sourceAvailable=yes');
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, 'INVALID_SOURCE_AVAILABLE');
});

test('one Title with multiple ArchiveItems keeps both with no implicit primary', async (t) => {
  const { app } = await fixture(t, {
    titles: [mkTitle(1, 'Two Releases', [
      mkItem('a', { available: true, game: mkGame(11) }),
      mkItem('b', { available: false, game: mkGame(12) }),
    ])],
  });

  const detail = await app.inject(`/library/titles/${uuid(1)}`);
  assert.equal(detail.statusCode, 200);
  const title = detail.json();
  assert.equal(title.sourceAvailable, true);
  assert.deepEqual(title.archiveItems.map((item) => item.id), ['item-a', 'item-b']);
  assert.deepEqual(title.archiveItems.map((item) => item.game.id), [gid(11), gid(12)]);

  const available = await app.inject('/library/titles?sourceAvailable=true');
  assert.deepEqual(available.json().items.map((t2) => t2.id), [uuid(1)]);
  const unavailable = await app.inject('/library/titles?sourceAvailable=false');
  assert.deepEqual(unavailable.json().items, []);

  // Both items unavailable -> the false filter must now include it.
  const { app: app2 } = await fixture(t, {
    titles: [mkTitle(1, 'Two Releases', [
      mkItem('a', { available: false, game: mkGame(11) }),
      mkItem('b', { available: false, game: mkGame(12) }),
    ])],
  });
  const nowFalse = await app2.inject('/library/titles?sourceAvailable=false');
  assert.deepEqual(nowFalse.json().items.map((t2) => t2.id), [uuid(1)]);
  assert.equal(nowFalse.json().items[0].sourceAvailable, false);
});

test('an ArchiveItem without a compatibility Game serializes with game:null', async (t) => {
  const { app } = await fixture(t, { titles: [mkTitle(1, 'No Game', [mkItem('a')])] });
  const response = await app.inject(`/library/titles/${uuid(1)}`);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().archiveItems[0].game, null);
});

test('detail endpoint validates UUIDs and 404s unknown titles', async (t) => {
  const { app } = await fixture(t, { titles: [mkTitle(1, 'Existing', [mkItem('a')])] });

  const ok = await app.inject(`/library/titles/${uuid(1)}`);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().name, 'Existing');

  const malformed = await app.inject('/library/titles/not-a-uuid');
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().error.code, 'INVALID_TITLE_ID');

  const legacyStyle = await app.inject(`/library/titles/${'a'.repeat(32)}`);
  assert.equal(legacyStyle.statusCode, 400);

  const unknown = await app.inject(`/library/titles/${uuid(9)}`);
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().error.code, 'TITLE_NOT_FOUND');
});

test('tags and screenshots are parsed like the legacy library API', async (t) => {
  const { app } = await fixture(t, {
    titles: [mkTitle(1, 'JSON', [mkItem('a', { game: mkGame(1, { tags: '[{"id":"t","name":"Tag"}]', screenshots: '["img.jpg"]' }) })])],
  });
  const response = await app.inject(`/library/titles/${uuid(1)}`);
  const nested = response.json().archiveItems[0].game;
  assert.deepEqual(nested.tags, [{ id: 't', name: 'Tag' }]);
  assert.deepEqual(nested.screenshots, ['img.jpg']);
});

test('nested Game favorite state reuses the requesting user\'s favorites', async (t) => {
  const { app } = await fixture(t, {
    titles: [mkTitle(1, 'Fav', [mkItem('a', { game: mkGame(1) })]), mkTitle(2, 'Not Fav', [mkItem('b', { game: mkGame(2) })])],
    favorites: [{ userId: 'user', gameId: gid(1) }],
  });
  const response = await app.inject('/library/titles');
  const byName = Object.fromEntries(response.json().items.map((title) => [title.name, title]));
  assert.equal(byName.Fav.archiveItems[0].game.favorite, true);
  assert.equal(byName['Not Fav'].archiveItems[0].game.favorite, false);
});

test('legacy GET /library and /library/:gameId stay Game-centric and unchanged', async (t) => {
  const legacyGame = { ...mkGame(1, { extractedTitle: 'Legacy', hidden: false, tags: '["t"]', screenshots: '["s.jpg"]' }) };
  const { app } = await fixture(t, { games: [legacyGame], favorites: [{ userId: 'user', gameId: gid(1) }] });

  const list = await app.inject('/library');
  assert.equal(list.statusCode, 200);
  const [listed] = list.json();
  assert.equal(listed.id, gid(1));
  assert.equal(listed.extractedTitle, 'Legacy');
  assert.equal(listed.favorite, true);
  assert.equal('archiveItems' in listed, false);
  assert.deepEqual(listed.tags, ['t']);

  const detail = await app.inject(`/library/${gid(1)}`);
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().id, gid(1));
  assert.equal(detail.json().favorite, true);
  assert.equal('archiveItems' in detail.json(), false);
});
