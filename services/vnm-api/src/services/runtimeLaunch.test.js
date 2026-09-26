import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANIFEST_VERSION } from './runtimeManifest.js';
import { canLaunch } from './runtimeLaunch.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'vnm-launch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const goldenRoot = join(root, 'golden');
  const manifestRoot = join(root, 'manifests');
  mkdirSync(join(goldenRoot, 'Kinkoi Golden Loveriche'), { recursive: true });
  writeFileSync(join(goldenRoot, 'Kinkoi Golden Loveriche', 'Kinkoi.exe'), 'exe');
  mkdirSync(manifestRoot, { recursive: true });
  return { root, goldenRoot, manifestRoot };
}

function writeManifest(manifestRoot, id, overrides = {}) {
  const manifest = {
    version: MANIFEST_VERSION,
    golden: 'Kinkoi Golden Loveriche',
    runnerImage: 'vn-runner-noble:1.19.0',
    entrypoint: 'Kinkoi.exe',
    workingDir: '.',
    winePrefix: null,
    saveStrategy: 'whole-tree-cow',
    ...overrides,
  };
  writeFileSync(join(manifestRoot, `${id}.json`), JSON.stringify(manifest));
  return manifest;
}

test('READY runtime with a valid manifest can launch', async (t) => {
  const { goldenRoot, manifestRoot } = fixture(t);
  writeManifest(manifestRoot, 'kinkoi');
  const res = await canLaunch(
    { id: 'rt-1', state: 'READY', manifestId: 'kinkoi' },
    { goldenRoot, manifestRoot },
  );
  assert.equal(res.canLaunch, true);
  assert.equal(res.reason, null);
  assert.equal(res.manifest.golden, 'Kinkoi Golden Loveriche');
});

test('non-READY runtime is rejected', async (t) => {
  const { goldenRoot, manifestRoot } = fixture(t);
  writeManifest(manifestRoot, 'kinkoi');
  for (const state of ['ARCHIVE_ONLY', 'REQUESTED', 'PREPARING', 'TESTING', 'BROKEN', 'UNSUPPORTED']) {
    const res = await canLaunch({ id: 'rt-1', state, manifestId: 'kinkoi' }, { goldenRoot, manifestRoot });
    assert.equal(res.canLaunch, false);
    assert.equal(res.reason, 'NOT_READY');
  }
});

test('READY runtime without a manifest reference is rejected', async (t) => {
  const { goldenRoot, manifestRoot } = fixture(t);
  const res = await canLaunch({ id: 'rt-1', state: 'READY', manifestId: null }, { goldenRoot, manifestRoot });
  assert.equal(res.canLaunch, false);
  assert.equal(res.reason, 'NO_MANIFEST');
});

test('READY runtime with a missing manifest file is rejected', async (t) => {
  const { goldenRoot, manifestRoot } = fixture(t);
  const res = await canLaunch({ id: 'rt-1', state: 'READY', manifestId: 'ghost' }, { goldenRoot, manifestRoot });
  assert.equal(res.canLaunch, false);
  assert.equal(res.reason, 'MANIFEST_NOT_FOUND');
});

test('READY runtime with an invalid manifest is rejected', async (t) => {
  const { goldenRoot, manifestRoot } = fixture(t);
  writeManifest(manifestRoot, 'bad', { golden: 'Missing Golden' });
  const res = await canLaunch({ id: 'rt-1', state: 'READY', manifestId: 'bad' }, { goldenRoot, manifestRoot });
  assert.equal(res.canLaunch, false);
  assert.equal(res.reason, 'INVALID_MANIFEST');
  assert.ok(res.errors.some((e) => e.code === 'GOLDEN_MISSING'));
});

test('READY runtime whose manifest targets another runtime id is rejected', async (t) => {
  const { goldenRoot, manifestRoot } = fixture(t);
  writeManifest(manifestRoot, 'bound', { browserRuntimeId: 'someone-else' });
  const res = await canLaunch({ id: 'rt-1', state: 'READY', manifestId: 'bound' }, { goldenRoot, manifestRoot });
  assert.equal(res.canLaunch, false);
  assert.equal(res.reason, 'INVALID_MANIFEST');
  assert.ok(res.errors.some((e) => e.code === 'RUNTIME_ID_MISMATCH'));
});

test('game:null / missing runtime is safe', async (t) => {
  const { goldenRoot, manifestRoot } = fixture(t);
  assert.equal((await canLaunch(null, { goldenRoot, manifestRoot })).reason, 'NOT_READY');
  assert.equal((await canLaunch(undefined, { goldenRoot, manifestRoot })).reason, 'NOT_READY');
});
