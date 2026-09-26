/**
 * Real launch-path orchestration tests (mocked Kasm, tiny COW fixtures).
 *
 * No live Kasm call and no real golden clone: goldens are tiny directories and
 * the clone uses reflinkMode 'auto' so tmpfs/ext4 fixtures work.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureUserRuntime } from './runtimeState.js';
import {
  BrowserSessionError,
  extractConnectUrl,
  extractKasmId,
  launchTitleBrowserSession,
  normalizeKasmStatus,
  refreshBrowserSessionStatus,
  serializeBrowserSession,
  terminateBrowserSession,
} from './browserSessionService.js';

/** Tiny in-memory Prisma double covering only the calls the service makes. */
function makePrisma() {
  const titles = new Map();
  const runtimes = new Map();
  const sessions = new Map();
  const users = new Map();
  return {
    titles, runtimes, sessions, users,
    title: { findUnique: async ({ where }) => titles.get(where.id) ?? null },
    browserRuntime: { findUnique: async ({ where }) => runtimes.get(where.titleId) ?? null },
    user: {
      findUnique: async ({ where }) => users.get(where.id) ?? null,
      update: async ({ where, data }) => {
        const u = users.get(where.id);
        Object.assign(u, data);
        return u;
      },
    },
    browserSession: {
      create: async ({ data }) => {
        if (data.activeKey != null) {
          for (const s of sessions.values()) {
            if (s.activeKey === data.activeKey) {
              const e = new Error('unique constraint');
              e.code = 'P2002';
              throw e;
            }
          }
        }
        const row = {
          id: randomUUID(),
          kasmSessionId: null,
          endedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastSeenAt: new Date(),
          ...data,
        };
        sessions.set(row.id, row);
        return row;
      },
      update: async ({ where, data }) => {
        const r = sessions.get(where.id);
        Object.assign(r, data);
        r.updatedAt = new Date();
        return r;
      },
      findUnique: async ({ where }) => sessions.get(where.id) ?? null,
      findFirst: async ({ where }) => {
        for (const s of sessions.values()) {
          const userOk = where.userId == null || s.userId === where.userId;
          const activeOk = where.activeKey == null || s.activeKey === where.activeKey;
          if (userOk && activeOk) return s;
        }
        return null;
      },
    },
  };
}

/** Mocked Kasm client recording the call order. */
function makeKasm(overrides = {}) {
  const calls = [];
  const base = {
    calls,
    findImage: async (name) => ({ image_id: 'aa11bb22', name }),
    findUserByUsername: async () => null,
    createUser: async ({ username }) => ({ user_id: `kasm-${username}`, username }),
    updateUserAttributes: async () => ({ ok: true }),
    setRuntimeTarget: async (args) => { calls.push(['target', args]); return { ok: true }; },
    requestSession: async (payload) => { calls.push(['request', payload]); return { kasm_id: 'kasm-123' }; },
    getSessionStatus: async () => ({ status: 'running' }),
    joinSession: async (id) => ({ kasm_url: `https://holo/#/connect/kasm/${id}` }),
    stopSession: async (id) => { calls.push(['stop', id]); return {}; },
    destroySession: async (id) => { calls.push(['destroy', id]); return {}; },
  };
  return { ...base, ...overrides };
}

