/**
 * Route wiring tests for the browser-session API.
 *
 * Uses an in-memory Prisma double, a mocked Kasm client, and a stub runtime
 * preparation (no real clone). A real tiny golden + manifest is written to a
 * temp dir so manifest validation runs against the filesystem.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import browserSessionsRoutes from './browserSessions.js';
import { defaultLockRegistry } from '../services/runtimeTarget.js';
import { DEFAULT_ALLOWED_RUNNER_IMAGES } from '../services/runtimeManifest.js';

function makePrisma() {
  const titles = new Map();
  const runtimes = new Map();
  const sessions = new Map();
  const users = new Map();
  return {
    users,
    title: { findUnique: async ({ where }) => titles.get(where.id) ?? null },
    browserRuntime: { findUnique: async ({ where }) => runtimes.get(where.titleId) ?? null },
    user: {
      findUnique: async ({ where }) => users.get(where.id) ?? null,
      update: async ({ where, data }) => { const u = users.get(where.id); Object.assign(u, data); return u; },
    },
    browserSession: {
      create: async ({ data }) => {
        if (data.activeKey != null) {
          for (const s of sessions.values()) {
            if (s.activeKey === data.activeKey) { const e = new Error('unique'); e.code = 'P2002'; throw e; }
          }
        }
        const row = { id: randomUUID(), kasmSessionId: null, endedAt: null, createdAt: new Date(), updatedAt: new Date(), lastSeenAt: new Date(), ...data };
        sessions.set(row.id, row);
        return row;
      },
      update: async ({ where, data }) => { const r = sessions.get(where.id); Object.assign(r, data); r.updatedAt = new Date(); return r; },
      findUnique: async ({ where }) => sessions.get(where.id) ?? null,
      findFirst: async ({ where }) => {
        for (const s of sessions.values()) {
          if ((where.userId == null || s.userId === where.userId) && (where.activeKey == null || s.activeKey === where.activeKey)) return s;
        }
        return null;
      },
    },
    titles, runtimes, sessions,
  };
}

function makeKasm(overrides = {}) {
  return {
    findImage: async (name) => ({ image_id: 'aa11bb22', name }),
    findUserByUsername: async () => null,
    createUser: async ({ username }) => ({ user_id: `kasm-${username}`, username }),
    setRuntimeTarget: async () => ({ ok: true }),
    requestSession: async () => ({ kasm_id: 'kasm-123' }),
    getSessionStatus: async () => ({ status: 'running' }),
    joinSession: async (id) => ({ kasm_url: `https://holo/#/connect/kasm/${id}` }),
    stopSession: async () => ({}),
    destroySession: async () => ({}),
    ...overrides,
  };
}

async function fixture(t, { kasmClient = makeKasm(), runtimeState = 'READY' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vnm-routes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const goldenRoot = join(root, 'golden');
  const manifestRoot = join(root, 'manifests');
  const userRuntimeRoot = join(root, 'users');
  const runtimeId = randomUUID();
  const titleId = randomUUID();

  await mkdir(join(goldenRoot, 'Kinkoi Golden Loveriche'), { recursive: true });
  await writeFile(join(goldenRoot, 'Kinkoi Golden Loveriche', 'Kinkoi.exe'), 'exe');
  await mkdir(manifestRoot, { recursive: true });
  await writeFile(join(manifestRoot, `${runtimeId}.json`), JSON.stringify({
    version: 1, browserRuntimeId: runtimeId, golden: 'Kinkoi Golden Loveriche',
    runnerImage: DEFAULT_ALLOWED_RUNNER_IMAGES[0], entrypoint: 'Kinkoi.exe', workingDir: '.',
    winePrefix: null, env: {}, saveStrategy: 'whole-tree-cow',
  }));

  const prisma = makePrisma();
  const owner = randomUUID();
  const other = randomUUID();
  prisma.titles.set(titleId, { id: titleId, name: 'Kinkoi' });
  prisma.runtimes.set(titleId, { id: runtimeId, titleId, state: runtimeState, manifestId: runtimeId });
  prisma.users.set(owner, { id: owner, kasmUsername: null, kasmUserId: null });
  prisma.users.set(other, { id: other, kasmUsername: null, kasmUserId: null });

  const server = Fastify();
  server.decorate('prisma', prisma);
  server.decorate('kasmClient', kasmClient);
  server.decorate('goldenRoot', goldenRoot);
  server.decorate('manifestRoot', manifestRoot);
  server.decorate('userRuntimeRoot', userRuntimeRoot);
  server.decorate('allowedRunnerImages', DEFAULT_ALLOWED_RUNNER_IMAGES);
  server.decorate('kasmLockRegistry', defaultLockRegistry);
  server.decorate('prepareRuntime', async (o) => ({ parentDir: o.userId, runtimeDir: join(o.userId, 'runtime'), scratchDir: join(o.userId, 'scratch'), created: true }));
  server.addHook('onRequest', async (request) => {
    const uid = request.headers['x-test-user'];
    if (uid) request.user = { userId: uid, role: request.headers['x-test-role'] || 'viewer' };
  });
  await server.register(browserSessionsRoutes);
  t.after(() => server.close());
  return { server, prisma, titleId, owner, other };
}

const as = (user, role) => ({ headers: { 'x-test-user': user, ...(role ? { 'x-test-role': role } : {}) } });

test('launch requires authentication', async (t) => {
  const { server, titleId } = await fixture(t);
  const res = await server.inject({ method: 'POST', url: `/library/titles/${titleId}/browser-session` });
  assert.equal(res.statusCode, 401);
});

test('launch rejects a malformed title id', async (t) => {
  const { server, owner } = await fixture(t);
  const res = await server.inject({ method: 'POST', url: '/library/titles/not-a-uuid/browser-session', ...as(owner) });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'INVALID_TITLE_ID');
});

test('launch succeeds for an authenticated user on a READY runtime', async (t) => {
  const { server, titleId, owner } = await fixture(t);
  const res = await server.inject({ method: 'POST', url: `/library/titles/${titleId}/browser-session`, ...as(owner) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().session.state, 'RUNNING');
  assert.equal(res.json().session.kasmSessionId, 'kasm-123');
});

test('launch is denied when the runtime is not READY', async (t) => {
  const { server, titleId, owner } = await fixture(t, { runtimeState: 'TESTING' });
  const res = await server.inject({ method: 'POST', url: `/library/titles/${titleId}/browser-session`, ...as(owner) });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'RUNTIME_NOT_READY');
});

test('launch returns 503 when Kasm is not configured', async (t) => {
  const { server, titleId, owner } = await fixture(t, { kasmClient: null });
  const res = await server.inject({ method: 'POST', url: `/library/titles/${titleId}/browser-session`, ...as(owner) });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, 'KASM_UNAVAILABLE');
});

test('owner can read status; non-owner is forbidden; admin allowed', async (t) => {
  const { server, titleId, owner, other } = await fixture(t);
  const launch = await server.inject({ method: 'POST', url: `/library/titles/${titleId}/browser-session`, ...as(owner) });
  const sessionId = launch.json().session.id;

  const okRes = await server.inject({ method: 'GET', url: `/browser-sessions/${sessionId}`, ...as(owner) });
  assert.equal(okRes.statusCode, 200);
  assert.equal(okRes.json().session.state, 'RUNNING');
  assert.ok(okRes.json().connectUrl);

  const forbidden = await server.inject({ method: 'GET', url: `/browser-sessions/${sessionId}`, ...as(other) });
  assert.equal(forbidden.statusCode, 403);

  const admin = await server.inject({ method: 'GET', url: `/browser-sessions/${sessionId}`, ...as('someone', 'admin') });
  assert.equal(admin.statusCode, 200);
});

test('owner can terminate; non-owner is forbidden', async (t) => {
  const { server, titleId, owner, other } = await fixture(t);
  const launch = await server.inject({ method: 'POST', url: `/library/titles/${titleId}/browser-session`, ...as(owner) });
  const sessionId = launch.json().session.id;

  const forbidden = await server.inject({ method: 'DELETE', url: `/browser-sessions/${sessionId}`, ...as(other) });
  assert.equal(forbidden.statusCode, 403);

  const res = await server.inject({ method: 'DELETE', url: `/browser-sessions/${sessionId}`, ...as(owner) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().session.state, 'ENDED');
});

test('unknown or malformed session ids are handled', async (t) => {
  const { server, owner } = await fixture(t);
  const bad = await server.inject({ method: 'GET', url: '/browser-sessions/nope', ...as(owner) });
  assert.equal(bad.statusCode, 400);
  const missing = await server.inject({ method: 'GET', url: `/browser-sessions/${randomUUID()}`, ...as(owner) });
  assert.equal(missing.statusCode, 404);
});
