import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  archiveItemsOf,
  displayTitleFor,
  hasRuntimeActions,
  isMultiRelease,
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

test('displayTitleFor keeps VNDB-first precedence for a single release', () => {
  const game = { id: 'g1', vndbTitle: 'VNDB Name', extractedTitle: 'Extracted' };
  assert.equal(displayTitleFor(title({ archiveItems: [item({ game })] })), 'VNDB Name');
  assert.equal(displayTitleFor(title({ archiveItems: [item({ game: { id: 'g1', extractedTitle: 'Extracted' } })] })), 'Title Name');
  assert.equal(displayTitleFor(title({ name: null, archiveItems: [item({ game: { id: 'g1', extractedTitle: 'Extracted' } })] })), 'Extracted');
  assert.equal(displayTitleFor(title({ name: null, archiveItems: [item({ game: null })] })), 'Dir');
});

test('displayTitleFor prefers the Title name for multi-release titles (no metadata merging)', () => {
  const t = title({ archiveItems: [item({ game: { id: 'g1', vndbTitle: 'First Game Name' } }), item({ id: 'item-2', game: { id: 'g2' } })] });
  assert.equal(displayTitleFor(t), 'Title Name');
  assert.equal(displayTitleFor(title({ name: null, archiveItems: [item({ game: null }), item({ id: 'item-2', game: null })] })), 'Dir');
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
