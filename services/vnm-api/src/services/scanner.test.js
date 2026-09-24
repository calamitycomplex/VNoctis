import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { scanGamesDirectory } from './scanner.js';

const fingerprint = (name) => createHash('sha256').update(name).digest('hex').slice(0, 32);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vnoctis-scanner-'));
  const source = join(root, 'source');
  await mkdir(source);
  const previous = {};
  for (const key of ['WEB_BUILDS_PATH', 'COVERS_PATH', 'SCREENSHOTS_PATH']) {
    previous[key] = process.env[key];
    process.env[key] = join(root, key);
    await mkdir(process.env[key]);
  }
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const state = { games: [], items: [], titles: [] };
  const warnings = [];
  const model = (rows) => ({
    findUnique: async ({ where }) => rows.find((row) => row.id === where.id) || null,
    findMany: async ({ where } = {}) => rows.filter((row) => !where || !where.id.notIn.includes(row.id)),
    create: async ({ data }) => { rows.push({ archiveItemId: null, buildStatus: 'not_built', ...data }); },
    update: async ({ where, data }) => {
      const row = rows.find((row) => row.id === where.id);
      assert.ok(row);
      Object.assign(row, data);
    },
  });
  const prisma = {
    game: model(state.games), archiveItem: model(state.items),
    title: { findUnique: async ({ where }) => state.titles.find((row) => row.id === where.id) || null },
    $transaction: async (fn) => {
      const before = structuredClone(state);
      try { return await fn(prisma); }
      catch (error) {
        for (const key of Object.keys(state)) state[key].splice(0, state[key].length, ...before[key]);
        throw error;
      }
    },
  };
  const seed = (name, available = true) => {
    const game = {
      id: fingerprint(name), directoryPath: join(source, name), directoryName: name,
      sourceAvailable: available, archiveItemId: 'item', metadataSource: 'manual',
      extractedTitle: 'Manual title', coverPath: '/cached.jpg', screenshots: '["cached"]',
      buildStatus: 'built', webBuildPath: '/web-builds/legacy', publishStatus: 'published',
    };
    state.games.push(game);
    state.items.push({ id: 'item', titleId: 'title', directoryPath: game.directoryPath, directoryName: name, sourceAvailable: available });
    state.titles.push({ id: 'title' });
    return game;
  };
  return { source, state, seed, warnings, prisma, scan: () => scanGamesDirectory(source, prisma, { info() {}, warn: (...args) => warnings.push(args) }) };
}

test('inventories arbitrary and empty directories, preserves RenPy title extraction, ignores files', async (t) => {
  const f = await fixture(t);
  for (const name of ['Other_Engine', 'Empty', 'RenPy']) await mkdir(join(f.source, name));
  await writeFile(join(f.source, 'Other_Engine', 'installer.exe'), 'fixture');
  await mkdir(join(f.source, 'RenPy', 'game'));
  await writeFile(join(f.source, 'RenPy', 'game', 'options.rpy'), 'define config.name = "Extracted VN"');
  await writeFile(join(f.source, 'loose.iso'), 'fixture');
  const result = await f.scan();
  assert.equal(result.found, 3);
  assert.equal(result.new, 3);
  assert.equal(f.state.games.find((g) => g.directoryName === 'Other_Engine').extractedTitle, 'Other Engine');
  assert.equal(f.state.games.find((g) => g.directoryName === 'RenPy').extractedTitle, 'Extracted VN');
  for (const game of f.state.games) {
    assert.equal(game.id, fingerprint(game.directoryName));
    assert.equal(game.sourceAvailable, true);
    assert.equal(game.archiveItemId, null);
  }
  assert.equal(f.state.items.length, 0);
  assert.equal(f.state.titles.length, 0);
});

test('mapped discovery updates source location and availability without altering metadata/runtime', async (t) => {
  const f = await fixture(t);
  const game = f.seed('Present', false);
  game.directoryPath = f.state.items[0].directoryPath = '/old-mount/Present';
  await mkdir(join(f.source, 'Present'));
  const before = { ...game };
  await f.scan();
  assert.deepEqual(game, { ...before, directoryPath: join(f.source, 'Present'), sourceAvailable: true });
  assert.equal(f.state.items[0].directoryPath, game.directoryPath);
  assert.equal(f.state.items[0].directoryName, game.directoryName);
  assert.equal(f.state.items[0].sourceAvailable, true);
});

test('missing mapped Game and ArchiveItem become unavailable, retained with cached data', async (t) => {
  const f = await fixture(t);
  const game = f.seed('Missing');
  const before = { ...game };
  assert.equal((await f.scan()).unavailable, 1);
  assert.deepEqual(game, { ...before, sourceAvailable: false });
  assert.equal(f.state.items[0].sourceAvailable, false);
  assert.equal(f.state.titles.length, 1);
  assert.equal((await f.scan()).unavailable, 1);
  assert.equal(f.warnings.length, 0);
});

