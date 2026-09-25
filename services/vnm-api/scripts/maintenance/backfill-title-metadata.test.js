import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backfillTitleMetadata } from './backfill-title-metadata.js';

const gid = (n) => String(n).padStart(32, '0');
const tid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

function mkGame(n, overrides = {}) {
  return {
    id: gid(n),
    vndbId: null,
    vndbTitle: null,
    vndbTitleOriginal: null,
    synopsis: null,
    developer: null,
    releaseDate: null,
    lengthMinutes: null,
    vndbRating: null,
    coverPath: null,
    tags: '[]',
    screenshots: '[]',
    metadataSource: 'unmatched',
    metadataFetchedAt: null,
    ...overrides,
  };
}

function mkItem(id, game) {
  return { id: `item-${id}`, directoryName: `Dir ${id}`, game };
}

function mkTitle(n, archiveItems, overrides = {}) {
  return {
    id: tid(n),
    name: `Title ${n}`,
    vndbId: null,
    vndbTitle: null,
    vndbTitleOriginal: null,
    synopsis: null,
    developer: null,
    releaseDate: null,
    lengthMinutes: null,
    vndbRating: null,
    coverPath: null,
    tags: '[]',
    screenshots: '[]',
    metadataSource: 'unmatched',
    metadataFetchedAt: null,
    archiveItems,
    ...overrides,
  };
}

/**
 * In-memory Prisma stand-in. Transactions operate on a clone and commit only on
 * success; missing models/methods fail tests if the utility touches them.
 */
function fixture(titles) {
  const state = { titles: structuredClone(titles) };
  const writes = [];
  const prisma = {
    title: {
      findMany: async () => state.titles.map(({ id }) => ({ id })),
    },
    $transaction: async (fn) => {
      const draft = structuredClone(state);
      const result = await fn({
        title: {
          findUnique: async ({ where }) => draft.titles.find((t) => t.id === where.id) || null,
          update: async ({ where, data }) => {
            const row = draft.titles.find((t) => t.id === where.id);
            writes.push({ titleId: where.id, data: structuredClone(data) });
            Object.assign(row, data);
            return row;
          },
        },
      });
      state.titles = draft.titles;
      return result;
    },
  };
  return { prisma, state, writes };
}

const fieldOf = (data, field) => data[field];

test('A. single Game logical fields are adopted', async () => {
  const { prisma, state, writes } = fixture([
    mkTitle(1, [mkItem('a', mkGame(11, {
      vndbId: 'v17', vndbTitle: 'VN', vndbTitleOriginal: 'VN JP', synopsis: 'Syn',
      developer: 'Dev', lengthMinutes: 120, vndbRating: 8.5, coverPath: '/covers/legacy.jpg',
      tags: '[{"name":"Tag"}]', screenshots: '["shot.jpg"]', metadataSource: 'auto',
      metadataFetchedAt: new Date('2024-01-01T00:00:00Z'),
    }))]),
  ]);

  const summary = await backfillTitleMetadata(prisma, { apply: true });
  const data = writes[0].data;
  assert.equal(data.vndbId, 'v17');
  assert.equal(data.vndbTitle, 'VN');
  assert.equal(data.vndbTitleOriginal, 'VN JP');
  assert.equal(data.synopsis, 'Syn');
  assert.equal(data.developer, 'Dev');
  assert.equal(data.lengthMinutes, 120);
  assert.equal(data.vndbRating, 8.5);
  assert.equal(data.coverPath, '/covers/legacy.jpg');
  assert.deepEqual(JSON.parse(data.tags), [{ name: 'Tag' }]);
  assert.deepEqual(JSON.parse(data.screenshots), ['shot.jpg']);
  assert.equal(data.metadataSource, 'auto');
  assert.ok(data.metadataFetchedAt instanceof Date);
  assert.equal(summary.titlesUpdated, 1);
  assert.equal(state.titles[0].vndbId, 'v17');
});

test('B. Title with no contributing Game metadata performs no writes', async () => {
  const { prisma, writes } = fixture([mkTitle(1, [mkItem('a', mkGame(11))])]);
  const summary = await backfillTitleMetadata(prisma, { apply: true });
  assert.equal(writes.length, 0);
  assert.equal(summary.titlesWithoutMetadata, 1);
});

