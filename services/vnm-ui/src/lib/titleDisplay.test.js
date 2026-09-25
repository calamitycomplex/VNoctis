import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  archiveItemsOf,
  cardFactsFor,
  cardTagsFor,
  coverUrlFor,
  displayTitleFor,
  formatLengthMinutes,
  originalTitleFor,
  hasRuntimeActions,
  isMultiRelease,
  logicalMetadataFor,
  pickCoverGame,
  screenshotUrlsFor,
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

test('coverUrlFor prefers Title metadata and never picks a primary Game for multi-release', () => {
  const meta = { coverUrl: '/api/v1/covers/titles/t1' };
  assert.equal(coverUrlFor(title({ metadata: meta, archiveItems: [item({ game: { id: 'g1', coverPath: '/covers/g.jpg' } })] })), '/api/v1/covers/titles/t1');

  // Falls back to a single legacy Game URL for older payloads.
  assert.equal(coverUrlFor(title({ archiveItems: [item({ game: { id: 'g1', coverPath: '/covers/g.jpg' } })] })), '/api/v1/covers/g1');
  assert.equal(coverUrlFor(title({ archiveItems: [item({ game: { id: 'g1' } })] })), null);

  // Two distinct legacy covers: no implicit primary.
  const multi = title({ archiveItems: [item({ game: { id: 'g1', coverPath: '/covers/a.jpg' } }), item({ id: 'item-2', game: { id: 'g2', coverPath: '/covers/b.jpg' } })] });
  assert.equal(coverUrlFor(multi), null);
  assert.equal(coverUrlFor(null), null);
});

test('screenshotUrlsFor prefers Title screenshot URLs and falls back to one Game set', () => {
  const meta = { screenshotUrls: ['/screenshots/titles/t1/0.jpg'] };
  assert.deepEqual(screenshotUrlsFor(title({ metadata: meta, archiveItems: [item({ game: { id: 'g1', screenshots: ['/screenshots/g1/0.jpg'] } })] })), ['/screenshots/titles/t1/0.jpg']);
  assert.deepEqual(screenshotUrlsFor(title({ archiveItems: [item({ game: { id: 'g1', screenshots: ['/screenshots/g1/0.jpg'] } })] })), ['/screenshots/g1/0.jpg']);
  const multi = title({ archiveItems: [item({ game: { id: 'g1', screenshots: ['a.jpg'] } }), item({ id: 'item-2', game: { id: 'g2', screenshots: ['b.jpg'] } })] });
  assert.deepEqual(screenshotUrlsFor(multi), []);
  assert.deepEqual(screenshotUrlsFor(null), []);
});

test('originalTitleFor returns a distinct original title, omits equal/empty values', () => {
  const t = title({ name: 'Canonical', metadata: { vndbTitle: 'Canonical', vndbTitleOriginal: '原題' } });
  assert.equal(originalTitleFor(t), '原題');

  // Identical to the primary display title -> omitted.
  assert.equal(originalTitleFor(title({ name: 'Same', metadata: { vndbTitle: 'Same', vndbTitleOriginal: 'same' } })), null);
  // Empty / whitespace -> omitted.
  assert.equal(originalTitleFor(title({ metadata: { vndbTitleOriginal: '   ' } })), null);
  assert.equal(originalTitleFor(title({ metadata: {} })), null);

  // Single-Game compatibility fallback only.
  const withGame = title({ name: 'Canonical', archiveItems: [item({ game: { id: 'g1', vndbTitleOriginal: '原題' } })] });
  assert.equal(originalTitleFor(withGame), '原題');

  // Multi-release Titles do not borrow one Game's original title.
  const multi = title({
    name: 'Canonical',
    archiveItems: [item({ game: { id: 'g1', vndbTitleOriginal: 'A' } }), item({ id: 'item-2', game: { id: 'g2', vndbTitleOriginal: 'B' } })],
  });
  assert.equal(originalTitleFor(multi), null);
});

test('formatLengthMinutes formats short, whole-hour, and partial-hour values', () => {
  assert.equal(formatLengthMinutes(45), '45m');
  assert.equal(formatLengthMinutes(60), '1h');
  assert.equal(formatLengthMinutes(150), '2h 30m');
  assert.equal(formatLengthMinutes(0), null);
  assert.equal(formatLengthMinutes(null), null);
  assert.equal(formatLengthMinutes('nope'), null);
});

test('cardFactsFor derives rating/year/length from Title metadata with single-Game fallback', () => {
  const t = title({ metadata: { vndbRating: 8.4, releaseDate: '2021-03-04', lengthMinutes: 1080 } });
  assert.deepEqual(cardFactsFor(t), { rating: 8.4, year: '2021', length: '18h' });

  // Partial / plain year strings still resolve.
  assert.equal(cardFactsFor(title({ metadata: { releaseDate: '2024' } })).year, '2024');
  assert.equal(cardFactsFor(title({ metadata: { releaseDate: 'not-a-date' } })).year, null);

  // Single-Game compatibility fallback.
  const withGame = title({ archiveItems: [item({ game: { id: 'g1', vndbRating: 7, releaseDate: '2015-01-01', lengthMinutes: 120 } })] });
  assert.deepEqual(cardFactsFor(withGame), { rating: 7, year: '2015', length: '2h' });

  // Missing fields are omitted (null), not placeholders.
  assert.deepEqual(cardFactsFor(title({})), { rating: null, year: null, length: null });

  // Multi-release Titles never borrow one Game's facts.
  const multi = title({
    archiveItems: [item({ game: { id: 'g1', vndbRating: 9 } }), item({ id: 'item-2', game: { id: 'g2', vndbRating: 5 } })],
  });
  assert.equal(cardFactsFor(multi).rating, null);
});

test('cardTagsFor returns non-spoiler tag names, capped at 3, Title metadata first', () => {
  const t = title({ metadata: { tags: [{ name: 'A' }, { name: 'B', spoiler: 1 }, { name: 'C' }, { name: 'D' }] } });
  assert.deepEqual(cardTagsFor(t), ['A', 'C', 'D']);

  const limited = cardTagsFor(title({ metadata: { tags: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }] } }), 2);
  assert.deepEqual(limited, ['A', 'B']);

  // Empty / malformed input is safe.
  assert.deepEqual(cardTagsFor(title({})), []);
  assert.deepEqual(cardTagsFor(title({ metadata: { tags: 'not-an-array' } })), []);
  assert.deepEqual(cardTagsFor(title({ metadata: { tags: [{ spoiler: 0 }, { name: '  ' }] } })), []);

  // Single-Game compatibility fallback.
  const withGame = title({ archiveItems: [item({ game: { id: 'g1', tags: [{ name: 'GameTag' }] } })] });
  assert.deepEqual(cardTagsFor(withGame), ['GameTag']);

  // Title tags win over a Game fallback.
  const both = title({ metadata: { tags: [{ name: 'TitleTag' }] }, archiveItems: [item({ game: { id: 'g1', tags: [{ name: 'GameTag' }] } })] });
  assert.deepEqual(cardTagsFor(both), ['TitleTag']);

  // Multi-release Titles do not borrow a Game's tags.
  const multi = title({
    archiveItems: [item({ game: { id: 'g1', tags: [{ name: 'A' }] } }), item({ id: 'item-2', game: { id: 'g2', tags: [{ name: 'B' }] } })],
  });
  assert.deepEqual(cardTagsFor(multi), []);
});