for (const issue of ['missing item', 'missing title', 'inconsistent path']) {
  test(`reports ${issue} without repairing the catalog link`, async (t) => {
    const f = await fixture(t);
    f.seed('Present');
    await mkdir(join(f.source, 'Present'));
    if (issue === 'missing item') f.state.items.length = 0;
    if (issue === 'missing title') f.state.titles.length = 0;
    if (issue === 'inconsistent path') f.state.items[0].directoryPath = '/different';
    const before = structuredClone(f.state.items);
    await f.scan();
    assert.deepEqual(f.state.items, before);
    assert.equal(f.state.games[0].archiveItemId, 'item');
    assert.equal(f.warnings.length, 1);
    assert.match(f.warnings[0][1], /Missing or inconsistent archive mapping/);
  });
}

test('ZIP discovery never imports/extracts or changes existing build output or source bytes', async (t) => {
  const f = await fixture(t);
  const name = 'Zip VN';
  await mkdir(join(f.source, name));
  const zip = join(f.source, name, 'archive.zip');
  await writeFile(zip, 'not a valid ZIP: must never be extracted');
  const output = join(process.env.WEB_BUILDS_PATH, name);
  await mkdir(output);
  await writeFile(join(output, 'sentinel'), 'existing build');
  const result = await f.scan();
  assert.equal(result.imported, 0);
  assert.equal(f.state.games[0].buildStatus, 'not_built');
  assert.equal(await readFile(join(output, 'sentinel'), 'utf8'), 'existing build');
  assert.equal(await readFile(zip, 'utf8'), 'not a valid ZIP: must never be extracted');
  assert.deepEqual(await readdir(join(f.source, name)), ['archive.zip']);
  assert.equal(f.warnings.length, 0);
});

test('existing unmapped Game stays unmapped through disappearance and rediscovery', async (t) => {
  const f = await fixture(t);
  const game = f.seed('Unmapped');
  game.archiveItemId = null;
  f.state.items.length = 0;
  f.state.titles.length = 0;
  await f.scan();
  assert.equal(game.sourceAvailable, false);
  await mkdir(join(f.source, 'Unmapped'));
  await f.scan();
  assert.equal(game.sourceAvailable, true);
  assert.equal(game.archiveItemId, null);
  assert.equal(f.state.items.length, 0);
  assert.equal(f.state.titles.length, 0);
});

test('unavailable inconsistent mapping is reported and not silently repaired', async (t) => {
  const f = await fixture(t);
  const game = f.seed('Missing');
  f.state.items[0].directoryName = 'Different';
  await f.scan();
  assert.equal(game.sourceAvailable, false);
  assert.equal(f.state.items[0].sourceAvailable, true);
  assert.equal(f.warnings.length, 1);
});


test('inventory preserves orphaned generated artifacts and source-root files', async (t) => {
  const f = await fixture(t);
  const orphanId = 'f'.repeat(32);
  const build = join(process.env.WEB_BUILDS_PATH, 'orphan-build');
  const screenshots = join(process.env.SCREENSHOTS_PATH, orphanId);
  await mkdir(build);
  await mkdir(screenshots);
  const artifacts = [
    join(build, 'index.html'),
    join(process.env.WEB_BUILDS_PATH, 'orphan.zip'),
    join(process.env.COVERS_PATH, `${orphanId}.jpg`),
    join(screenshots, '0.jpg'),
    join(f.source, 'loose.iso'),
  ];
  for (const path of artifacts) await writeFile(path, `preserve ${path}`);
  const result = await f.scan();
  assert.equal(result.found, 0);
  assert.equal(result.orphansRemoved, 0);
  for (const path of artifacts) assert.equal(await readFile(path, 'utf8'), `preserve ${path}`);
  assert.equal(f.warnings.length, 0);
});

test('concurrent Game deletion is skipped and later unavailable mappings still synchronize', async (t) => {
  const f = await fixture(t);
  const survivor = f.seed('Survivor');
  const deletedId = fingerprint('Deleted');
  f.state.games.unshift({ ...survivor, id: deletedId, archiveItemId: null });
  const transaction = f.prisma.$transaction;
  let first = true;
  f.prisma.$transaction = async (fn) => {
    if (first) {
      first = false;
      // The unavailable ID list has already been collected; delete before its transaction.
      f.state.games.splice(f.state.games.findIndex((game) => game.id === deletedId), 1);
    }
    return transaction(fn);
  };
  const result = await f.scan();
  assert.equal(result.unavailable, 1);
  assert.equal(f.state.games.length, 1);
  assert.equal(f.state.games[0].id, survivor.id);
  assert.equal(survivor.sourceAvailable, false);
  assert.equal(f.state.items[0].sourceAvailable, false);
  assert.equal(f.state.titles.length, 1);
  assert.equal(f.warnings.length, 1);
  assert.equal(f.warnings[0][0].gameId, deletedId);
  assert.match(f.warnings[0][1], /Game deleted before unavailable processing; skipping/);
});