test('Title with no ArchiveItem/Game is counted as no metadata', async () => {
  const { prisma, writes } = fixture([mkTitle(1, [])]);
  const summary = await backfillTitleMetadata(prisma, { apply: true });
  assert.equal(writes.length, 0);
  assert.equal(summary.titlesWithoutMetadata, 1);
});

test('C. already-populated Title fields are preserved', async () => {
  const { prisma, writes } = fixture([
    mkTitle(1, [mkItem('a', mkGame(11, { vndbId: 'v17', vndbTitle: 'New', synopsis: 'NewSyn' }))], {
      vndbId: 'v17', vndbTitle: 'Existing', synopsis: 'ExistingSyn', metadataSource: 'manual',
    }),
  ]);
  const summary = await backfillTitleMetadata(prisma, { apply: true });
  assert.equal(writes.length, 0);
  assert.equal(summary.titlesSkipped, 1);
  assert.equal(summary.fieldsPopulated, 0);
});

test('D. multiple Games with identical metadata adopt once', async () => {
  const shared = { vndbId: 'v17', vndbTitle: 'Shared', synopsis: 'Same', metadataSource: 'auto' };
  const { prisma, writes } = fixture([
    mkTitle(1, [mkItem('a', mkGame(11, shared)), mkItem('b', mkGame(12, shared))]),
  ]);
  const summary = await backfillTitleMetadata(prisma, { apply: true });
  assert.deepEqual(writes[0].data.vndbTitle, 'Shared');
  assert.equal(summary.conflicts, 0);
});

test('E. partial metadata adopts only non-conflicting values', async () => {
  const { prisma, writes } = fixture([
    mkTitle(1, [
      mkItem('a', mkGame(11, { vndbId: 'v17', vndbTitle: 'A', metadataSource: 'auto' })),
      mkItem('b', mkGame(12, { vndbId: 'v17', synopsis: 'B syn', metadataSource: 'auto' })),
    ]),
  ]);
  const summary = await backfillTitleMetadata(prisma, { apply: true });
  const data = writes[0].data;
  assert.equal(data.vndbTitle, 'A');
  assert.equal(data.synopsis, 'B syn');
  assert.equal(summary.conflicts, 0);
});

test('F. differing vndbId is a hard conflict and blocks logical consolidation', async () => {
  const { prisma, writes } = fixture([
    mkTitle(1, [
      mkItem('a', mkGame(11, { vndbId: 'v17', vndbTitle: 'A', metadataSource: 'auto' })),
      mkItem('b', mkGame(12, { vndbId: 'v18', vndbTitle: 'B', metadataSource: 'manual' })),
    ]),
  ]);
  const summary = await backfillTitleMetadata(prisma, { apply: true });
  assert.equal(writes.length, 0);
  assert.equal(summary.conflicts, 1);
  assert.equal(summary.titlesSkipped, 1);
});

test('G. existing Title.vndbId conflicting with a Game is reported and Title unchanged', async () => {
  const { prisma, writes } = fixture([
    mkTitle(1, [mkItem('a', mkGame(11, { vndbId: 'v99', vndbTitle: 'Other' }))], { vndbId: 'v17' }),
  ]);
  const summary = await backfillTitleMetadata(prisma, { apply: true });
  assert.equal(writes.length, 0);
  assert.equal(summary.conflicts, 1);
});

test('G2. zero or one non-null vndbId behaves correctly', async () => {
  const none = fixture([mkTitle(1, [mkItem('a', mkGame(11, { vndbTitle: 'NoId', metadataSource: 'auto' }))])]);
  await backfillTitleMetadata(none.prisma, { apply: true });
  assert.equal(none.writes[0].data.vndbId, undefined);
  assert.equal(none.writes[0].data.vndbTitle, 'NoId');

  const one = fixture([mkTitle(1, [mkItem('a', mkGame(11, { vndbId: 'v17' })), mkItem('b', mkGame(12, { vndbTitle: 'X', metadataSource: 'auto' }))])]);
  await backfillTitleMetadata(one.prisma, { apply: true });
  assert.equal(one.writes[0].data.vndbId, 'v17');
});

