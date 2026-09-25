import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import metadataRoutes from './metadata.js';
import libraryRoutes from './library.js';

const uuid = '11111111-2222-3333-4444-555555555555';

const game = (id, overrides = {}) => ({
  id, directoryPath: `/games/${id}`, directoryName: id, extractedTitle: `Game ${id}`,
  sourceAvailable: true, buildStatus: 'not_built', hidden: false, metadataSource: 'auto',
  vndbId: null, steamAppId: null, vndbTitle: null, synopsis: null, developer: null,
  releaseDate: null, lengthMinutes: null, vndbRating: null, coverPath: null,
  tags: '[]', screenshots: '[]', metadataFetchedAt: null, archiveItemId: null,
  ...overrides,
});

const item = (id, g) => ({ id, directoryName: `Dir ${id}`, directoryPath: `/games/${id}`, sourceAvailable: true, game: g });

const title = (overrides = {}) => ({
  id: uuid, name: 'Canonical VN', metadataSource: 'unmatched', metadataFetchedAt: null,
  vndbId: null, vndbTitle: null, vndbTitleOriginal: null, synopsis: null, developer: null,
  releaseDate: null, lengthMinutes: null, vndbRating: null, coverPath: null,
  tags: '[]', screenshots: '[]', createdAt: new Date('2020-01-01'), updatedAt: new Date('2021-01-01'),
  archiveItems: [], ...overrides,
});

const VN = {
  id: 'v17', title: 'Canonical VN', alttitle: '原題', description: 'A description.',
  developers: [{ name: 'Studio' }], released: '2020-03-04', length_minutes: 300, rating: 85,
  tags: [{ name: 'Tag', spoiler: 0 }], screenshots: [{ url: 'https://img/1.jpg' }],
  image: { url: 'https://img/cover.jpg' },
};

const vndb = { matchThreshold: 0.7, async searchByTitle() { return [VN]; }, async getById() { return VN; } };
const steam = { async getAppDetails() { return null; } };

function fixture({ titles = [], games = [] } = {}) {
  const state = { titles, games, favorites: [] };

  /** Raw stored Game object (mutations must land here). */
  const rawGame = (id) => {
    for (const t of state.titles) for (const it of t.archiveItems) if (it.game?.id === id) return it.game;
    for (const g of state.games) if (g.id === id) return g;
    return null;
  };

  /** Game view with its ArchiveItem/Title relations attached. */
  const gameView = (id) => {
    const g = rawGame(id);
    if (!g) return null;
    for (const t of state.titles) {
      for (const it of t.archiveItems) {
        if (it.game?.id === id) return { ...g, archiveItem: { id: it.id, title: t } };
      }
    }
    return { ...g, archiveItem: null };
  };

  const findTitle = (rows, id) => rows.find((t) => t.id === id) || null;
  const draftGame = (rows, id) => {
    for (const t of rows) for (const it of t.archiveItems) if (it.game?.id === id) return it.game;
    return null;
  };

  const txFor = (rows) => ({
    title: {
      update: async ({ where, data }) => { const t = findTitle(rows, where.id); Object.assign(t, data); return t; },
    },
    game: {
      update: async ({ where, data }) => { const g = draftGame(rows, where.id); Object.assign(g, data); return g; },
    },
  });

  const prisma = {
    title: {
      findUnique: async ({ where }) => findTitle(state.titles, where.id),
      update: async ({ where, data }) => { const t = findTitle(state.titles, where.id); Object.assign(t, data); return t; },
    },
    game: {
      findUnique: async ({ where }) => gameView(where.id),
      findMany: async ({ where } = {}) => {
        const titleId = where?.archiveItem?.titleId;
        if (titleId) {
          const t = findTitle(state.titles, titleId);
          return (t?.archiveItems ?? []).map((it) => it.game).filter(Boolean);
        }
        return state.games;
      },
      update: async ({ where, data }) => { const g = rawGame(where.id); Object.assign(g, data); return g; },
    },
    userFavorite: { findMany: async () => [] },
    $transaction: async (fn) => {
      const draft = structuredClone(state.titles);
      const result = await fn(txFor(draft));
      state.titles = draft;
      return result;
    },
  };

  const app = Fastify();
  app.decorate('prisma', prisma);
  app.decorate('vndbClient', vndb);
  app.decorate('steamClient', steam);
  app.decorate('coversPath', null);
  app.decorate('screenshotsPath', null);
  app.addHook('onRequest', async (request) => { request.user = { userId: 'user' }; });
  return { app, state, prisma };
}

async function appFor(t, opts) {
  const { app, state } = fixture(opts);
  await app.register(libraryRoutes);
  await app.register(metadataRoutes, { prefix: '/api/v1' });
  t.after(() => app.close());
  return { app, state };
}

