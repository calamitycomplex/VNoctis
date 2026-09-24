import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backfillArchiveCatalog } from './backfill-archive-catalog.js';

const game = () => ({
  id: 'a'.repeat(32), archiveItemId: null,
  directoryPath: '/read-only/Exact Folder', directoryName: 'Exact Folder', sourceAvailable: false,
  createdAt: new Date('2020-01-01'), updatedAt: new Date('2021-01-01'),
  vndbId: 'v17', tags: '[]', screenshots: '["cached"]', coverPath: '/covers/legacy.jpg',
  buildStatus: 'built', publishStatus: 'published', favorite: true,
});

// Transactions operate on a copy and commit only on success. Missing methods fail
// tests if the utility starts accessing favorites, jobs, or unrelated models.
function fixture({ mapped = false, failUpdate = false } = {}) {
  let state = { games: [game()], titles: [], items: [] };
  if (mapped) {
    state.games[0].archiveItemId = 'item';
    state.titles.push({ id: 'title' });
    state.items.push({ ...game(), id: 'item', titleId: 'title' });
  }
  const writes = [];
  const select = (row, fields) => !row ? null : !fields ? { ...row }
    : Object.fromEntries(Object.keys(fields).map((key) => [key, row[key]]));
  const prisma = {
    game: { findMany: async () => state.games.map(({ id }) => ({ id })) },
    $transaction: async (fn) => {
      const draft = structuredClone(state);
      const result = await fn({
        game: {
          findUnique: async ({ where, select: fields }) => select(draft.games.find((g) => g.id === where.id), fields),
          update: async ({ where, data }) => {
            writes.push(['game.update', data]);
            if (failUpdate) throw new Error('Injected update failure');
            assert.deepEqual(Object.keys(data).sort(), ['archiveItemId', 'updatedAt']);
            Object.assign(draft.games.find((g) => g.id === where.id), data);
          },
        },
        title: {
          findUnique: async ({ where }) => draft.titles.find((t) => t.id === where.id) || null,
          create: async ({ data }) => {
            writes.push(['title.create', data]);
            const row = { ...data, id: `title-${draft.titles.length}` };
            draft.titles.push(row);
            return row;
          },
        },
        archiveItem: {
          findUnique: async ({ where }) => draft.items.find((item) =>
            Object.entries(where).every(([key, value]) => item[key] === value)) || null,
          create: async ({ data }) => {
            writes.push(['archiveItem.create', data]);
            const row = { ...data, id: `item-${draft.items.length}` };
            draft.items.push(row);
            return row;
          },
        },
      });
      state = draft;
      return result;
    },
  };
  return { prisma, writes, get state() { return state; } };
}

async function run(f, apply = false) {
  const reports = [];
  const summary = await backfillArchiveCatalog(f.prisma, { apply, report: (row) => reports.push(row) });
  return { summary, reports };
}

test('dry-run is the default and writes nothing for an unmapped Game', async () => {
  const f = fixture();
  const before = structuredClone(f.state);
  assert.equal((await run(f)).summary.wouldMap, 1);
  assert.deepEqual(f.state, before);
  assert.deepEqual(f.writes, []);
});

test('maps exact source fields and preserves all existing Game values and timestamps; rerun skips', async () => {
  const f = fixture();
  const before = structuredClone(f.state.games[0]);
  assert.equal((await run(f, true)).summary.mapped, 1);
  assert.deepEqual(f.state.games[0], { ...before, archiveItemId: 'item-0' });
  assert.deepEqual(f.state.titles, [{ id: 'title-0', createdAt: before.createdAt, updatedAt: before.updatedAt }]);
  assert.deepEqual(f.state.items, [{
    id: 'item-0', titleId: 'title-0', directoryPath: before.directoryPath,
    directoryName: before.directoryName, sourceAvailable: false,
    createdAt: before.createdAt, updatedAt: before.updatedAt,
  }]);
  const after = structuredClone(f.state);
  assert.equal((await run(f, true)).summary.skipped, 1);
  assert.deepEqual(f.state, after);
  assert.equal(f.writes.length, 3);
});

test('already-mapped consistent Game is skipped without writes', async () => {
  const f = fixture({ mapped: true });
  assert.equal((await run(f, true)).summary.skipped, 1);
  assert.deepEqual(f.writes, []);
});

for (const field of ['directoryPath', 'directoryName', 'sourceAvailable']) {
  test(`reports inconsistent ${field} without repairing it`, async () => {
    const f = fixture({ mapped: true });
    f.state.items[0][field] = field === 'sourceAvailable' ? true : 'different';
    const { summary, reports } = await run(f, true);
    assert.equal(summary.errors, 1);
    assert.equal(reports[0].code, 'INCONSISTENT_MAPPING');
    assert.deepEqual(f.writes, []);
  });
}

for (const [collection, code] of [['items', 'ARCHIVE_ITEM_MISSING'], ['titles', 'TITLE_MISSING']]) {
  test(`reports ${code}`, async () => {
    const f = fixture({ mapped: true });
    f.state[collection].length = 0;
    assert.equal((await run(f, true)).reports[0].code, code);
    assert.deepEqual(f.writes, []);
  });
}

test('unmapped Game with occupied path is a conflict, not adopted or merged', async () => {
  const f = fixture({ mapped: true });
  f.state.games[0].archiveItemId = null;
  for (const apply of [false, true]) {
    assert.equal((await run(f, apply)).reports[0].code, 'DIRECTORY_PATH_CONFLICT');
  }
  assert.deepEqual(f.writes, []);
});

test('failed Game update rolls back new Title and ArchiveItem', async () => {
  const f = fixture({ failUpdate: true });
  const before = structuredClone(f.state);
  assert.equal((await run(f, true)).summary.errors, 1);
  assert.deepEqual(f.state, before);
});