test('H. single manual Game takes per-field precedence over auto', async () => {
  const { prisma, writes } = fixture([
    mkTitle(1, [
      mkItem('a', mkGame(11, { vndbId: 'v17', vndbTitle: 'Auto Title', synopsis: 'Auto syn', metadataSource: 'auto' })),
      mkItem('b', mkGame(12, { vndbId: 'v17', vndbTitle: 'Manual Title', metadataSource: 'manual' })),
    ]),
  ]);
  const summary = await backfillTitleMetadata(prisma, { apply: true });
  const data = writes[0].data;
  assert.equal(data.vndbTitle, 'Manual Title');
  assert.equal(data.synopsis, 'Auto syn');
  assert.equal(data.metadataSource, 'manual');
  assert.equal(summary.conflicts, 0);
});

test('I. two manual Games disagreeing is a conflict', async () => {
  const { prisma, writes } = fixture([
    mkTitle(1, [
      mkItem('a', mkGame(11, { vndbId: 'v17', vndbTitle: 'M A', metadataSource: 'manual' })),
      mkItem('b', mkGame(12, { vndbId: 'v17', vndbTitle: 'M B', metadataSource: 'manual' })),
    ]),
  ]);
  const summary = await backfillTitleMetadata(prisma, { apply: true });
  assert.equal(writes[0].data.vndbTitle, undefined);
  assert.ok(summary.conflicts >= 1);
});

test('J. semantically identical tags/screenshots JSON is accepted', async () => {
  const { prisma, writes } = fixture([
    mkTitle(1, [
      mkItem('a', mkGame(11, { vndbId: 'v17', tags: '["a","b"]', screenshots: '["s1"]', metadataSource: 'auto' })),
      mkItem('b', mkGame(12, { vndbId: 'v17', tags: '["a", "b"]', screenshots: '["s1"]', metadataSource: 'auto' })),
    ]),
  ]);
  const summary = await backfillTitleMetadata(prisma, { apply: true });
  const data = writes[0].data;
  assert.deepEqual(JSON.parse(data.tags), ['a', 'b']);
  assert.deepEqual(JSON.parse(data.screenshots), ['s1']);
  assert.equal(summary.conflicts, 0);
});

test('K. malformed tags JSON is reported without crashing or fabricating []', async () => {
  const { prisma, writes } = fixture([
    mkTitle(1, [mkItem('a', mkGame(11, { vndbId: 'v17', tags: '{not json', metadataSource: 'auto' }))]),
  ]);
  const summary = await backfillTitleMetadata(prisma, { apply: true });
  assert.equal(writes[0].data.tags, undefined);
  assert.equal(summary.malformedValues, 1);
  assert.ok(summary.conflicts >= 1);
});

test('L. disagreeing coverPath leaves Title.coverPath unset', async () => {
  const { prisma, writes } = fixture([
    mkTitle(1, [
      mkItem('a', mkGame(11, { vndbId: 'v17', coverPath: '/covers/a.jpg', metadataSource: 'auto' })),
      mkItem('b', mkGame(12, { vndbId: 'v17', coverPath: '/covers/b.jpg', metadataSource: 'auto' })),
    ]),
  ]);
  const summary = await backfillTitleMetadata(prisma, { apply: true });
  assert.equal(writes[0].data.coverPath, undefined);
  assert.ok(summary.conflicts >= 1);
});

test('metadataFetchedAt: equal stamps adopted; differing same-source uses newest; mixed leaves NULL', async () => {
  const t1 = new Date('2024-01-01T00:00:00Z');
  const t2 = new Date('2024-02-01T00:00:00Z');

  const equal = fixture([mkTitle(1, [mkItem('a', mkGame(11, { vndbId: 'v17', vndbTitle: 'X', metadataSource: 'auto', metadataFetchedAt: t1 })), mkItem('b', mkGame(12, { vndbId: 'v17', metadataSource: 'auto', metadataFetchedAt: t1 }))])]);
  await backfillTitleMetadata(equal.prisma, { apply: true });
  assert.equal(equal.writes[0].data.metadataFetchedAt.getTime(), t1.getTime());

  const newest = fixture([mkTitle(1, [mkItem('a', mkGame(11, { vndbId: 'v17', vndbTitle: 'X', metadataSource: 'auto', metadataFetchedAt: t1 })), mkItem('b', mkGame(12, { vndbId: 'v17', metadataSource: 'auto', metadataFetchedAt: t2 }))])]);
  await backfillTitleMetadata(newest.prisma, { apply: true });
  assert.equal(newest.writes[0].data.metadataFetchedAt.getTime(), t2.getTime());

  const mixed = fixture([mkTitle(1, [mkItem('a', mkGame(11, { vndbId: 'v17', vndbTitle: 'X', metadataSource: 'auto', metadataFetchedAt: t1 })), mkItem('b', mkGame(12, { vndbId: 'v17', metadataSource: 'manual', metadataFetchedAt: t2 }))])]);
  await backfillTitleMetadata(mixed.prisma, { apply: true });
  assert.equal(mixed.writes[0].data.metadataFetchedAt, undefined);
});

