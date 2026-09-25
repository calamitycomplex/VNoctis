import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  archiveItemsOf,
  displayTitleFor,
  hasRuntimeActions,
  isMultiRelease,
  logicalMetadataFor,
  pickCoverGame,
  singleGameFor,
} from './titleDisplay.js';

const item = (overrides = {}) => ({
  id: 'item-1', directoryName: 'Dir', directoryPath: '/games/Dir', sourceAvailable: true,
  game: null, ...overrides,
});
const title = (overrides = {}) => ({ id: 't1', name: 'Title Name', archiveItems: [item()], ...overrides });

test('singleGameFor returns the only nested Game, and null for multi-release titles', () => {
  const game = { id: 'g1' };
  assert.equal(singleGameFor(title({ archiveItems: [item({ game })] })).id, 'g1');
  assert.equal(singleGameFor(title({ archiveItems: [item({ game }), item({ id: 'item-2', game: { id: 'g2' } })] })), null);
  assert.equal(singleGameFor(title({ archiveItems: [] })), null);
});

test('displayTitleFor prefers Title metadata, then Title name, then single-Game fallback', () => {
  const game = { id: 'g1', vndbTitle: 'VNDB Name', extractedTitle: 'Extracted' };
  const meta = { vndbTitle: 'Metadata Name' };

  // Title.metadata wins.
  assert.equal(displayTitleFor(title({ metadata: meta, archiveItems: [item({ game })] })), 'Metadata Name');
  // Title.name wins when metadata is absent.
  assert.equal(displayTitleFor(title({ archiveItems: [item({ game })] })), 'Title Name');
  // Single-Game fallbacks apply only when Title name is null.
  assert.equal(displayTitleFor(title({ name: null, archiveItems: [item({ game })] })), 'VNDB Name');
  assert.equal(displayTitleFor(title({ name: null, archiveItems: [item({ game: { id: 'g1', extractedTitle: 'Extracted' } })] })), 'Extracted');
  assert.equal(displayTitleFor(title({ name: null, archiveItems: [item({ game: null })] })), 'Dir');
});

test('displayTitleFor prefers the Title name for multi-release titles (no metadata merging)', () => {
  const t = title({ archiveItems: [item({ game: { id: 'g1', vndbTitle: 'First Game Name' } }), item({ id: 'item-2', game: { id: 'g2' } })] });
  assert.equal(displayTitleFor(t), 'Title Name');
  assert.equal(displayTitleFor(title({ name: null, archiveItems: [item({ game: null }), item({ id: 'item-2', game: null })] })), 'Dir');
});

test('displayTitleFor lets multi-release Title metadata lead without merging Games', () => {
  const t = title({
    metadata: { vndbTitle: 'Shared Metadata' },
    archiveItems: [item({ game: { id: 'g1', vndbTitle: 'Game A' } }), item({ id: 'item-2', game: { id: 'g2', vndbTitle: 'Game B' } })],
  });
  assert.equal(displayTitleFor(t), 'Shared Metadata');
});

test('logicalMetadataFor prefers Title.metadata and falls back to the single Game', () => {
  const game = { id: 'g1', vndbRating: 7, developer: 'Game Dev', synopsis: 'Game synopsis', tags: ['g'], screenshots: ['g.jpg'], coverPath: '/covers/g.jpg' };
  const meta = { vndbRating: 9, developer: 'Title Dev', synopsis: 'Title synopsis', tags: ['t'], screenshots: ['t.jpg'], coverPath: '/covers/title.jpg' };

  const withMeta = logicalMetadataFor(title({ metadata: meta, archiveItems: [item({ game })] }));
  assert.equal(withMeta.vndbRating, 9);
  assert.equal(withMeta.developer, 'Title Dev');
  assert.equal(withMeta.synopsis, 'Title synopsis');
  assert.deepEqual(withMeta.tags, ['t']);
  assert.equal(withMeta.coverPath, '/covers/title.jpg');

  const fallback = logicalMetadataFor(title({ archiveItems: [item({ game })] }));
  assert.equal(fallback.vndbRating, 7);
  assert.equal(fallback.developer, 'Game Dev');
  assert.deepEqual(fallback.tags, ['g']);

  // No implicit primary for multi-release: nested Games must not be merged in.
  const multi = logicalMetadataFor(title({
    archiveItems: [item({ game: { id: 'g1', developer: 'Game A' } }), item({ id: 'item-2', game: { id: 'g2', developer: 'Game B' } })],
  }));
  assert.equal(multi.developer, null);
});

test('pickCoverGame returns a Game only when exactly one item has a cover', () => {
  const withCover = { id: 'g1', coverPath: '/covers/a.jpg' };
  assert.equal(pickCoverGame(title({ archiveItems: [item({ game: withCover })] })).id, 'g1');
  assert.equal(pickCoverGame(title({ archiveItems: [item({ game: withCover }), item({ id: 'item-2', game: { id: 'g2' } })] })).id, 'g1');
  assert.equal(pickCoverGame(title({ archiveItems: [item({ game: withCover }), item({ id: 'item-2', game: { id: 'g2', coverPath: '/covers/b.jpg' } })] })), null);
  assert.equal(pickCoverGame(title({ archiveItems: [item({ game: { id: 'g1' } })] })), null);
});

test('isMultiRelease/hasRuntimeActions describe safe action availability', () => {
  assert.equal(isMultiRelease(title()), false);
  assert.equal(isMultiRelease(title({ archiveItems: [item(), item({ id: 'item-2' })] })), true);
  assert.equal(hasRuntimeActions(title({ archiveItems: [item({ game: { id: 'g1' } })] })), true);
  assert.equal(hasRuntimeActions(title({ archiveItems: [item({ game: null })] })), false);
  assert.equal(hasRuntimeActions(title({ archiveItems: [item({ game: { id: 'g1' } }), item({ id: 'item-2', game: { id: 'g2' } })] })), false);
});

test('archiveItemsOf is null-safe', () => {
  assert.deepEqual(archiveItemsOf(null), []);
  assert.deepEqual(displayTitleFor(null), 'Unknown');
});