async function setup(t, { runtimeState = 'READY' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vnm-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const goldenRoot = join(root, 'golden');
  const manifestRoot = join(root, 'manifests');
  const userRuntimeRoot = join(root, 'users');
  const runtimeId = randomUUID();
  const titleId = randomUUID();
  const userId = randomUUID();
  const otherUserId = randomUUID();

  await mkdir(join(goldenRoot, 'Kinkoi Golden Loveriche'), { recursive: true });
  await mkdir(join(goldenRoot, 'Kinkoi Golden Loveriche', 'Kinkoi_Data'), { recursive: true });
  await writeFile(join(goldenRoot, 'Kinkoi Golden Loveriche', 'Kinkoi.exe'), 'exe');
  await mkdir(manifestRoot, { recursive: true });
  await writeFile(
    join(manifestRoot, `${runtimeId}.json`),
    JSON.stringify({
      version: 1,
      browserRuntimeId: runtimeId,
      golden: 'Kinkoi Golden Loveriche',
      runnerImage: 'vn-runner-noble:1.19.0',
      entrypoint: 'Kinkoi.exe',
      workingDir: '.',
      winePrefix: null,
      env: {},
      saveStrategy: 'whole-tree-cow',
    }),
  );

  const prisma = makePrisma();
  prisma.titles.set(titleId, { id: titleId, name: 'Kinkoi Golden Loveriche' });
  prisma.runtimes.set(titleId, { id: runtimeId, titleId, state: runtimeState, manifestId: runtimeId });
  prisma.users.set(userId, { id: userId, kasmUsername: null, kasmUserId: null });
  prisma.users.set(otherUserId, { id: otherUserId, kasmUsername: null, kasmUserId: null });

  const prepareRuntime = (opts) => ensureUserRuntime({ ...opts, reflinkMode: 'auto' });
  return { prisma, goldenRoot, manifestRoot, userRuntimeRoot, runtimeId, titleId, userId, otherUserId, prepareRuntime };
}

const launchArgs = (s, extra = {}) => ({
  prisma: s.prisma,
  kasmClient: extra.kasmClient ?? makeKasm(),
  titleId: s.titleId,
  userId: s.userId,
  goldenRoot: s.goldenRoot,
  manifestRoot: s.manifestRoot,
  userRuntimeRoot: s.userRuntimeRoot,
  prepareRuntime: s.prepareRuntime,
  ...extra,
});

test('normalizeKasmStatus maps live operational statuses', () => {
  assert.equal(normalizeKasmStatus({ status: 'running' }), 'RUNNING');
  assert.equal(normalizeKasmStatus({ operational_status: 'ASSIGNED' }), 'STARTING');
  assert.equal(normalizeKasmStatus({ status: 'provisioning' }), 'STARTING');
  assert.equal(normalizeKasmStatus({ status: 'stopping' }), 'STOPPING');
  assert.equal(normalizeKasmStatus({ status: 'destroying' }), 'STOPPING');
  assert.equal(normalizeKasmStatus({ status: 'stopped' }), 'ENDED');
  assert.equal(normalizeKasmStatus({ status: 'error' }), 'ERROR');
  assert.equal(normalizeKasmStatus({ kasm: { operational_status: 'running' } }), 'RUNNING');
  assert.equal(normalizeKasmStatus({}), 'STARTING');
});

test('extractKasmId / extractConnectUrl tolerate shapes', () => {
  assert.equal(extractKasmId({ kasm_id: 'a' }), 'a');
  assert.equal(extractKasmId({ kasm: { kasm_id: 'b' } }), 'b');
  assert.equal(extractKasmId(null), null);
  assert.equal(extractConnectUrl({ kasm_url: 'https://holo/#/connect/kasm/1' }), 'https://holo/#/connect/kasm/1');
  assert.equal(
    extractConnectUrl({ kasm_url: 'https://holo/#/connect/kasm/1' }, 'https://public.example'),
    'https://public.example/#/connect/kasm/1',
  );
  assert.equal(extractConnectUrl({}), null);
});

test('launch: prepares runtime, creates identity, sets target, requests, RUNNING', async (t) => {
  const s = await setup(t);
  const kasm = makeKasm();
  const res = await launchTitleBrowserSession(launchArgs(s, { kasmClient: kasm }));

  assert.equal(res.session.state, 'RUNNING');
  assert.equal(res.session.kasmSessionId, 'kasm-123');
  assert.equal(res.runtime.created, true);
  assert.ok(existsSync(join(res.runtime.runtimeDir, 'Kinkoi.exe')));

  // Dedicated identity persisted on the app user.
  assert.equal(s.prisma.users.get(s.userId).kasmUserId, `kasm-vnoctis-${s.userId}`);

  // Target set before request; request carries the manifest-derived image id.
  assert.deepEqual(kasm.calls.map((c) => c[0]), ['target', 'request']);
  const [, target] = kasm.calls[0];
  assert.equal(target.appUserId, s.userId);
  assert.equal(target.browserRuntimeId, s.runtimeId);
  assert.equal(target.kasmUserId, `kasm-vnoctis-${s.userId}`);
  assert.equal(kasm.calls[1][1].imageId, 'aa11bb22');
});

test('launch denied when runtime is not READY', async (t) => {
  const s = await setup(t, { runtimeState: 'PREPARING' });
  await assert.rejects(
    launchTitleBrowserSession(launchArgs(s)),
    (e) => e instanceof BrowserSessionError && e.code === 'RUNTIME_NOT_READY' && e.status === 409,
  );
});

test('launch denied when the manifest is missing/invalid', async (t) => {
  const s = await setup(t);
  s.prisma.runtimes.get(s.titleId).manifestId = 'does-not-exist';
  await assert.rejects(
    launchTitleBrowserSession(launchArgs(s)),
    (e) => e instanceof BrowserSessionError && e.code === 'RUNTIME_NOT_LAUNCHABLE',
  );
});

test('launch denied when the runner image is absent from Kasm', async (t) => {
  const s = await setup(t);
  const kasm = makeKasm({ findImage: async () => null });
  await assert.rejects(
    launchTitleBrowserSession(launchArgs(s, { kasmClient: kasm })),
    (e) => e instanceof BrowserSessionError && e.code === 'RUNNER_IMAGE_MISSING',
  );
});

test('duplicate active session is denied before touching scratch', async (t) => {
  const s = await setup(t);
  await launchTitleBrowserSession(launchArgs(s));
  await assert.rejects(
    launchTitleBrowserSession(launchArgs(s, { kasmClient: makeKasm() })),
    (e) => e instanceof BrowserSessionError && e.code === 'ACTIVE_SESSION_EXISTS' && e.status === 409,
  );
});

test('Kasm request failure marks the session ERROR and clears activeKey', async (t) => {
  const s = await setup(t);
  const kasm = makeKasm({ requestSession: async () => { throw new Error('kasm boom'); } });
  await assert.rejects(launchTitleBrowserSession(launchArgs(s, { kasmClient: kasm })));

  const row = [...s.prisma.sessions.values()][0];
  assert.equal(row.state, 'ERROR');
  assert.equal(row.activeKey, null);
  assert.ok(row.endedAt);
  // A later launch is allowed because activeKey was released.
  const res = await launchTitleBrowserSession(launchArgs(s));
  assert.equal(res.session.state, 'RUNNING');
});

test('status reconciles live Kasm state and returns a connect URL when RUNNING', async (t) => {
  const s = await setup(t);
  const kasm = makeKasm();
  const launch = await launchTitleBrowserSession(launchArgs(s, { kasmClient: kasm }));

  const running = await refreshBrowserSessionStatus({
    prisma: s.prisma, kasmClient: kasm, sessionId: launch.session.id, user: { userId: s.userId },
  });
  assert.equal(running.session.state, 'RUNNING');
  assert.equal(running.connectUrl, 'https://holo/#/connect/kasm/kasm-123');

  const kasm2 = makeKasm({ getSessionStatus: async () => ({ status: 'stopped' }) });
  const ended = await refreshBrowserSessionStatus({
    prisma: s.prisma, kasmClient: kasm2, sessionId: launch.session.id, user: { userId: s.userId },
  });
  assert.equal(ended.session.state, 'ENDED');
  assert.equal(s.prisma.sessions.get(launch.session.id).activeKey, null);
});

test('status rejects non-owners, allows admin', async (t) => {
  const s = await setup(t);
  const kasm = makeKasm();
  const launch = await launchTitleBrowserSession(launchArgs(s, { kasmClient: kasm }));
  await assert.rejects(
    refreshBrowserSessionStatus({
      prisma: s.prisma, kasmClient: kasm, sessionId: launch.session.id, user: { userId: s.otherUserId },
    }),
    (e) => e.code === 'FORBIDDEN' && e.status === 403,
  );
  const asAdmin = await refreshBrowserSessionStatus({
    prisma: s.prisma, kasmClient: kasm, sessionId: launch.session.id, user: { userId: 'admin', role: 'admin' },
  });
  assert.equal(asAdmin.session.id, launch.session.id);
});

test('terminate stops+destroys, keeps persistent runtime, resets scratch', async (t) => {
  const s = await setup(t);
  const kasm = makeKasm();
  const launch = await launchTitleBrowserSession(launchArgs(s, { kasmClient: kasm }));

  const res = await terminateBrowserSession({
    prisma: s.prisma, kasmClient: kasm, sessionId: launch.session.id, user: { userId: s.userId },
    userRuntimeRoot: s.userRuntimeRoot,
  });
  assert.equal(res.session.state, 'ENDED');
  assert.deepEqual(kasm.calls.map((c) => c[0]).slice(-2), ['stop', 'destroy']);
  assert.ok(existsSync(join(launch.runtime.runtimeDir, 'Kinkoi.exe')));
  assert.ok(existsSync(launch.runtime.scratchDir));
});

test('terminate is idempotent and blocks non-owners', async (t) => {
  const s = await setup(t);
  const kasm = makeKasm();
  const launch = await launchTitleBrowserSession(launchArgs(s, { kasmClient: kasm }));
  await terminateBrowserSession({
    prisma: s.prisma, kasmClient: kasm, sessionId: launch.session.id, user: { userId: s.userId },
    userRuntimeRoot: s.userRuntimeRoot,
  });
  const again = await terminateBrowserSession({
    prisma: s.prisma, kasmClient: kasm, sessionId: launch.session.id, user: { userId: s.userId },
    userRuntimeRoot: s.userRuntimeRoot,
  });
  assert.equal(again.stopped, false);

  await assert.rejects(
    terminateBrowserSession({
      prisma: s.prisma, kasmClient: kasm, sessionId: launch.session.id, user: { userId: s.otherUserId },
      userRuntimeRoot: s.userRuntimeRoot,
    }),
    (e) => e.code === 'FORBIDDEN',
  );
});

test('second launch reuses the persistent runtime (no re-clone)', async (t) => {
  const s = await setup(t);
  const kasm = makeKasm();
  const first = await launchTitleBrowserSession(launchArgs(s, { kasmClient: kasm }));
  assert.equal(first.runtime.created, true);

  // Persistence marker inside the USER runtime only.
  await writeFile(join(first.runtime.runtimeDir, '.vnoctis-persistence-test'), 'marker');

  await terminateBrowserSession({
    prisma: s.prisma, kasmClient: kasm, sessionId: first.session.id, user: { userId: s.userId },
    userRuntimeRoot: s.userRuntimeRoot,
  });

  const second = await launchTitleBrowserSession(launchArgs(s, { kasmClient: kasm }));
  assert.equal(second.runtime.created, false);
  assert.ok(existsSync(join(second.runtime.runtimeDir, '.vnoctis-persistence-test')));
});

test('different users get isolated runtime trees for the same runtime', async (t) => {
  const s = await setup(t);
  const kasm = makeKasm();

  const first = await launchTitleBrowserSession(launchArgs(s, { kasmClient: kasm }));
  await writeFile(join(first.runtime.runtimeDir, '.user1-marker'), 'x');
  await terminateBrowserSession({
    prisma: s.prisma, kasmClient: kasm, sessionId: first.session.id, user: { userId: s.userId },
    userRuntimeRoot: s.userRuntimeRoot,
  });

  const second = await launchTitleBrowserSession(launchArgs(s, { userId: s.otherUserId, kasmClient: kasm }));
  assert.notEqual(first.runtime.runtimeDir, second.runtime.runtimeDir);
  assert.ok(!existsSync(join(second.runtime.runtimeDir, '.user1-marker')));
  assert.equal(s.prisma.users.get(s.otherUserId).kasmUserId, `kasm-vnoctis-${s.otherUserId}`);
});

test('serializeBrowserSession never exposes credentials', async (t) => {
  const s = await setup(t);
  const kasm = makeKasm();
  const launch = await launchTitleBrowserSession(launchArgs(s, { kasmClient: kasm }));
  const out = serializeBrowserSession(s.prisma.sessions.get(launch.session.id));
  assert.deepEqual(Object.keys(out).sort(), [
    'browserRuntimeId', 'createdAt', 'endedAt', 'id', 'kasmSessionId', 'lastSeenAt', 'state', 'updatedAt',
  ]);
});
