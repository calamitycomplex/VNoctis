import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  buildTitleWhere,
  parsePagination,
  serializeGame,
  serializeTitle,
  serializeTitleMetadata,
} from './titleCatalog.js';

const game = (overrides = {}) => ({
  id: 'g'.repeat(32), extractedTitle: 'Game Title', buildStatus: 'built', builtAt: null,
  webBuildPath: null, publishStatus: 'not_published', publishedAt: null, publishedVersion: null,
  hidden: false, metadataSource: 'auto', vndbId: 'v17', steamAppId: null,
  vndbTitle: 'VNDB Title', vndbTitleOriginal: '原題', synopsis: 'synopsis', developer: 'dev',
  releaseDate: null, lengthMinutes: null, vndbRating: null, coverPath: '/covers/x.jpg',
  tags: '[{"id":"t1","name":"Tag"}]', screenshots: '["https://img/1.jpg"]',
  ...overrides,
});

const item = (overrides = {}) => ({
  id: 'item-1', directoryName: 'Dir', directoryPath: '/games/Dir', sourceAvailable: true,
  game: game(), ...overrides,
});

const title = (overrides = {}) => ({
  id: '11111111-2222-3333-4444-555555555555', name: 'Logical Title',
  createdAt: new Date('2020-01-01'), updatedAt: new Date('2021-01-01'),
  archiveItems: [item()], ...overrides,
});

test('serializeTitle uses Title identity and aggregates availability from items', () => {
  const dto = serializeTitle(title());
  assert.equal(dto.id, '11111111-2222-3333-4444-555555555555');
  assert.equal(dto.name, 'Logical Title');
  assert.equal(dto.sourceAvailable, true);
  assert.equal(dto.archiveItems.length, 1);
  assert.equal(dto.archiveItems[0].directoryName, 'Dir');
  assert.equal(dto.archiveItems[0].game.id, 'g'.repeat(32));
  assert.deepEqual(Object.keys(dto).sort(), ['archiveItems', 'browserRuntime', 'createdAt', 'id', 'metadata', 'name', 'sourceAvailable', 'updatedAt']);
});

test('serializeTitle exposes ARCHIVE_ONLY by default with no runtime row or requests', () => {
  const dto = serializeTitle(title());
  assert.deepEqual(dto.browserRuntime, {
    state: 'ARCHIVE_ONLY',
    archiveItemId: null,
    note: null,
    createdAt: null,
    updatedAt: null,
    requestCount: 0,
    requestedByCurrentUser: false,
  });
});

test('serializeTitle exposes runtime state, selected release, and per-user request scope', () => {
  const runtime = {
    state: 'PREPARING',
    archiveItemId: 'item-2',
    note: 'using release B',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-02'),
  };
  const webRequests = [{ userId: 'user-a' }, { userId: 'user-b' }];

  const asRequester = serializeTitle(title({ browserRuntime: runtime, webRequests }), undefined, 'user-a');
  assert.equal(asRequester.browserRuntime.state, 'PREPARING');
  assert.equal(asRequester.browserRuntime.archiveItemId, 'item-2');
  assert.equal(asRequester.browserRuntime.requestCount, 2);
  assert.equal(asRequester.browserRuntime.requestedByCurrentUser, true);

  const asOther = serializeTitle(title({ browserRuntime: runtime, webRequests }), undefined, 'user-c');
  assert.equal(asOther.browserRuntime.requestCount, 2);
  assert.equal(asOther.browserRuntime.requestedByCurrentUser, false);

  // No caller identity (anonymous read) still sees a count, never identities.
  const anon = serializeTitle(title({ browserRuntime: { state: 'READY' }, webRequests }));
  assert.equal(anon.browserRuntime.state, 'READY');
  assert.equal(anon.browserRuntime.requestedByCurrentUser, false);
});

test('sourceAvailable stays independent of browser-runtime state', () => {
  const dto = serializeTitle(title({
    archiveItems: [item({ sourceAvailable: false })],
    browserRuntime: { state: 'READY' },
  }));
  assert.equal(dto.sourceAvailable, false);
  assert.equal(dto.browserRuntime.state, 'READY');
});

test('serializeTitle exposes an authoritative metadata block with parsed arrays', () => {
  const dto = serializeTitle(title({
    vndbId: 'v17',
    vndbTitle: 'VNDB Title',
    synopsis: 'A synopsis',
    developer: 'Dev',
    metadataSource: 'auto',
    coverPath: '/covers/title.jpg',
    tags: '[{"id":"t1","name":"Tag"}]',
    screenshots: '["https://img/1.jpg"]',
  }));
  assert.equal(dto.metadata.vndbId, 'v17');
  assert.equal(dto.metadata.vndbTitle, 'VNDB Title');
  assert.equal(dto.metadata.synopsis, 'A synopsis');
  assert.equal(dto.metadata.developer, 'Dev');
  assert.equal(dto.metadata.metadataSource, 'auto');
  assert.equal(dto.metadata.coverPath, '/covers/title.jpg');
  assert.deepEqual(dto.metadata.tags, [{ id: 't1', name: 'Tag' }]);
  assert.deepEqual(dto.metadata.screenshots, ['https://img/1.jpg']);
  assert.equal(dto.metadata.coverUrl, `/api/v1/covers/titles/${title().id}`);
  assert.deepEqual(dto.metadata.screenshotUrls, ['https://img/1.jpg']);
});

test('serializeTitleMetadata exposes a Title coverUrl from a single legacy Game cover', () => {
  const dto = serializeTitle(title());
  assert.equal(dto.metadata.coverUrl, `/api/v1/covers/titles/${title().id}`);
});

