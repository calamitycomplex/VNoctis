import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractRpaArchives } from './rpaExtractor.js';
import { createBuildWorkspace } from './buildWorkspace.js';
import { installFakeUnrpa } from '../../test/helpers/fakeUnrpa.js';

const silentLogger = { info() {}, warn() {} };

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vnoctis-rpa-'));
  const source = join(root, 'source');
  const basePath = join(root, 'web-builds');

  await mkdir(join(source, 'game'), { recursive: true });
  await writeFile(join(source, 'game', 'archive.rpa'), 'RPA-CONTENT');
  await writeFile(join(source, 'game', 'script.rpy'), 'label start:');

  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, source, basePath };
}

test('extraction runs in the staging copy and never mutates the source .rpa', async (t) => {
  const fake = await installFakeUnrpa({ exitCode: 0 });
  t.after(() => fake.restore());

  const { source, basePath } = await fixture(t);
  const workspace = await createBuildWorkspace({
    sourcePath: source,
    basePath,
    jobId: 'job-1',
  });

  await extractRpaArchives(workspace, silentLogger, { strict: true });

  // Source is untouched: .rpa still present, no extracted marker.
  assert.equal(await readFile(join(source, 'game', 'archive.rpa'), 'utf8'), 'RPA-CONTENT');
  assert.equal(await exists(join(source, 'game', 'UNRPA_EXTRACTED')), false);

  // Extraction targeted the workspace: .rpa removed there, marker written there.
  assert.equal(await exists(join(workspace, 'game', 'archive.rpa')), false);
  assert.equal(await exists(join(workspace, 'game', 'UNRPA_EXTRACTED')), true);
});

test('strict extraction failure throws and leaves the source untouched', async (t) => {
  const fake = await installFakeUnrpa({ exitCode: 1 });
  t.after(() => fake.restore());

  const { source, basePath } = await fixture(t);
  const workspace = await createBuildWorkspace({
    sourcePath: source,
    basePath,
    jobId: 'job-2',
  });

  await assert.rejects(
    () => extractRpaArchives(workspace, silentLogger, { strict: true }),
    /Failed to extract/
  );

  assert.equal(await readFile(join(source, 'game', 'archive.rpa'), 'utf8'), 'RPA-CONTENT');
  assert.equal(await exists(join(source, 'game', 'UNRPA_EXTRACTED')), false);
});

test('non-strict extraction failure is tolerated (import behavior unchanged)', async (t) => {
  const fake = await installFakeUnrpa({ exitCode: 1 });
  t.after(() => fake.restore());

  const { source, basePath } = await fixture(t);
  const workspace = await createBuildWorkspace({
    sourcePath: source,
    basePath,
    jobId: 'job-3',
  });

  await extractRpaArchives(workspace, silentLogger);

  assert.equal(await exists(join(workspace, 'game', 'archive.rpa')), true);
  assert.equal(await readFile(join(source, 'game', 'archive.rpa'), 'utf8'), 'RPA-CONTENT');
});
