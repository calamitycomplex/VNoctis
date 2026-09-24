import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import libraryRoutes from './library.js';

async function fixture(t) {
  const games = [true, false].map((sourceAvailable, i) => ({
    id: String(i).repeat(32), extractedTitle: `VN ${i}`, sourceAvailable,
    hidden: false, tags: '[]', screenshots: '["cached.jpg"]', buildStatus: 'built',
  }));
  const queries = [];
  const app = Fastify();
  app.decorate('prisma', {
    game: {
      findMany: async ({ where }) => {
        queries.push(where);
        return games.filter((game) => Object.entries(where).every(([key, value]) => game[key] === value));
      },
      findUnique: async ({ where }) => games.find((game) => game.id === where.id),
    },
    userFavorite: {
      findMany: async () => [{ gameId: games[1].id }],
      findUnique: async () => ({ gameId: games[1].id }),
    },
  });
  app.addHook('onRequest', async (request) => { request.user = { userId: 'user' }; });
  await app.register(libraryRoutes);
  t.after(() => app.close());
  return { app, games, queries };
}

test('normal list and detail retain unavailable Game, metadata, and user favorite', async (t) => {
  const { app, games, queries } = await fixture(t);
  const list = await app.inject('/library');
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().length, 2);
  assert.equal(queries[0].sourceAvailable, undefined);
  const detail = await app.inject(`/library/${games[1].id}`);
  assert.equal(detail.statusCode, 200);
  assert.deepEqual(detail.json(), { ...games[1], tags: [], screenshots: ['cached.jpg'], favorite: true });
  assert.deepEqual(list.json()[1], detail.json());
});

for (const available of [true, false]) {
  test(`filters sourceAvailable=${available}`, async (t) => {
    const { app, queries } = await fixture(t);
    const response = await app.inject(`/library?sourceAvailable=${available}&buildStatus=built`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().length, 1);
    assert.equal(response.json()[0].sourceAvailable, available);
    assert.deepEqual(queries[0], { sourceAvailable: available, hidden: false, buildStatus: 'built' });
  });
}

for (const query of [
  'yes', '1', '', 'TRUE', 'false&sourceAvailable=true',
  'invalid&buildStatus=invalid',
  'invalid&metadataSource=invalid',
]) {
  test(`rejects invalid availability query: ${query}`, async (t) => {
    const { app, queries } = await fixture(t);
    const response = await app.inject(`/library?sourceAvailable=${query}`);
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_SOURCE_AVAILABLE');
    assert.equal(queries.length, 0);
  });
}