test('GET/PATCH: Title manual edit updates Title and mirrors logical fields to all Games', async (t) => {
  const a = game('a'.repeat(32));
  const b = game('b'.repeat(32));
  const { app, state } = await appFor(t, { titles: [title({ archiveItems: [item('i1', a), item('i2', b)] })], games: [a, b] });

  const res = await app.inject({
    method: 'PATCH', url: `/library/titles/${uuid}`,
    payload: { vndbTitle: 'Edited', synopsis: 'Edited syn', name: 'Renamed', hidden: true },
  });
  assert.equal(res.statusCode, 200);
  const t1 = state.titles[0];
  assert.equal(t1.vndbTitle, 'Edited');
  assert.equal(t1.synopsis, 'Edited syn');
  assert.equal(t1.name, 'Renamed');
  assert.equal(t1.metadataSource, 'manual');
  assert.equal(t1.hidden, undefined); // hidden is not a Title field
  assert.equal(t1.archiveItems[0].game.vndbTitle, 'Edited');
  assert.equal(t1.archiveItems[1].game.vndbTitle, 'Edited');
  assert.equal(t1.archiveItems[0].game.name, undefined);
});

test('PATCH: Title manual edit rejects malformed UUID and unknown Title', async (t) => {
  const { app } = await appFor(t, { titles: [title()] });
  assert.equal((await app.inject({ method: 'PATCH', url: '/library/titles/not-a-uuid', payload: { name: 'x' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: '/library/titles/00000000-0000-4000-8000-000000000000', payload: { name: 'x' } })).statusCode, 404);
});

test('Title refresh endpoint refreshes Title once and mirrors to sibling Games', async (t) => {
  const a = game('a'.repeat(32));
  const b = game('b'.repeat(32));
  const { app, state } = await appFor(t, { titles: [title({ archiveItems: [item('i1', a), item('i2', b)] })], games: [a, b] });

  const res = await app.inject({ method: 'POST', url: `/api/v1/metadata/titles/${uuid}/refresh`, payload: {} });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.id, uuid);
  assert.equal(body.vndbId, 'v17');
  assert.equal(state.titles[0].archiveItems[0].game.vndbId, 'v17');
  assert.equal(state.titles[0].archiveItems[1].game.vndbId, 'v17');
});

test('Title refresh endpoint rejects malformed UUID and unknown Title', async (t) => {
  const { app } = await appFor(t, { titles: [title()] });
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/metadata/titles/nope/refresh', payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/metadata/titles/00000000-0000-4000-8000-000000000000/refresh', payload: {} })).statusCode, 404);
});

test('Legacy Game refresh bridges to Title and mirrors siblings, returning the Game', async (t) => {
  const a = game('a'.repeat(32, 'a'));
  const b = game('b'.repeat(32));
  a.archiveItemId = 'i1';
  const { app, state } = await appFor(t, {
    titles: [title({ archiveItems: [item('i1', a), item('i2', b)] })],
    games: [a, b],
  });

  const res = await app.inject({ method: 'POST', url: `/api/v1/metadata/${a.id}/refresh`, payload: {} });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().id, a.id);
  assert.equal(state.titles[0].vndbId, 'v17');
  assert.equal(state.titles[0].archiveItems[0].game.vndbId, 'v17');
  assert.equal(state.titles[0].archiveItems[1].game.vndbId, 'v17');
});

test('Legacy Game refresh falls back to Game-only for an unmapped Game', async (t) => {
  const orphan = game('c'.repeat(32), { extractedTitle: 'Canonical VN' });
  const { app, state } = await appFor(t, { titles: [], games: [orphan] });

  const res = await app.inject({ method: 'POST', url: `/api/v1/metadata/${orphan.id}/refresh`, payload: {} });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().vndbId, 'v17');
  assert.equal(state.games[0].vndbId, 'v17');
});

test('Legacy Game PATCH bridges logical edits to Title but keeps hidden Game-only', async (t) => {
  const a = game('a'.repeat(32));
  const b = game('b'.repeat(32));
  a.archiveItemId = 'i1';
  const { app, state } = await appFor(t, {
    titles: [title({ archiveItems: [item('i1', a), item('i2', b)] })],
    games: [a, b],
  });

  const res = await app.inject({
    method: 'PATCH', url: `/library/${a.id}`,
    payload: { vndbTitle: 'From Game PATCH', hidden: true },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().hidden, true);
  assert.equal(state.titles[0].vndbTitle, 'From Game PATCH');
  assert.equal(state.titles[0].metadataSource, 'manual');
  assert.equal(state.titles[0].archiveItems[0].game.vndbTitle, 'From Game PATCH');
  assert.equal(state.titles[0].archiveItems[1].game.vndbTitle, 'From Game PATCH');
  assert.equal(state.titles[0].archiveItems[0].game.hidden, true);
});

test('Legacy Game PATCH falls back to Game-only for an unmapped Game', async (t) => {
  const orphan = game('d'.repeat(32));
  const { app, state } = await appFor(t, { titles: [], games: [orphan] });

  const res = await app.inject({ method: 'PATCH', url: `/library/${orphan.id}`, payload: { vndbTitle: 'Orphan Edit' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().vndbTitle, 'Orphan Edit');
  assert.equal(state.games[0].vndbTitle, 'Orphan Edit');
  assert.equal(state.games[0].metadataSource, 'manual');
});
