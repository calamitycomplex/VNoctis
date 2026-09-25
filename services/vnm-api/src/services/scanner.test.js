import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, readlink, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { scanGamesDirectory } from './scanner.js';

const fingerprint = (name) => createHash('sha256').update(name).digest('hex').slice(0, 32);

const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value);

/** Minimal in-memory Prisma stand-in; transactions commit on success, roll back on throw. */
function model(rows, defaults = {}, prefix = 'row') {
  let seq = 0;
  return {
    findUnique: async ({ where }) => rows.find((row) => matches(row, where)) || null,
    findMany: async ({ where } = {}) =>
      rows.filter((row) => !where?.id?.notIn || !where.id.notIn.includes(row.id)),
    create: async ({ data }) => {
      const row = { id: `${prefix}-${seq++}`, ...defaults, ...data };
      rows.push(row);
      return row;
    },
    update: async ({ where, data }) => {
      const row = rows.find((candidate) => matches(candidate, where));
      assert.ok(row, 'update target must exist');
      Object.assign(row, data);
      return row;
    },
  };
}

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
  const prisma = {
    game: model(state.games, { archiveItemId: null, buildStatus: 'not_built' }),
    archiveItem: model(state.items, {}, 'item'),
    title: model(state.titles, { name: null }, 'title'),
    $transaction: async (fn) => {
      const before = structuredClone(state);
      try { return await fn(prisma); }
      catch (error) {
        for (const key of Object.keys(state)) state[key].splice(0, state[key].length, ...structuredClone(before[key]));
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
    state.titles.push({ id: 'title', name: 'Seed Title' });
    return game;
  };
  return { root, source, state, seed, warnings, prisma, scan: () => scanGamesDirectory(source, prisma, { info() {}, warn: (...args) => warnings.push(args) }) };
}

async function treeSnapshot(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const snapshot = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) snapshot[entry.name] = await treeSnapshot(path);
    else if (entry.isSymbolicLink()) snapshot[entry.name] = { symlink: await readlink(path) };
    else snapshot[entry.name] = { size: (await stat(path)).size, sha256: createHash('sha256').update(await readFile(path)).digest('hex') };
  }
  return snapshot;
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
  assert.equal(f.state.items.length, 3);
  assert.equal(f.state.titles.length, 3);
  for (const game of f.state.games) {
    assert.equal(game.id, fingerprint(game.directoryName));
    assert.equal(game.sourceAvailable, true);
    const item = f.state.items.find((candidate) => candidate.id === game.archiveItemId);
    assert.ok(item, 'each Game must be linked to an ArchiveItem');
    assert.equal(item.directoryPath, game.directoryPath);
    assert.equal(item.directoryName, game.directoryName);
    assert.equal(item.sourceAvailable, true);
    const title = f.state.titles.find((candidate) => candidate.id === item.titleId);
    assert.ok(title, 'each ArchiveItem must belong to a Title');
    assert.equal(title.name, game.extractedTitle);
  }
});

test('a single fresh source creates exactly one Game, ArchiveItem and Title', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.source, 'Solo'));
  const result = await f.scan();
  assert.equal(result.new, 1);
  assert.equal(f.state.games.length, 1);
  assert.equal(f.state.items.length, 1);
  assert.equal(f.state.titles.length, 1);
  const [game] = f.state.games;
  assert.equal(game.archiveItemId, f.state.items[0].id);
  assert.equal(f.state.items[0].titleId, f.state.titles[0].id);
  assert.equal(f.state.titles[0].name, 'Solo');
});

test('idempotent rescan keeps one Game/ArchiveItem/Title and the same IDs', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.source, 'Repeat'));
  await f.scan();
  const ids = { game: f.state.games[0].id, item: f.state.items[0].id, title: f.state.titles[0].id };
  await f.scan();
  await f.scan();
  assert.equal(f.state.games.length, 1);
  assert.equal(f.state.items.length, 1);
  assert.equal(f.state.titles.length, 1);
  assert.equal(f.state.games[0].id, ids.game);
  assert.equal(f.state.items[0].id, ids.item);
  assert.equal(f.state.titles[0].id, ids.title);
  assert.equal(f.warnings.length, 0);
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

