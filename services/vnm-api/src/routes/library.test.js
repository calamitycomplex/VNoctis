import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { mkdtemp, mkdir, rm, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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


test('DELETE removes the compatibility Game but retains its ArchiveItem and Title', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vnoctis-delete-'));
  const previousWebBuilds = process.env.WEB_BUILDS_PATH;
  t.after(async () => {
    if (previousWebBuilds === undefined) delete process.env.WEB_BUILDS_PATH;
    else process.env.WEB_BUILDS_PATH = previousWebBuilds;
    await rm(root, { recursive: true, force: true });
  });

  const webBuilds = join(root, 'web-builds');
  const covers = join(root, 'covers');
  const screenshots = join(root, 'screenshots');
  const titleId = '11111111-2222-3333-4444-555555555555';
  for (const path of [webBuilds, covers, screenshots, join(covers, 'titles'), join(screenshots, 'titles', titleId)]) {
    await mkdir(path, { recursive: true });
  }
  process.env.WEB_BUILDS_PATH = webBuilds;

  // Shared Title-owned media that a single Game deletion must not remove.
  const titleCover = join(covers, 'titles', `${titleId}.jpg`);
  const titleShot = join(screenshots, 'titles', titleId, '0.jpg');
  await writeFile(titleCover, 'title cover');
  await writeFile(titleShot, 'title shot');

  const gameId = 'a'.repeat(32);
  const state = {
    games: [{ id: gameId, directoryName: 'Fixture', extractedTitle: 'Fixture VN', archiveItemId: 'item-1' }],
    buildJobs: [{ id: 'job-1', gameId }],
    items: [{ id: 'item-1', titleId: 'title-1', directoryPath: '/games/Fixture', directoryName: 'Fixture', sourceAvailable: true }],
    titles: [{ id: 'title-1', name: 'Fixture VN' }],
  };

  const app = Fastify();
  app.decorate('prisma', {
    game: {
      findUnique: async ({ where }) => state.games.find((row) => row.id === where.id) || null,
      delete: async ({ where }) => {
        state.games.splice(state.games.findIndex((row) => row.id === where.id), 1);
      },
    },
    buildJob: {
      findMany: async ({ where }) => state.buildJobs.filter((job) => job.gameId === where.gameId),
      deleteMany: async ({ where }) => {
        state.buildJobs = state.buildJobs.filter((job) => job.gameId !== where.gameId);
      },
    },
    archiveItem: { findUnique: async ({ where }) => state.items.find((row) => row.id === where.id) || null },
    title: { findUnique: async ({ where }) => state.titles.find((row) => row.id === where.id) || null },
  });
  app.decorate('coversPath', covers);
  app.decorate('screenshotsPath', screenshots);
  app.addHook('onRequest', async (request) => { request.user = { userId: 'user' }; });
  await app.register(libraryRoutes);
  t.after(() => app.close());

  const response = await app.inject({ method: 'DELETE', url: `/library/${gameId}` });
  assert.equal(response.statusCode, 204);
  assert.equal(state.games.length, 0, 'Game row must be deleted');
  assert.equal(state.buildJobs.length, 0, 'BuildJob rows must be deleted');
  assert.equal(state.items.length, 1, 'ArchiveItem must survive Game deletion');
  assert.equal(state.titles.length, 1, 'Title must survive Game deletion');
  assert.equal(state.items[0].titleId, state.titles[0].id, 'Title/ArchiveItem relationship must stay intact');
  // Regression: Game deletion must not remove shared Title-owned media.
  assert.equal(await readFile(titleCover, 'utf8'), 'title cover', 'Title cover must survive Game deletion');
  assert.equal(await readFile(titleShot, 'utf8'), 'title shot', 'Title screenshots must survive Game deletion');
  await access(join(covers, 'titles'));
});
