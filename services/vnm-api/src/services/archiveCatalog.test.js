import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureArchiveMapping, MAPPING_CONFLICT } from './archiveCatalog.js';

const baseGame = (overrides = {}) => ({
  id: 'game-1', archiveItemId: null,
  directoryPath: '/games/Fixture', directoryName: 'Fixture', sourceAvailable: true,
  extractedTitle: 'Fixture', createdAt: new Date('2020-01-01'), updatedAt: new Date('2021-01-01'),
  ...overrides,
});

/** Fake transaction client that only exposes the models the service may use. */
function makeTx({ game = baseGame(), item = null, title = null } = {}) {
  const state = {
    items: item ? [structuredClone(item)] : [],
    titles: title ? [structuredClone(title)] : [],
  };
  const writes = [];
  const tx = {
    archiveItem: {
      findUnique: async ({ where }) =>
        state.items.find((row) => row.id === where.id || row.directoryPath === where.directoryPath) || null,
      create: async ({ data }) => {
        const row = { id: 'item-0', ...data };
        state.items.push(row);
        writes.push(['item.create', data]);
        return row;
      },
      update: async ({ where, data }) => {
        const row = state.items.find((candidate) => candidate.id === where.id);
        Object.assign(row, data);
        writes.push(['item.update', data]);
        return row;
      },
    },
    title: {
      findUnique: async ({ where }) => state.titles.find((row) => row.id === where.id) || null,
      create: async ({ data }) => {
        const row = { id: 'title-0', ...data };
        state.titles.push(row);
        writes.push(['title.create', data]);
        return row;
      },
      update: async ({ where, data }) => {
        const row = state.titles.find((candidate) => candidate.id === where.id);
        Object.assign(row, data);
        writes.push(['title.update', data]);
        return row;
      },
    },
    game: {
      update: async ({ where, data }) => {
        writes.push(['game.update', data]);
        return { id: where.id, ...data };
      },
    },
  };
  return { tx, writes, state, game };
}

const mappedGame = (overrides = {}) => baseGame({ archiveItemId: 'item-0', ...overrides });
const mappedItem = (overrides = {}) => ({
  id: 'item-0', titleId: 'title-0', directoryPath: '/games/Fixture',
  directoryName: 'Fixture', sourceAvailable: true, ...overrides,
});

test('creates one Title and ArchiveItem and links the Game', async () => {
  const { tx, writes } = makeTx();
  const result = await ensureArchiveMapping(tx, baseGame(), { titleName: 'Display Name' });
  assert.equal(result.status, 'created');
  assert.equal(result.title.name, 'Display Name');
  assert.equal(result.item.directoryPath, '/games/Fixture');
  assert.equal(result.item.directoryName, 'Fixture');
  assert.equal(result.item.sourceAvailable, true);
  assert.equal(result.item.titleId, result.title.id);
  assert.deepEqual(writes.map(([kind]) => kind), ['title.create', 'item.create', 'game.update']);
  assert.deepEqual(writes[2][1], { archiveItemId: 'item-0' });
});

test('Title.name falls back to the directory name when no title is supplied', async () => {
  const { tx } = makeTx();
  const result = await ensureArchiveMapping(tx, baseGame(), {});
  assert.equal(result.title.name, 'Fixture');
});

test('preserves caller timestamps on created rows and the link update', async () => {
  const { tx, writes } = makeTx();
  const game = baseGame();
  await ensureArchiveMapping(tx, game, { timestamps: { createdAt: game.createdAt, updatedAt: game.updatedAt } });
  assert.equal(writes[0][1].createdAt, game.createdAt);
  assert.equal(writes[2][1].updatedAt, game.updatedAt);
});

test('a linked consistent mapping updates only the moved source fields', async () => {
  const { tx, writes, state } = makeTx({ game: mappedGame(), item: mappedItem(), title: { id: 'title-0', name: 'Existing' } });
  const result = await ensureArchiveMapping(tx, mappedGame(), {
    source: { directoryPath: '/games/Moved', directoryName: 'Moved' },
  });
  assert.equal(result.status, 'linked');
  assert.deepEqual(writes, [['item.update', { directoryPath: '/games/Moved', directoryName: 'Moved', sourceAvailable: true }]]);
  assert.equal(state.items[0].directoryPath, '/games/Moved');
});

test('a partial source change merges over the Game instead of clearing fields', async () => {
  const { tx, state } = makeTx({ game: mappedGame(), item: mappedItem(), title: { id: 'title-0', name: 'Existing' } });
  await ensureArchiveMapping(tx, mappedGame(), { source: { sourceAvailable: false } });
  assert.equal(state.items[0].sourceAvailable, false);
  assert.equal(state.items[0].directoryPath, '/games/Fixture');
});

test('fills a NULL Title.name once but never overwrites a non-null name', async () => {
  const { tx, state } = makeTx({ game: mappedGame(), item: mappedItem(), title: { id: 'title-0', name: null } });
  await ensureArchiveMapping(tx, mappedGame(), { titleName: 'Filled' });
  assert.equal(state.titles[0].name, 'Filled');

  const second = makeTx({ game: mappedGame(), item: mappedItem(), title: { id: 'title-0', name: 'Canonical' } });
  await ensureArchiveMapping(second.tx, mappedGame(), { titleName: 'Ignored' });
  assert.equal(second.state.titles[0].name, 'Canonical');
});

test('apply=false performs reads only', async () => {
  const un = makeTx();
  const result = await ensureArchiveMapping(un.tx, baseGame(), { apply: false, titleName: 'X' });
  assert.equal(result.status, 'would-create');
  assert.deepEqual(un.writes, []);

  const linked = makeTx({ game: mappedGame(), item: mappedItem(), title: { id: 'title-0', name: 'Existing' } });
  assert.equal((await ensureArchiveMapping(linked.tx, mappedGame(), { apply: false })).status, 'linked');
  assert.deepEqual(linked.writes, []);
});

test('reports each conflict without touching existing rows', async () => {
  const scenarios = [
    { name: MAPPING_CONFLICT.ARCHIVE_ITEM_MISSING, tx: makeTx({ game: mappedGame(), item: null, title: { id: 'title-0', name: 'x' } }) },
    { name: MAPPING_CONFLICT.TITLE_MISSING, tx: makeTx({ game: mappedGame(), item: mappedItem(), title: null }) },
    { name: MAPPING_CONFLICT.INCONSISTENT_MAPPING, tx: makeTx({ game: mappedGame(), item: mappedItem({ directoryName: 'Different' }), title: { id: 'title-0', name: 'x' } }) },
    { name: MAPPING_CONFLICT.DIRECTORY_PATH_CONFLICT, tx: makeTx({ item: mappedItem(), title: { id: 'title-0', name: 'x' } }) },
  ];
  for (const { name, tx } of scenarios) {
    const result = await ensureArchiveMapping(tx.tx, tx.game || baseGame(), { titleName: 'X' });
    assert.equal(result.status, 'conflict');
    assert.equal(result.code, name);
    assert.deepEqual(tx.writes, [], `${name} must not write`);
  }
});
