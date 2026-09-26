import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MANIFEST_VERSION,
  buildLaunchCommand,
  isContained,
  isSafeGoldenId,
  isSafeRelativePath,
  loadManifest,
  manifestFilePath,
  resolveGoldenPath,
  resolveWithin,
  validateManifest,
} from './runtimeManifest.js';

function fixture(t, golden = 'Kinkoi Golden Loveriche', entry = 'Kinkoi.exe') {
  const root = mkdtempSync(join(tmpdir(), 'vnm-manifest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const goldenRoot = join(root, 'golden');
  const manifestRoot = join(root, 'manifests');
  mkdirSync(join(goldenRoot, golden), { recursive: true });
  mkdirSync(manifestRoot, { recursive: true });
  writeFileSync(join(goldenRoot, golden, entry), 'fake-exe');
  return { root, goldenRoot, manifestRoot };
}

function baseManifest(overrides = {}) {
  return {
    version: MANIFEST_VERSION,
    golden: 'Kinkoi Golden Loveriche',
    runnerImage: 'vn-runner-noble:1.19.0',
    entrypoint: 'Kinkoi.exe',
    workingDir: '.',
    winePrefix: null,
    locale: null,
    env: {},
    saveStrategy: 'whole-tree-cow',
    ...overrides,
  };
}

test('safe golden ids reject traversal and separators', () => {
  assert.ok(isSafeGoldenId('Kinkoi Golden Loveriche'));
  assert.equal(isSafeGoldenId('../evil'), false);
  assert.equal(isSafeGoldenId('a/b'), false);
  assert.equal(isSafeGoldenId('/abs'), false);
  assert.equal(isSafeGoldenId('..'), false);
  assert.equal(isSafeGoldenId('.'), false);
  assert.equal(isSafeGoldenId(''), false);
});

test('safe relative paths reject escaping forms', () => {
  assert.ok(isSafeRelativePath('Kinkoi.exe'));
  assert.ok(isSafeRelativePath('Runtime/Game.exe'));
  assert.equal(isSafeRelativePath('/abs.exe'), false);
  assert.equal(isSafeRelativePath('../escape.exe'), false);
  assert.equal(isSafeRelativePath('a/../b'), false);
  assert.equal(isSafeRelativePath('C:\\game.exe'), false);
});

test('containment + resolvers stay beneath their roots', () => {
  assert.ok(isContained('/a/b', '/a/b/c'));
  assert.equal(isContained('/a/b', '/a/bc'), false);
  assert.equal(resolveGoldenPath('/g', 'fine'), join('/g', 'fine'));
  assert.equal(resolveGoldenPath('/g', '../x'), null);
  assert.equal(resolveWithin('/g/game', '..', ), null);
  assert.equal(resolveWithin('/g/game', 'sub/a.exe'), join('/g/game', 'sub', 'a.exe'));
});

test('loadManifest returns structured errors', async (t) => {
  const { manifestRoot } = fixture(t);
  const missing = await loadManifest('nope', { manifestRoot });
  assert.equal(missing.manifest, null);
  assert.equal(missing.error.code, 'MANIFEST_NOT_FOUND');
  const badId = await loadManifest('../escape', { manifestRoot });
  assert.equal(badId.error.code, 'INVALID_MANIFEST_ID');
  writeFileSync(manifestFilePath(manifestRoot, 'broken'), '{not json');
  const broken = await loadManifest('broken', { manifestRoot });
  assert.equal(broken.error.code, 'MALFORMED_MANIFEST');
});

test('valid manifest resolves golden, entrypoint, working dir', async (t) => {
  const { goldenRoot } = fixture(t);
  const result = await validateManifest(baseManifest(), { runtimeId: 'r1', goldenRoot });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.resolved.entrypointPath.endsWith('Kinkoi.exe'), true);
  assert.equal(result.resolved.workingDirPath.endsWith('Kinkoi Golden Loveriche'), true);
});

test('invalid/traversing golden id is rejected', async (t) => {
  const { goldenRoot } = fixture(t);
  const result = await validateManifest(baseManifest({ golden: '../evil' }), { runtimeId: 'r1', goldenRoot });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === 'INVALID_GOLDEN'));
});

test('escaping entrypoint is rejected', async (t) => {
  const { goldenRoot } = fixture(t);
  const result = await validateManifest(baseManifest({ entrypoint: '../escape.exe' }), { runtimeId: 'r1', goldenRoot });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === 'INVALID_ENTRYPOINT'));
});

test('wrong runtime id is rejected', async (t) => {
  const { goldenRoot } = fixture(t);
  const manifest = baseManifest({ browserRuntimeId: 'other-id' });
  const result = await validateManifest(manifest, { runtimeId: 'expected-id', goldenRoot });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === 'RUNTIME_ID_MISMATCH'));
});

test('unknown runner image is rejected', async (t) => {
  const { goldenRoot } = fixture(t);
  const result = await validateManifest(baseManifest({ runnerImage: 'evil:latest' }), { runtimeId: 'r1', goldenRoot });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === 'UNKNOWN_RUNNER_IMAGE'));
});

test('missing entrypoint is rejected', async (t) => {
  const { goldenRoot } = fixture(t);
  const result = await validateManifest(baseManifest({ entrypoint: 'Missing.exe' }), { runtimeId: 'r1', goldenRoot });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === 'ENTRYPOINT_MISSING'));
});

test('unknown save strategy and bad env are rejected (shape stage)', async (t) => {
  const { goldenRoot } = fixture(t);
  const result = await validateManifest(
    baseManifest({ saveStrategy: 'magic', env: { '1BAD': 'x', GOODKEY: 5 } }),
    { runtimeId: 'r1', goldenRoot },
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === 'UNKNOWN_SAVE_STRATEGY'));
  assert.ok(result.errors.some((e) => e.code === 'INVALID_ENV'));
});

test('missing winePrefix directory is rejected', async (t) => {
  const { goldenRoot } = fixture(t);
  const result = await validateManifest(baseManifest({ winePrefix: 'prefix' }), { runtimeId: 'r1', goldenRoot });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === 'WINE_PREFIX_MISSING'));
});

test('launch command is derived from the declarative manifest', () => {
  assert.equal(buildLaunchCommand(baseManifest()), 'wine Kinkoi.exe');
  assert.equal(
    buildLaunchCommand(baseManifest({ workingDir: 'Runtime', winePrefix: 'prefix' })),
    'wine WINEPREFIX="prefix" Runtime/Kinkoi.exe',
  );
});
