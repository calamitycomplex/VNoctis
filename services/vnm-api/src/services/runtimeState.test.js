import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  RuntimePathError,
  ensureUserRuntime,
  runtimeParentDir,
  runtimeTreeDir,
  sessionScratchDir,
  userRootDir,
} from './runtimeState.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const RUNTIME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUNTIME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'vnm-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const goldenRoot = join(root, 'golden');
  const userRoot = join(root, 'users');
  const golden = join(goldenRoot, 'Kinkoi Golden Loveriche');
  mkdirSync(golden, { recursive: true });
  writeFileSync(join(golden, 'Kinkoi.exe'), 'exe');
  return { root, goldenRoot, userRoot };
}

const manifest = { golden: 'Kinkoi Golden Loveriche' };

test('first preparation clones the golden and creates scratch', async (t) => {
  const { goldenRoot, userRoot } = fixture(t);
  const res = await ensureUserRuntime({
    goldenRoot, userRoot, manifest, userId: USER_A, browserRuntimeId: RUNTIME_A, reflinkMode: 'auto',
  });
  assert.equal(res.created, true);
  assert.ok(existsSync(join(res.runtimeDir, 'Kinkoi.exe')));
  assert.ok(existsSync(res.scratchDir));
});

test('second preparation reuses the persistent runtime clone', async (t) => {
  const { goldenRoot, userRoot } = fixture(t);
  const first = await ensureUserRuntime({
    goldenRoot, userRoot, manifest, userId: USER_A, browserRuntimeId: RUNTIME_A, reflinkMode: 'auto',
  });
  assert.equal(first.created, true);

  // A user-save marker must survive a later preparation (reuse, not reclone).
  mkdirSync(join(first.runtimeDir, 'SaveData'), { recursive: true });
  writeFileSync(join(first.runtimeDir, 'SaveData', 'save.dat'), 'progress');
  const second = await ensureUserRuntime({
    goldenRoot, userRoot, manifest, userId: USER_A, browserRuntimeId: RUNTIME_A, reflinkMode: 'auto',
  });
  assert.equal(second.created, false);
  assert.ok(existsSync(join(second.runtimeDir, 'SaveData', 'save.dat')));
});

test('failed clone leaves no half-valid runtime tree', async (t) => {
  const { goldenRoot, userRoot } = fixture(t);
  const failing = async () => { throw new Error('simulated cp failure'); };
  await assert.rejects(
    ensureUserRuntime({
      goldenRoot, userRoot, manifest, userId: USER_A, browserRuntimeId: RUNTIME_A, runCommand: failing,
    }),
    (err) => err instanceof RuntimePathError && err.code === 'CLONE_FAILED',
  );
  assert.equal(existsSync(runtimeTreeDir(userRoot, USER_A, RUNTIME_A)), false);
});

test('user A and user B trees are isolated', async (t) => {
  const { goldenRoot, userRoot } = fixture(t);
  const a = await ensureUserRuntime({ goldenRoot, userRoot, manifest, userId: USER_A, browserRuntimeId: RUNTIME_A, reflinkMode: 'auto' });
  const b = await ensureUserRuntime({ goldenRoot, userRoot, manifest, userId: USER_B, browserRuntimeId: RUNTIME_A, reflinkMode: 'auto' });
  assert.notEqual(a.runtimeDir, b.runtimeDir);
  assert.equal(a.runtimeDir.startsWith(userRootDir(userRoot, USER_A) + '/'), true);
  assert.equal(b.runtimeDir.startsWith(userRootDir(userRoot, USER_B) + '/'), true);
  assert.equal(a.scratchDir.startsWith(runtimeParentDir(userRoot, USER_A, RUNTIME_A)), true);
  assert.equal(sessionScratchDir(userRoot, USER_A, RUNTIME_A), a.scratchDir);
});

test('runtime A and runtime B trees are isolated for one user', async (t) => {
  const { goldenRoot, userRoot } = fixture(t);
  const a = await ensureUserRuntime({ goldenRoot, userRoot, manifest, userId: USER_A, browserRuntimeId: RUNTIME_A, reflinkMode: 'auto' });
  const b = await ensureUserRuntime({ goldenRoot, userRoot, manifest, userId: USER_A, browserRuntimeId: RUNTIME_B, reflinkMode: 'auto' });
  assert.notEqual(a.runtimeDir, b.runtimeDir);
});

test('invalid ids and escaping golden are rejected', async (t) => {
  const { goldenRoot, userRoot } = fixture(t);
  await assert.rejects(
    ensureUserRuntime({ goldenRoot, userRoot, manifest, userId: 'not-a-uuid', browserRuntimeId: RUNTIME_A }),
    (err) => err instanceof RuntimePathError && err.code === 'INVALID_USER_ID',
  );
  await assert.rejects(
    ensureUserRuntime({ goldenRoot, userRoot, manifest: { golden: '../escape' }, userId: USER_A, browserRuntimeId: RUNTIME_A }),
    (err) => err instanceof RuntimePathError && err.code === 'INVALID_GOLDEN',
  );
});

test('scratch is reset between preparations', async (t) => {
  const { goldenRoot, userRoot } = fixture(t);
  const first = await ensureUserRuntime({ goldenRoot, userRoot, manifest, userId: USER_A, browserRuntimeId: RUNTIME_A, reflinkMode: 'auto' });
  writeFileSync(join(first.scratchDir, 'tmp.bin'), 'x');
  const second = await ensureUserRuntime({ goldenRoot, userRoot, manifest, userId: USER_A, browserRuntimeId: RUNTIME_A, reflinkMode: 'auto' });
  assert.equal(existsSync(join(second.scratchDir, 'tmp.bin')), false);
});

test('real Btrfs reflink clone works when the runtime filesystem supports it', async (t) => {
  const btrfsRoot = '/srv/vn-runtime';
  if (!existsSync(btrfsRoot)) return t.skip('no /srv/vn-runtime on this host');
  // Probe reflink support cheaply first.
  const probe = mkdtempSync(join(btrfsRoot, 'vnm-reflink-probe-'));
  try {
    writeFileSync(join(probe, 'a'), 'x'.repeat(1024));
    try {
      execFileSync('cp', ['--reflink=always', join(probe, 'a'), join(probe, 'b')]);
    } catch {
      rmSync(probe, { recursive: true, force: true });
      return t.skip('filesystem does not support reflink');
    }
    rmSync(probe, { recursive: true, force: true });

    const goldenRoot = mkdtempSync(join(btrfsRoot, 'vnm-reflink-golden-'));
    const userRoot = mkdtempSync(join(btrfsRoot, 'vnm-reflink-users-'));
    t.after(() => {
      rmSync(goldenRoot, { recursive: true, force: true });
      rmSync(userRoot, { recursive: true, force: true });
    });
    const golden = join(goldenRoot, 'G');
    mkdirSync(golden, { recursive: true });
    writeFileSync(join(golden, 'Kinkoi.exe'), 'exe');

    const res = await ensureUserRuntime({
      goldenRoot, userRoot, manifest: { golden: 'G' }, userId: USER_A, browserRuntimeId: RUNTIME_A, reflinkMode: 'always',
    });
    assert.equal(res.created, true);
    assert.ok(existsSync(join(res.runtimeDir, 'Kinkoi.exe')));
  } catch (err) {
    rmSync(probe, { recursive: true, force: true });
    throw err;
  }
});
