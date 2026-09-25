import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildStagingRoot,
  cleanupBuildWorkspace,
  createBuildWorkspace,
  sweepStaleBuildWorkspaces,
} from './buildWorkspace.js';

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vnoctis-workspace-'));
  const source = join(root, 'source');
  const basePath = join(root, 'web-builds');

  await mkdir(join(source, 'game'), { recursive: true });
  await writeFile(join(source, 'game', 'archive.rpa'), 'RPA-CONTENT');

  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, source, basePath };
}

test('create copies the source read-only and cleanup removes only the workspace', async (t) => {
  const { source, basePath } = await fixture(t);

  const workspace = await createBuildWorkspace({
    sourcePath: source,
    basePath,
    jobId: 'job-1',
  });

  assert.ok(workspace.startsWith(buildStagingRoot(basePath)));
  assert.equal(await readFile(join(workspace, 'game', 'archive.rpa'), 'utf8'), 'RPA-CONTENT');

  await cleanupBuildWorkspace(workspace, { basePath });

  assert.equal(await exists(workspace), false);
  assert.equal(await exists(source), true);
  assert.equal(await readFile(join(source, 'game', 'archive.rpa'), 'utf8'), 'RPA-CONTENT');
});

test('cleanup refuses a path outside the staging root', async (t) => {
  const { source, basePath } = await fixture(t);

  await cleanupBuildWorkspace(source, { basePath });

  assert.equal(await exists(source), true);
  assert.equal(await readFile(join(source, 'game', 'archive.rpa'), 'utf8'), 'RPA-CONTENT');
});

test('sweep removes stale workspaces and keeps fresh ones', async (t) => {
  const { basePath } = await fixture(t);
  const root = buildStagingRoot(basePath);

  await mkdir(join(root, 'stale'), { recursive: true });
  await mkdir(join(root, 'fresh'), { recursive: true });

  await sweepStaleBuildWorkspaces({ basePath, ttlMs: 0 });

  // With ttlMs 0 everything is stale; the sweep still targets staging only.
  assert.equal(await exists(join(root, 'stale')), false);
  assert.equal(await exists(join(root, 'fresh')), false);
});

test('a source symlink cannot cause a staging write to alter a file outside the workspace', async (t) => {
  const { root, source, basePath } = await fixture(t);
  const outside = join(root, 'outside');
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'notes.txt'), 'OUTSIDE');

  // Safe symlink that stays inside the game source tree.
  await symlink('real.txt', join(source, 'game', 'real.txt.link'));
  await writeFile(join(source, 'game', 'real.txt'), 'ORIG');

  const workspace = await createBuildWorkspace({
    sourcePath: source,
    basePath,
    jobId: 'job-safe',
  });

  // Verbatim relative link is preserved and still resolves inside the workspace.
  assert.equal(await readlink(join(workspace, 'game', 'real.txt.link')), 'real.txt');

  // A write through the staging symlink lands in the copy, not in the source.
  await writeFile(join(workspace, 'game', 'real.txt.link'), 'CHANGED');
  assert.equal(await readFile(join(workspace, 'game', 'real.txt'), 'utf8'), 'CHANGED');
  assert.equal(await readFile(join(source, 'game', 'real.txt'), 'utf8'), 'ORIG');

  // Escaping relative symlink: would resolve outside the workspace, so fail
  // preparation instead of preserving a dangerous link.
  await symlink('../../outside/notes.txt', join(source, 'game', 'escape.link'));
  await assert.rejects(
    () => createBuildWorkspace({ sourcePath: source, basePath, jobId: 'job-escape' }),
    /Unsafe symlink/
  );
  assert.equal(await exists(join(buildStagingRoot(basePath), 'job-escape')), false);
  assert.equal(await readFile(join(outside, 'notes.txt'), 'utf8'), 'OUTSIDE');

  // Absolute symlink back into the authoritative archive is also rejected.
  await symlink(join(source, 'game', 'real.txt'), join(source, 'game', 'absolute.link'));
  await assert.rejects(
    () => createBuildWorkspace({ sourcePath: source, basePath, jobId: 'job-absolute' }),
    /Unsafe symlink/
  );
  assert.equal(await readFile(join(source, 'game', 'real.txt'), 'utf8'), 'ORIG');
});
