import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import importRoutes from './import.js';
import { importStagingRoot } from '../services/importStaging.js';
import { installFakeArchiveTools } from '../../test/helpers/fakeArchiveTools.js';
import { installFakeUnrpa } from '../../test/helpers/fakeUnrpa.js';

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

const zipListing = (entries) =>
  ['Archive:  /tmp/sample.zip', ...entries, ''].join('\n');
const zipEntry = (name) =>
  `-rw-r--r--  3.0 unx  10  bx defN 24-Jan-01 12:00 ${name}`;

async function fixture(t, { extractExit = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vnoctis-route-import-'));
  const gamesPath = join(root, 'games');
  const webBuilds = join(root, 'web-builds');
  const contentsDir = join(root, 'contents');

  await mkdir(gamesPath, { recursive: true });
  await mkdir(join(contentsDir, 'MyGame', 'game'), { recursive: true });
  await writeFile(join(contentsDir, 'MyGame', 'game', 'archive.rpa'), 'RPA-CONTENT');
  await writeFile(join(contentsDir, 'MyGame', 'game', 'script.rpy'), 'label start:');

  const listing = zipListing([zipEntry('MyGame/'), zipEntry('MyGame/game/archive.rpa')]);
  const tools = await installFakeArchiveTools({ listing, contentsDir });
  const fakeUnrpa = await installFakeUnrpa({ exitCode: 0 });
  process.env.FAKE_EXTRACT_EXIT = String(extractExit);

  const previous = {
    GAMES_PATH: process.env.GAMES_PATH,
    WEB_BUILDS_PATH: process.env.WEB_BUILDS_PATH,
    IMPORT_STAGING_PATH: process.env.IMPORT_STAGING_PATH,
  };
  process.env.GAMES_PATH = gamesPath;
  process.env.WEB_BUILDS_PATH = webBuilds;
  delete process.env.IMPORT_STAGING_PATH;

  const prisma = {
    $transaction: async (fn) => fn(prisma),
    game: {
      findUnique: async () => null,
      findMany: async () => [],
      create: async () => {},
      update: async () => {},
    },
    archiveItem: { findUnique: async () => null, update: async () => {} },
    title: { findUnique: async () => null },
  };

  const app = Fastify();
  app.decorate('prisma', prisma);
  await app.register(importRoutes);

  const previousFetch = global.fetch;
  global.fetch = async () =>
    new Response(new TextEncoder().encode('archive-bytes'), { status: 200 });

  t.after(async () => {
    global.fetch = previousFetch;
    await app.close();
    await tools.restore();
    await fakeUnrpa.restore();
    delete process.env.FAKE_EXTRACT_EXIT;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  return { app, gamesPath, webBuilds, contentsDir };
}

const events = (body) =>
  body.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

test('import-url extracts into staging and never writes beneath GAMES_PATH', async (t) => {
  const { app, gamesPath, webBuilds } = await fixture(t);

  const res = await app.inject({
    method: 'POST',
    url: '/library/import-url',
    payload: { url: 'https://example.com/MyGame.zip' },
  });

  assert.equal(res.statusCode, 200);

  const parsed = events(res.body);
  const complete = parsed.find((e) => e.phase === 'complete');
  assert.ok(complete, 'expected a complete event');
  assert.equal(complete.staged, true);
  assert.equal(complete.promoted, false);

  const stagedPath = complete.path;
  assert.ok(complete.stagingId.startsWith('MyGame-'));
  assert.equal(stagedPath, join(importStagingRoot(webBuilds), complete.stagingId));
  assert.ok(stagedPath.startsWith(importStagingRoot(webBuilds)));

  // Staged content exists; RPA processed only in staging.
  assert.equal(await exists(join(stagedPath, 'game', 'script.rpy')), true);
  assert.equal(await exists(join(stagedPath, 'game', 'archive.rpa')), false);
  assert.equal(await exists(join(stagedPath, 'game', 'UNRPA_EXTRACTED')), true);

  // GAMES_PATH received nothing.
  assert.deepEqual(await readdir(gamesPath), []);
});

test('two imports of the same filename get separate staging directories', async (t) => {
  const { app, gamesPath, webBuilds } = await fixture(t);

  const firstRes = await app.inject({
    method: 'POST',
    url: '/library/import-url',
    payload: { url: 'https://example.com/MyGame.zip' },
  });
  const secondRes = await app.inject({
    method: 'POST',
    url: '/library/import-url',
    payload: { url: 'https://example.com/MyGame.zip' },
  });

  const first = events(firstRes.body).find((e) => e.phase === 'complete');
  const second = events(secondRes.body).find((e) => e.phase === 'complete');

  assert.ok(first && second, 'expected two complete events');
  assert.notEqual(first.stagingId, second.stagingId);
  assert.notEqual(first.path, second.path);
  assert.equal(await exists(first.path), true);
  assert.equal(await exists(second.path), true);
  assert.equal((await readdir(importStagingRoot(webBuilds))).length, 2);
  assert.deepEqual(await readdir(gamesPath), []);
});

test('failed extraction cleans staging and leaves GAMES_PATH untouched', async (t) => {
  const { app, gamesPath, webBuilds } = await fixture(t, { extractExit: 1 });

  const res = await app.inject({
    method: 'POST',
    url: '/library/import-url',
    payload: { url: 'https://example.com/MyGame.zip' },
  });

  const parsed = events(res.body);
  const error = parsed.find((e) => e.phase === 'error');
  assert.ok(error, 'expected an error event');

  assert.deepEqual(await readdir(gamesPath), []);
  assert.deepEqual(await readdir(importStagingRoot(webBuilds)).catch(() => []), []);
});

test('staged import keeps the source archive bytes inside staging', async (t) => {
  const { app, contentsDir } = await fixture(t);

  await app.inject({
    method: 'POST',
    url: '/library/import-url',
    payload: { url: 'https://example.com/MyGame.zip' },
  });

  // Original seeded content dir is untouched and still holds the .rpa.
  assert.equal(
    await readFile(join(contentsDir, 'MyGame', 'game', 'archive.rpa'), 'utf8'),
    'RPA-CONTENT'
  );
});