test('M/N. dry-run performs zero writes; --apply writes expected values', async () => {
  const build = () => fixture([mkTitle(1, [mkItem('a', mkGame(11, { vndbId: 'v17', vndbTitle: 'X', metadataSource: 'auto' }))])]);

  const dry = build();
  const drySummary = await backfillTitleMetadata(dry.prisma, {});
  assert.equal(dry.writes.length, 0);
  assert.equal(dry.state.titles[0].vndbTitle, null);
  assert.equal(drySummary.titlesWouldUpdate, 1);

  const applied = build();
  const applySummary = await backfillTitleMetadata(applied.prisma, { apply: true });
  assert.equal(applied.writes.length, 1);
  assert.equal(applied.state.titles[0].vndbTitle, 'X');
  assert.equal(applySummary.titlesUpdated, 1);
});

test('O. second --apply run performs zero further changes', async () => {
  const { prisma, writes } = fixture([mkTitle(1, [mkItem('a', mkGame(11, { vndbId: 'v17', vndbTitle: 'X', metadataSource: 'auto', metadataFetchedAt: new Date('2024-01-01T00:00:00Z') }))])]);
  await backfillTitleMetadata(prisma, { apply: true });
  const firstCount = writes.length;
  const summary = await backfillTitleMetadata(prisma, { apply: true });
  assert.equal(writes.length, firstCount);
  assert.equal(summary.titlesSkipped, 1);
  assert.equal(summary.fieldsPopulated, 0);
});

test('P. Game rows are never modified', async () => {
  const { prisma, state } = fixture([mkTitle(1, [mkItem('a', mkGame(11, { vndbId: 'v17', vndbTitle: 'X', metadataSource: 'auto' }))])]);
  const before = structuredClone(state.titles[0].archiveItems[0].game);
  await backfillTitleMetadata(prisma, { apply: true });
  assert.deepEqual(state.titles[0].archiveItems[0].game, before);
});

test('does not modify Title.name', async () => {
  const { prisma, state } = fixture([mkTitle(1, [mkItem('a', mkGame(11, { vndbId: 'v17', vndbTitle: 'X' }))])]);
  await backfillTitleMetadata(prisma, { apply: true });
  assert.equal(state.titles[0].name, 'Title 1');
});

test('no meaningful metadata leaves metadataSource at default', async () => {
  const { prisma, writes } = fixture([mkTitle(1, [mkItem('a', mkGame(11, { vndbId: 'v17' }))])]);
  await backfillTitleMetadata(prisma, { apply: true });
  assert.equal(writes[0].data.metadataSource, 'auto');
});

test('conflict reports carry per-contributor archiveItemId/gameId context', async () => {
  const { prisma } = fixture([
    mkTitle(1, [
      mkItem('a', mkGame(11, { vndbId: 'v17', vndbTitle: 'A', metadataSource: 'auto' })),
      mkItem('b', mkGame(12, { vndbId: 'v18', vndbTitle: 'B', metadataSource: 'manual' })),
    ]),
  ]);
  const events = [];
  await backfillTitleMetadata(prisma, { apply: true, report: (e) => events.push(e) });
  const conflict = events.find((e) => e.type === 'conflict' && e.field === 'vndbId');
  assert.ok(conflict);
  assert.equal(conflict.contributors.length, 2);
  assert.deepEqual(conflict.contributors.map((c) => c.archiveItemId).sort(), ['item-a', 'item-b']);
  assert.deepEqual(conflict.contributors.map((c) => c.gameId).sort(), [gid(11), gid(12)]);
});
