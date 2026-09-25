import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import coversRoutes from './covers.js';

const uuid = '11111111-2222-3333-4444-555555555555';
const gid = 'a'.repeat(32);

async function appFor(t, { titles = [], games = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vnm-covers-route-'));
  process.env.COVERS_PATH = root;
  const previous = process.env.COVERS_PATH;
  t.after(async () => {
    if (previous === undefined) delete process.env.COVERS_PATH;
    else process.env.COVERS_PATH = previous;
    await rm(root, { recursive: true, force: true });
  });

  const app = Fastify();
  app.decorate('prisma', {
    game: { findUnique: async ({ where }) => games.find((g) => g.id === where.id) || null },
    title: { findUnique: async ({ where }) => titles.find((tt) => tt.id === where.id) || null },
  });
  await app.register(coversRoutes);
  t.after(() => app.close());
  return { app, root };
}

async function writeFileAt(root, relative, body = 'cover') {
  const full = join(root, relative);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, body);
}

const item = (game) => ({ game });

test('D. Title route serves a Title-owned cover', async (t) => {
  const { app, root } = await appFor(t, { titles: [{ id: uuid, coverPath: `titles/${uuid}.jpg`, archiveItems: [] }] });
  await writeFileAt(root, `titles/${uuid}.jpg`, 'title-cover');
  const res = await app.inject(`/covers/titles/${uuid}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/jpeg');
  assert.equal(res.body, 'title-cover');
});

test('E. Title route falls back to exactly one usable legacy Game cover', async (t) => {
  const { app, root } = await appFor(t, {
    titles: [{ id: uuid, coverPath: null, archiveItems: [item({ id: gid, coverPath: `${gid}.jpg` })] }],
  });
  await writeFileAt(root, `${gid}.jpg`, 'legacy-cover');
  const res = await app.inject(`/covers/titles/${uuid}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'legacy-cover');
});

test('F. ambiguous multi-Game legacy covers are not arbitrarily chosen', async (t) => {
  const g2 = 'b'.repeat(32);
  const { app, root } = await appFor(t, {
    titles: [{ id: uuid, coverPath: null, archiveItems: [item({ id: gid, coverPath: `${gid}.jpg` }), item({ id: g2, coverPath: `${g2}.jpg` })] }],
  });
  await writeFileAt(root, `${gid}.jpg`);
  await writeFileAt(root, `${g2}.jpg`);
  const res = await app.inject(`/covers/titles/${uuid}`);
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().code, 'COVER_NOT_FOUND');
});

test('F2. sibling Games sharing one legacy cover resolve without ambiguity', async (t) => {
  const g2 = 'b'.repeat(32);
  const { app, root } = await appFor(t, {
    titles: [{ id: uuid, coverPath: null, archiveItems: [item({ id: gid, coverPath: `${gid}.jpg` }), item({ id: g2, coverPath: `${gid}.jpg` })] }],
  });
  await writeFileAt(root, `${gid}.jpg`, 'shared');
  const res = await app.inject(`/covers/titles/${uuid}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'shared');
});

test('G. Title route rejects malformed id and unknown title', async (t) => {
  const { app } = await appFor(t, {});
  const bad = await app.inject('/covers/titles/not-a-uuid');
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().code, 'INVALID_TITLE_ID');
  const missing = await app.inject('/covers/titles/00000000-0000-4000-8000-000000000000');
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().code, 'TITLE_NOT_FOUND');
});

test('G2. Title route returns COVER_NOT_FOUND when nothing usable exists', async (t) => {
  const { app } = await appFor(t, { titles: [{ id: uuid, coverPath: null, archiveItems: [item({ id: gid, coverPath: `${gid}.jpg` })] }] });
  const res = await app.inject(`/covers/titles/${uuid}`);
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().code, 'COVER_NOT_FOUND');
});

test('O. legacy Game cover route is unchanged', async (t) => {
  const { app, root } = await appFor(t, { games: [{ id: gid, coverPath: `${gid}.jpg` }] });
  await writeFileAt(root, `${gid}.jpg`, 'game-cover');
  const ok = await app.inject(`/covers/${gid}`);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body, 'game-cover');
  assert.equal((await app.inject('/covers/short')).statusCode, 400);
  assert.equal((await app.inject(`/covers/${'b'.repeat(32)}`)).statusCode, 404);
});
