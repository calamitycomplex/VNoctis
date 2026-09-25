import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import buildRoutes from './build.js';
import { buildStagingRoot } from '../services/buildWorkspace.js';
import { installFakeUnrpa } from '../../test/helpers/fakeUnrpa.js';

const GAME_ID = 'a'.repeat(32);

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

async function fixture(t, { unrpaExit = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vnoctis-build-'));
  const source = join(root, 'games', 'MyGame');
  const webBuilds = join(root, 'web-builds');

  await mkdir(join(source, 'game'), { recursive: true });
  await writeFile(join(source, 'game', 'archive.rpa'), 'RPA-CONTENT');
  await writeFile(join(source, 'game', 'script.rpy'), 'label start:');

  const fake = await installFakeUnrpa({ exitCode: unrpaExit });

  const previous = {
    WEB_BUILDS_PATH: process.env.WEB_BUILDS_PATH,
    BUILDER_URL: process.env.BUILDER_URL,
  };
  process.env.WEB_BUILDS_PATH = webBuilds;
  process.env.BUILDER_URL = 'http://builder.test';

  const game = { id: GAME_ID, directoryPath: source, buildStatus: 'not_built' };
  const jobs = [];

  const app = Fastify();
  app.decorate('prisma', {
    game: {
      findUnique: async ({ where }) => (where.id === GAME_ID ? game : null),
      update: async ({ where, data }) => {
        assert.equal(where.id, GAME_ID);
        Object.assign(game, data);
      },
    },
    buildJob: {
      create: async ({ data }) => {
        const job = { id: `job-${jobs.length}`, ...data };
        jobs.push(job);
        return job;
      },
      update: async ({ where, data }) => {
        const job = jobs.find((j) => j.id === where.id);
        Object.assign(job, data);
      },
    },
  });
  await app.register(buildRoutes);

  const requests = [];
  const previousFetch = global.fetch;
  global.fetch = async (url, opts) => {
    requests.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 202, text: async () => '' };
  };

  t.after(async () => {
    global.fetch = previousFetch;
    await app.close();
    await fake.restore();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  return { app, root, source, webBuilds, game, jobs, requests };
}

test('build extracts into an isolated workspace and leaves the source .rpa intact', async (t) => {
  const { app, source, webBuilds, requests } = await fixture(t, { unrpaExit: 0 });

  const res = await app.inject({
    method: 'POST',
    url: `/build/${GAME_ID}`,
    payload: { compressAssets: true },
  });

  assert.equal(res.statusCode, 202);
  assert.equal(requests.length, 1);

  const sentPath = requests[0].body.gamePath;
  assert.notEqual(sentPath, source);
  assert.ok(sentPath.startsWith(buildStagingRoot(webBuilds)));

  // Source .rpa untouched, nothing extracted into the source.
  assert.equal(await readFile(join(source, 'game', 'archive.rpa'), 'utf8'), 'RPA-CONTENT');
  assert.equal(await exists(join(source, 'game', 'UNRPA_EXTRACTED')), false);

  // Extraction happened in the workspace that the builder was pointed at.
  assert.equal(await exists(sentPath), true);
  assert.equal(await exists(join(sentPath, 'game', 'archive.rpa')), false);
  assert.equal(await exists(join(sentPath, 'game', 'UNRPA_EXTRACTED')), true);
});

test('failed preparation fails the build cleanly and never touches the source', async (t) => {
  const { app, source, webBuilds, game, jobs, requests } = await fixture(t, { unrpaExit: 1 });

  const res = await app.inject({
    method: 'POST',
    url: `/build/${GAME_ID}`,
    payload: { compressAssets: true },
  });

  assert.equal(res.statusCode, 500);
  assert.equal(res.json().code, 'BUILD_PREPARATION_FAILED');

  // The builder was never called.
  assert.equal(requests.length, 0);

  // Source is untouched.
  assert.equal(await readFile(join(source, 'game', 'archive.rpa'), 'utf8'), 'RPA-CONTENT');
  assert.equal(await exists(join(source, 'game', 'UNRPA_EXTRACTED')), false);

  // Failed workspace was cleaned up; no staging leftovers.
  const stagingEntries = await readdir(buildStagingRoot(webBuilds)).catch(() => []);
  assert.deepEqual(stagingEntries, []);

  assert.equal(game.buildStatus, 'failed');
  assert.equal(jobs[0].status, 'failed');
});

test('compressAssets=false still builds from staging and skips RPA extraction', async (t) => {
  const { app, source, webBuilds, requests } = await fixture(t, { unrpaExit: 0 });

  const res = await app.inject({
    method: 'POST',
    url: `/build/${GAME_ID}`,
    payload: { compressAssets: false },
  });

  assert.equal(res.statusCode, 202);
  assert.equal(requests.length, 1);

  const sentPath = requests[0].body.gamePath;
  assert.notEqual(sentPath, source);
  assert.ok(sentPath.startsWith(buildStagingRoot(webBuilds)));

  // No extraction when compression is off, but the workspace is still used.
  assert.equal(await exists(sentPath), true);
  assert.equal(await exists(join(sentPath, 'game', 'archive.rpa')), true);
  assert.equal(await exists(join(sentPath, 'game', 'UNRPA_EXTRACTED')), false);
  assert.equal(await readFile(join(source, 'game', 'archive.rpa'), 'utf8'), 'RPA-CONTENT');
});
