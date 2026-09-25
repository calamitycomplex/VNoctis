import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readdir, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadEntityCover, removeEntityCover } from './coverDownloader.js';
import { downloadEntityScreenshots, removeEntityScreenshots } from './screenshotDownloader.js';

const uuid = '11111111-2222-3333-4444-555555555555';
const gid = 'a'.repeat(32);

async function tempRoot(t, label) {
  const root = await mkdtemp(join(tmpdir(), `vnm-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function withFetch(t, body = 'img') {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, statusText: 'OK', arrayBuffer: async () => Buffer.from(body) });
  t.after(() => { globalThis.fetch = original; });
}

test('A. Title cover downloads to /covers/titles/<uuid>.jpg', async (t) => {
  const root = await tempRoot(t, 'cover-title');
  withFetch(t);
  const result = await downloadEntityCover({ entityType: 'title', entityId: uuid, imageUrl: 'https://img/c.jpg', rootPath: root });
  assert.equal(result, `/covers/titles/${uuid}.jpg`);
  assert.deepEqual(await readdir(join(root, 'titles')), [`${uuid}.jpg`]);
});

test('B. Title screenshots download to /screenshots/titles/<uuid>/<i>.jpg', async (t) => {
  const root = await tempRoot(t, 'shots-title');
  withFetch(t);
  const result = await downloadEntityScreenshots({
    entityType: 'title', entityId: uuid, urls: ['https://img/0.jpg', 'https://img/1.jpg'], rootPath: root,
  });
  assert.deepEqual(result, [`/screenshots/titles/${uuid}/0.jpg`, `/screenshots/titles/${uuid}/1.jpg`]);
  assert.deepEqual(await readdir(join(root, 'titles', uuid)), ['0.jpg', '1.jpg']);
});

test('Game downloads keep the legacy layout', async (t) => {
  const root = await tempRoot(t, 'cover-game');
  withFetch(t);
  assert.equal(await downloadEntityCover({ entityType: 'game', entityId: gid, imageUrl: 'https://img/c.jpg', rootPath: root }), `/covers/${gid}.jpg`);
  assert.deepEqual(await downloadEntityScreenshots({ entityType: 'game', entityId: gid, urls: ['https://img/0.jpg'], rootPath: root }), [`/screenshots/${gid}/0.jpg`]);
});

test('L. invalid or traversal entity ids are rejected without creating paths', async (t) => {
  const root = await tempRoot(t, 'invalid');
  withFetch(t);
  assert.equal(await downloadEntityCover({ entityType: 'title', entityId: '../escape', imageUrl: 'https://img/c.jpg', rootPath: root }), null);
  assert.equal(await downloadEntityCover({ entityType: 'title', entityId: 'not-a-uuid', imageUrl: 'https://img/c.jpg', rootPath: root }), null);
  assert.deepEqual(await downloadEntityScreenshots({ entityType: 'title', entityId: '..', urls: ['https://img/0.jpg'], rootPath: root }), []);
  assert.deepEqual(await readdir(root), []);
});

test('K. removing one Title media never touches a sibling Title', async (t) => {
  const root = await tempRoot(t, 'sibling');
  const other = '22222222-2222-3333-4444-555555555555';
  await mkdir(join(root, 'titles', uuid), { recursive: true });
  await mkdir(join(root, 'titles', other), { recursive: true });
  await writeFile(join(root, 'titles', `${uuid}.jpg`), 'cover');
  await writeFile(join(root, 'titles', `${other}.jpg`), 'cover');
  await writeFile(join(root, 'titles', uuid, '0.jpg'), 'shot');

  await removeEntityCover({ entityType: 'title', entityId: uuid, rootPath: root });
  await removeEntityScreenshots({ entityType: 'title', entityId: uuid, rootPath: root });

  await assert.rejects(access(join(root, 'titles', `${uuid}.jpg`)));
  await assert.rejects(access(join(root, 'titles', uuid)));
  assert.equal((await readdir(join(root, 'titles'))).sort().join(','), `${other},${other}.jpg`);
});

test('downloadEntityCover skips an existing file (idempotent)', async (t) => {
  const root = await tempRoot(t, 'skip');
  await mkdir(join(root, 'titles'), { recursive: true });
  await writeFile(join(root, 'titles', `${uuid}.jpg`), 'existing');
  withFetch(t, 'new');
  const result = await downloadEntityCover({ entityType: 'title', entityId: uuid, imageUrl: 'https://img/c.jpg', rootPath: root });
  assert.equal(result, `/covers/titles/${uuid}.jpg`);
});