test('serializeTitleMetadata withholds coverUrl when legacy covers disagree', () => {
  const dto = serializeTitle(title({
    coverPath: null,
    archiveItems: [
      item({ game: game({ coverPath: '/covers/a.jpg' }) }),
      item({ id: 'item-2', game: game({ coverPath: '/covers/b.jpg' }) }),
    ],
  }));
  assert.equal(dto.metadata.coverUrl, null);
});

test('serializeTitleMetadata does not borrow multiple differing legacy screenshot sets', () => {
  const dto = serializeTitle(title({
    screenshots: '[]',
    archiveItems: [
      item({ game: game({ screenshots: '[\"a.jpg\"]' }) }),
      item({ id: 'item-2', game: game({ screenshots: '[\"b.jpg\"]' }) }),
    ],
  }));
  assert.deepEqual(dto.metadata.screenshotUrls, []);

  const shared = serializeTitle(title({
    screenshots: '[]',
    archiveItems: [
      item({ game: game({ screenshots: '[\"a.jpg\"]' }) }),
      item({ id: 'item-2', game: game({ screenshots: '[\"a.jpg\"]' }) }),
    ],
  }));
  assert.deepEqual(shared.metadata.screenshotUrls, ['a.jpg']);
});

test('serializeTitleMetadata fails safe on malformed JSON and defaults', () => {
  const meta = serializeTitleMetadata({ tags: 'not json', screenshots: 'not json' });
  assert.deepEqual(meta.tags, []);
  assert.deepEqual(meta.screenshots, []);
  assert.equal(meta.metadataSource, 'unmatched');
  assert.equal(meta.vndbId, null);
});

test('Title.sourceAvailable is true when at least one item is available and false only when none are', () => {
  const one = serializeTitle(title({ archiveItems: [item({ sourceAvailable: false }), item({ id: 'item-2' })] }));
  assert.equal(one.sourceAvailable, true);

  const none = serializeTitle(title({ archiveItems: [item({ sourceAvailable: false }), item({ id: 'item-2', sourceAvailable: false })] }));
  assert.equal(none.sourceAvailable, false);

  const empty = serializeTitle(title({ archiveItems: [] }));
  assert.equal(empty.sourceAvailable, false);
});

test('serializeTitle keeps every ArchiveItem with no implicit primary', () => {
  const dto = serializeTitle(title({ archiveItems: [item({ id: 'a' }), item({ id: 'b', game: null })] }));
  assert.deepEqual(dto.archiveItems.map((entry) => entry.id), ['a', 'b']);
  assert.equal(dto.archiveItems[0].game.id, 'g'.repeat(32));
  assert.equal(dto.archiveItems[1].game, null);
});

test('serializeGame parses tags/screenshots like the legacy library API', () => {
  const dto = serializeGame(game());
  assert.deepEqual(dto.tags, [{ id: 't1', name: 'Tag' }]);
  assert.deepEqual(dto.screenshots, ['https://img/1.jpg']);
  assert.equal(dto.favorite, false);

  assert.deepEqual(serializeGame(game({ tags: 'not json', screenshots: 'not json' })).tags, []);
  assert.deepEqual(serializeGame(game({ tags: 'not json', screenshots: 'not json' })).screenshots, []);
  assert.equal(serializeGame(null), null);
});

test('serializeGame marks favorites only for the supplied Game IDs', () => {
  const dto = serializeGame(game(), new Set(['g'.repeat(32)]));
  assert.equal(dto.favorite, true);
  assert.equal(serializeGame(game({ id: 'other' }), new Set(['g'.repeat(32)])).favorite, false);
});

test('parsePagination applies defaults and validates bounds', () => {
  assert.deepEqual(parsePagination({}), { page: 1, pageSize: DEFAULT_PAGE_SIZE });
  assert.deepEqual(parsePagination({ page: '3', pageSize: '25' }), { page: 3, pageSize: 25 });
  assert.deepEqual(parsePagination({ pageSize: String(MAX_PAGE_SIZE) }), { page: 1, pageSize: MAX_PAGE_SIZE });

  for (const bad of ['0', '-1', '1.5', 'abc', '', ['1', '2']]) {
    assert.equal(parsePagination({ page: bad }).error.code, 'INVALID_PAGE', `page=${JSON.stringify(bad)}`);
    assert.equal(parsePagination({ pageSize: bad }).error.code, 'INVALID_PAGE_SIZE', `pageSize=${JSON.stringify(bad)}`);
  }
  assert.equal(parsePagination({ pageSize: String(MAX_PAGE_SIZE + 1) }).error.code, 'INVALID_PAGE_SIZE');
});

test('buildTitleWhere maps sourceAvailable to any-available vs none-available', () => {
  assert.deepEqual(buildTitleWhere({ sourceAvailable: 'true' }), { archiveItems: { some: { sourceAvailable: true } } });
  assert.deepEqual(buildTitleWhere({ sourceAvailable: 'false' }), { archiveItems: { none: { sourceAvailable: true } } });
  assert.deepEqual(buildTitleWhere({}), {});
});

test('buildTitleWhere searches Title.name plus item and compatibility Game fields', () => {
  const where = buildTitleWhere({ search: 'abc' });
  assert.equal(where.OR.length, 4);
  assert.deepEqual(where.OR[0], { name: { contains: 'abc' } });
  assert.deepEqual(where.OR[1], { archiveItems: { some: { directoryName: { contains: 'abc' } } } });
  assert.deepEqual(where.OR[2], { archiveItems: { some: { game: { extractedTitle: { contains: 'abc' } } } } });
  assert.deepEqual(where.OR[3], { archiveItems: { some: { game: { vndbTitle: { contains: 'abc' } } } } });
});
