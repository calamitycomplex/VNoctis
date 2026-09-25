import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join, resolve } from 'node:path';
import {
  coverMediaPaths,
  isContained,
  isValidEntityId,
  screenshotDirPath,
  screenshotMediaPaths,
} from './mediaPaths.js';

const uuid = '11111111-2222-3333-4444-555555555555';
const gid = 'a'.repeat(32);

test('isValidEntityId accepts UUID Titles and legacy Game ids, rejects traversal', () => {
  assert.equal(isValidEntityId('title', uuid), true);
  assert.equal(isValidEntityId('title', 'not-a-uuid'), false);
  assert.equal(isValidEntityId('title', '../etc/passwd'), false);
  assert.equal(isValidEntityId('game', gid), true);
  assert.equal(isValidEntityId('game', '..'), false);
  assert.equal(isValidEntityId('game', 'a/b'), false);
  assert.equal(isValidEntityId('game', ''), false);
  assert.equal(isValidEntityId('title', 42), false);
});

test('title cover/screenshot paths live under the titles/ segment with matching URLs', () => {
  const cover = coverMediaPaths('/covers', 'title', uuid);
  assert.equal(cover.filePath, join('/covers', 'titles', `${uuid}.jpg`));
  assert.equal(cover.urlPath, `/covers/titles/${uuid}.jpg`);

  const shotDir = screenshotDirPath('/screenshots', 'title', uuid);
  assert.equal(shotDir, join('/screenshots', 'titles', uuid));

  const shot = screenshotMediaPaths('/screenshots', 'title', uuid, 3);
  assert.equal(shot.filePath, join('/screenshots', 'titles', uuid, '3.jpg'));
  assert.equal(shot.urlPath, `/screenshots/titles/${uuid}/3.jpg`);
});

test('game paths keep the legacy layout', () => {
  const cover = coverMediaPaths('/covers', 'game', gid);
  assert.equal(cover.filePath, join('/covers', `${gid}.jpg`));
  assert.equal(cover.urlPath, `/covers/${gid}.jpg`);

  const shot = screenshotMediaPaths('/screenshots', 'game', gid, 0);
  assert.equal(shot.filePath, join('/screenshots', gid, '0.jpg'));
  assert.equal(shot.urlPath, `/screenshots/${gid}/0.jpg`);
});

test('isContained rejects paths outside the media root', () => {
  const root = '/app/media';
  assert.equal(isContained(root, join(root, 'titles', `${uuid}.jpg`)), true);
  assert.equal(isContained(root, root), true);
  assert.equal(isContained(root, resolve(root, '../escape.jpg')), false);
  assert.equal(isContained(root, join(root, 'titles', '..', '..', 'escape.jpg')), false);
});