test('existing unmapped Game is adopted in place: same ID, metadata preserved, one Title/ArchiveItem', async (t) => {
  const f = await fixture(t);
  const game = f.seed('Unmapped');
  game.archiveItemId = null;
  f.state.items.length = 0;
  f.state.titles.length = 0;
  await mkdir(join(f.source, 'Unmapped'));
  await f.scan();
  assert.equal(game.id, fingerprint('Unmapped'));
  assert.equal(game.sourceAvailable, true);
  assert.equal(game.metadataSource, 'manual');
  assert.equal(game.coverPath, '/cached.jpg');
  assert.equal(game.buildStatus, 'built');
  assert.equal(game.webBuildPath, '/web-builds/legacy');
  assert.equal(game.publishStatus, 'published');
  assert.equal(game.extractedTitle, 'Manual title');
  assert.equal(f.state.items.length, 1);
  assert.equal(f.state.titles.length, 1);
  assert.equal(game.archiveItemId, f.state.items[0].id);
  assert.equal(f.state.items[0].titleId, f.state.titles[0].id);
  assert.equal(f.state.titles[0].name, 'Manual title');
  assert.equal(f.warnings.length, 0);
});

test('source disappearance retains Game/ArchiveItem/Title; restoration reuses the same IDs', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.source, 'Roundtrip'));
  await f.scan();
  const ids = { game: f.state.games[0].id, item: f.state.items[0].id, title: f.state.titles[0].id };
  await rm(join(f.source, 'Roundtrip'), { recursive: true });
  assert.equal((await f.scan()).unavailable, 1);
  assert.equal(f.state.games.length, 1);
  assert.equal(f.state.items.length, 1);
  assert.equal(f.state.titles.length, 1);
  assert.equal(f.state.games[0].sourceAvailable, false);
  assert.equal(f.state.items[0].sourceAvailable, false);
  await mkdir(join(f.source, 'Roundtrip'));
  assert.equal((await f.scan()).unavailable, 0);
  assert.equal(f.state.games[0].id, ids.game);
  assert.equal(f.state.items[0].id, ids.item);
  assert.equal(f.state.titles[0].id, ids.title);
  assert.equal(f.state.games[0].sourceAvailable, true);
  assert.equal(f.state.items[0].sourceAvailable, true);
});

test('Title.name falls back to the directory name when options.rpy is absent', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.source, 'Nice_Directory'));
  await f.scan();
  assert.equal(f.state.titles[0].name, 'Nice Directory');
});

test('Title.name is filled once when NULL but never overwrites a non-null name', async (t) => {
  const f = await fixture(t);
  const game = f.seed('Named');
  f.state.titles[0].name = null;
  await mkdir(join(f.source, 'Named'));
  await f.scan();
  assert.equal(f.state.titles[0].name, 'Manual title');

  // A non-null name survives extraction changes.
  f.state.titles[0].name = 'Canonical Name';
  await writeFile(join(f.source, 'Named', 'options.rpy'), 'define config.name = "Changed"').catch(async () => {
    await mkdir(join(f.source, 'Named'));
    await writeFile(join(f.source, 'Named', 'options.rpy'), 'define config.name = "Changed"');
  });
  await f.scan();
  assert.equal(f.state.titles[0].name, 'Canonical Name');
});

test('occupied ArchiveItem directoryPath is a conflict: Game stays unmapped, no duplicates', async (t) => {
  const f = await fixture(t);
  // An existing ArchiveItem already occupies the path, with no Game linked to it.
  f.state.items.push({
    id: 'other-item', titleId: 'other-title', directoryPath: join(f.source, 'Occupied'),
    directoryName: 'Occupied', sourceAvailable: true,
  });
  f.state.titles.push({ id: 'other-title', name: 'Other' });
  await mkdir(join(f.source, 'Occupied'));
  await f.scan();
  assert.equal(f.state.items.length, 1);
  assert.equal(f.state.titles.length, 1);
  assert.equal(f.state.games[0].archiveItemId, null);
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0][1], /already occupied/);
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

test('scanning never mutates the read-only source tree (contents, symlinks, metadata)', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.source, 'Safe'), { recursive: true });
  await mkdir(join(f.source, 'Safe', 'game'));
  await writeFile(join(f.source, 'Safe', 'game', 'script.rpy'), 'label start:\n    return\n');
  await mkdir(join(f.source, 'Safe', 'game', 'images'));
  await symlink('images', join(f.source, 'Safe', 'game', 'assets'));
  const before = await treeSnapshot(f.source);
  await f.scan();
  await f.scan();
  assert.deepEqual(await treeSnapshot(f.source), before);
});
