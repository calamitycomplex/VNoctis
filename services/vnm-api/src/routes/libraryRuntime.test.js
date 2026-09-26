import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import libraryRoutes from './library.js';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const ITEM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ITEM_OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const archiveItem = (id, titleId, sourceAvailable = true) => ({
  id, titleId, directoryName: `release-${id.slice(0, 2)}`, directoryPath: `/games/${id}`,
  sourceAvailable, game: null,
});

/**
 * Minimal in-memory Prisma fake covering exactly the methods these routes use.
 * It deliberately ignores `select` so one stored object serves both list/detail
 * reads and the runtime endpoints.
 */
function makePrisma() {
  const titles = new Map();
  const archiveItems = new Map();
  const runtimes = new Map();
  const requests = new Map();

  return {
    titles, archiveItems, runtimes, requests,
    game: { findMany: async () => [] },
    userFavorite: { findMany: async () => [] },
    title: {
      findUnique: async ({ where }) => {
        const stored = titles.get(where.id);
        if (!stored) return null;
        return {
          ...stored,
          browserRuntime: runtimes.get(where.id) ?? null,
          webRequests: [...requests.values()].filter((r) => r.titleId === where.id).map((r) => ({ userId: r.userId })),
        };
      },
    },
    archiveItem: {
      findUnique: async ({ where }) => archiveItems.get(where.id) ?? null,
    },
    browserRuntime: {
      findUnique: async ({ where }) => runtimes.get(where.titleId) ?? null,
      create: async ({ data }) => {
        const row = { id: `rt-${data.titleId}`, createdAt: new Date(), updatedAt: new Date(), archiveItemId: null, note: null, ...data };
        runtimes.set(data.titleId, row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = { ...runtimes.get(where.titleId), ...data, updatedAt: new Date() };
        runtimes.set(where.titleId, row);
        return row;
      },
      upsert: async ({ where, create, update }) => {
        if (!runtimes.has(where.titleId)) {
          const row = { id: `rt-${where.titleId}`, createdAt: new Date(), updatedAt: new Date(), archiveItemId: null, note: null, ...create };
          runtimes.set(where.titleId, row);
          return row;
        }
        const row = { ...runtimes.get(where.titleId), ...update, updatedAt: new Date() };
        runtimes.set(where.titleId, row);
        return row;
      },
    },
    webRequest: {
      upsert: async ({ where, create }) => {
        const { titleId, userId } = where.titleId_userId;
        const key = `${titleId}:${userId}`;
        if (!requests.has(key)) requests.set(key, { id: `wr-${key}`, titleId, userId, createdAt: new Date() });
        return requests.get(key);
      },
      findMany: async ({ where }) =>
        [...requests.values()].filter((r) => r.titleId === where.titleId).map((r) => ({ userId: r.userId })),
      deleteMany: async ({ where }) => {
        let count = 0;
        for (const [key, r] of requests) {
          if (r.titleId === where.titleId && r.userId === where.userId) { requests.delete(key); count += 1; }
        }
        return { count };
      },
    },
  };
}

async function fixture(t, { prisma = makePrisma(), role = 'admin', userId = 'user-1' } = {}) {
  const server = Fastify();
  server.decorate('prisma', prisma);
  server.addHook('onRequest', async (request) => {
    const uid = request.headers['x-test-user'];
    if (uid) request.user = { userId: uid, role: request.headers['x-test-role'] || role };
  });
  await server.register(libraryRoutes);
  t.after(() => server.close());
  return { server, prisma };
}

function seedTitle(prisma, id, items = []) {
  prisma.titles.set(id, {
    id, name: `Title ${id.slice(0, 4)}`, createdAt: new Date(), updatedAt: new Date(),
    archiveItems: items, browserRuntime: null, webRequests: [], metadataSource: 'manual',
    tags: '[]', screenshots: '[]',
  });
  for (const item of items) prisma.archiveItems.set(item.id, item);
}

const asUser = (user = 'user-1', role) => ({
  headers: { 'x-test-user': user, ...(role ? { 'x-test-role': role } : {}) },
});

test('A. a Title with no runtime row defaults to ARCHIVE_ONLY', async (t) => {
  const { server, prisma } = await fixture(t);
  seedTitle(prisma, T1, [archiveItem(ITEM_A, T1)]);
  const res = await server.inject({ method: 'GET', url: `/library/titles/${T1}`, ...asUser() });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().browserRuntime.state, 'ARCHIVE_ONLY');
  assert.equal(res.json().browserRuntime.requestedByCurrentUser, false);
});

test('B/C/G. request is authenticated, idempotent, and scoped to the caller', async (t) => {
  const { server, prisma } = await fixture(t);
  seedTitle(prisma, T1, [archiveItem(ITEM_A, T1)]);

  const first = await server.inject({ method: 'POST', url: `/library/titles/${T1}/web-request`, ...asUser() });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().browserRuntime.state, 'REQUESTED');
  assert.equal(first.json().browserRuntime.requestCount, 1);
  assert.equal(first.json().browserRuntime.requestedByCurrentUser, true);

  const second = await server.inject({ method: 'POST', url: `/library/titles/${T1}/web-request`, ...asUser() });
  assert.equal(second.json().browserRuntime.requestCount, 1);
  assert.equal(second.json().browserRuntime.state, 'REQUESTED');

  // Another user's request bumps the count without flipping the caller flag.
  await server.inject({ method: 'POST', url: `/library/titles/${T1}/web-request`, ...asUser('user-2') });
  const detail = await server.inject({ method: 'GET', url: `/library/titles/${T1}`, ...asUser('user-1') });
  assert.equal(detail.json().browserRuntime.requestCount, 2);
  assert.equal(detail.json().browserRuntime.requestedByCurrentUser, true);
});

test('D. unauthenticated request is rejected', async (t) => {
  const { server, prisma } = await fixture(t);
  seedTitle(prisma, T1, [archiveItem(ITEM_A, T1)]);
  const res = await server.inject({ method: 'POST', url: `/library/titles/${T1}/web-request` });
  assert.equal(res.statusCode, 401);
});

test('E/F. withdraw removes only the caller request and keeps runtime history', async (t) => {
  const { server, prisma } = await fixture(t);
  seedTitle(prisma, T1, [archiveItem(ITEM_A, T1)]);
  await server.inject({ method: 'POST', url: `/library/titles/${T1}/web-request`, ...asUser('user-1') });
  await server.inject({ method: 'POST', url: `/library/titles/${T1}/web-request`, ...asUser('user-2') });

  const otherWithdraw = await server.inject({ method: 'DELETE', url: `/library/titles/${T1}/web-request`, ...asUser('user-3') });
  assert.equal(otherWithdraw.statusCode, 200);
  assert.equal(otherWithdraw.json().browserRuntime.requestCount, 2, 'a non-requester withdraw is a no-op');

  const own = await server.inject({ method: 'DELETE', url: `/library/titles/${T1}/web-request`, ...asUser('user-2') });
  assert.equal(own.json().browserRuntime.requestCount, 1);
  assert.equal(own.json().browserRuntime.requestedByCurrentUser, false);
  // Runtime/admin history survives withdrawal.
  assert.equal(own.json().browserRuntime.state, 'REQUESTED');

  const again = await server.inject({ method: 'DELETE', url: `/library/titles/${T1}/web-request`, ...asUser('user-2') });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().browserRuntime.requestCount, 1);
});

test('H/I/N. admin normal path applies transitions and READY is exposed', async (t) => {
  const { server, prisma } = await fixture(t);
  seedTitle(prisma, T1, [archiveItem(ITEM_A, T1)]);
  await server.inject({ method: 'POST', url: `/library/titles/${T1}/web-request`, ...asUser() });

  const prep = await server.inject({ method: 'PATCH', url: `/library/titles/${T1}/runtime`, ...asUser(), payload: { state: 'PREPARING', archiveItemId: ITEM_A } });
  assert.equal(prep.statusCode, 200);
  assert.equal(prep.json().browserRuntime.state, 'PREPARING');
  assert.equal(prep.json().browserRuntime.archiveItemId, ITEM_A);

  const test_ = await server.inject({ method: 'PATCH', url: `/library/titles/${T1}/runtime`, ...asUser(), payload: { state: 'TESTING' } });
  assert.equal(test_.json().browserRuntime.state, 'TESTING');
  const ready = await server.inject({ method: 'PATCH', url: `/library/titles/${T1}/runtime`, ...asUser(), payload: { state: 'READY' } });
  assert.equal(ready.json().browserRuntime.state, 'READY');

  const denied = await server.inject({ method: 'PATCH', url: `/library/titles/${T1}/runtime`, ...asUser(), payload: { state: 'PREPARING' } });
  assert.equal(denied.statusCode, 400);
  assert.equal(denied.json().error.code, 'INVALID_TRANSITION');
});

test('I. invalid state and illegal transitions are rejected', async (t) => {
  const { server, prisma } = await fixture(t);
  seedTitle(prisma, T1, [archiveItem(ITEM_A, T1)]);

  const badState = await server.inject({ method: 'PATCH', url: `/library/titles/${T1}/runtime`, ...asUser(), payload: { state: 'DONE' } });
  assert.equal(badState.statusCode, 400);
  assert.equal(badState.json().error.code, 'INVALID_STATE');

  const jump = await server.inject({ method: 'PATCH', url: `/library/titles/${T1}/runtime`, ...asUser(), payload: { state: 'READY' } });
  assert.equal(jump.statusCode, 400);
  assert.equal(jump.json().error.code, 'INVALID_TRANSITION');
  assert.equal(jump.json().error.from, 'ARCHIVE_ONLY');
});

test('J. a non-admin cannot change runtime state', async (t) => {
  const { server, prisma } = await fixture(t);
  seedTitle(prisma, T1, [archiveItem(ITEM_A, T1)]);
  const res = await server.inject({ method: 'PATCH', url: `/library/titles/${T1}/runtime`, ...asUser('user-9', 'viewer'), payload: { state: 'REQUESTED' } });
  assert.equal(res.statusCode, 403);
});

test('K/L. archive selection must belong to the Title and must be available to prepare', async (t) => {
  const { server, prisma } = await fixture(t);
  seedTitle(prisma, T1, [archiveItem(ITEM_A, T1)]);
  seedTitle(prisma, T2, [archiveItem(ITEM_OTHER, T2)]);

  const foreign = await server.inject({ method: 'PATCH', url: `/library/titles/${T1}/runtime`, ...asUser(), payload: { state: 'PREPARING', archiveItemId: ITEM_OTHER } });
  assert.equal(foreign.statusCode, 400);
  assert.equal(foreign.json().error.code, 'ARCHIVE_ITEM_MISMATCH');

  const unknown = await server.inject({ method: 'PATCH', url: `/library/titles/${T1}/runtime`, ...asUser(), payload: { state: 'PREPARING', archiveItemId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' } });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().error.code, 'ARCHIVE_ITEM_NOT_FOUND');

  seedTitle(prisma, '33333333-3333-4333-8333-333333333333', [archiveItem(ITEM_B, '33333333-3333-4333-8333-333333333333', false)]);
  const unavailable = await server.inject({ method: 'PATCH', url: `/library/titles/33333333-3333-4333-8333-333333333333/runtime`, ...asUser(), payload: { state: 'PREPARING', archiveItemId: ITEM_B } });
  assert.equal(unavailable.statusCode, 400);
  assert.equal(unavailable.json().error.code, 'ARCHIVE_ITEM_UNAVAILABLE');
});

test('M. a multi-release request chooses no release implicitly', async (t) => {
  const { server, prisma } = await fixture(t);
  seedTitle(prisma, T1, [archiveItem(ITEM_A, T1), archiveItem(ITEM_B, T1, false)]);
  const res = await server.inject({ method: 'POST', url: `/library/titles/${T1}/web-request`, ...asUser() });
  assert.equal(res.json().browserRuntime.state, 'REQUESTED');
  assert.equal(res.json().browserRuntime.archiveItemId, null);
});

test('UNSUPPORTED: a user request is rejected and never reopens the workflow', async (t) => {
  const { server, prisma } = await fixture(t);
  seedTitle(prisma, T1, [archiveItem(ITEM_A, T1)]);
  prisma.runtimes.set(T1, {
    id: 'rt-existing', titleId: T1, state: 'UNSUPPORTED', archiveItemId: ITEM_A,
    note: 'engine unsupported', createdAt: new Date(), updatedAt: new Date(),
  });

  const res = await server.inject({ method: 'POST', url: `/library/titles/${T1}/web-request`, ...asUser() });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'RUNTIME_UNSUPPORTED');

  const runtime = prisma.runtimes.get(T1);
  assert.equal(runtime.state, 'UNSUPPORTED');
  assert.equal(runtime.archiveItemId, ITEM_A);
  assert.equal(runtime.note, 'engine unsupported');
  assert.equal([...prisma.requests.values()].filter((r) => r.titleId === T1).length, 0, 'no misleading request row');
});

test('UNSUPPORTED: an admin can still explicitly reopen to REQUESTED or PREPARING', async (t) => {
  const { server, prisma } = await fixture(t);
  seedTitle(prisma, T1, [archiveItem(ITEM_A, T1)]);
  seedTitle(prisma, T2, [archiveItem(ITEM_B, T2)]);
  prisma.runtimes.set(T1, { id: 'rt1', titleId: T1, state: 'UNSUPPORTED', archiveItemId: null, note: null, createdAt: new Date(), updatedAt: new Date() });
  prisma.runtimes.set(T2, { id: 'rt2', titleId: T2, state: 'UNSUPPORTED', archiveItemId: null, note: null, createdAt: new Date(), updatedAt: new Date() });

  const reopen = await server.inject({ method: 'PATCH', url: `/library/titles/${T1}/runtime`, ...asUser(), payload: { state: 'REQUESTED' } });
  assert.equal(reopen.statusCode, 200);
  assert.equal(reopen.json().browserRuntime.state, 'REQUESTED');

  const prepare = await server.inject({ method: 'PATCH', url: `/library/titles/${T2}/runtime`, ...asUser(), payload: { state: 'PREPARING', archiveItemId: ITEM_B } });
  assert.equal(prepare.statusCode, 200);
  assert.equal(prepare.json().browserRuntime.state, 'PREPARING');
  assert.equal(prepare.json().browserRuntime.archiveItemId, ITEM_B);
});

test('M2. admin picks release B explicitly for a multi-release Title', async (t) => {
  const { server, prisma } = await fixture(t);
  seedTitle(prisma, T1, [archiveItem(ITEM_A, T1, false), archiveItem(ITEM_B, T1, true)]);
  const res = await server.inject({ method: 'PATCH', url: `/library/titles/${T1}/runtime`, ...asUser(), payload: { state: 'PREPARING', archiveItemId: ITEM_B, note: 'release B' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().browserRuntime.archiveItemId, ITEM_B);
  assert.equal(res.json().browserRuntime.note, 'release B');
});

test('malformed Title UUID and unknown Title are handled', async (t) => {
  const { server } = await fixture(t);
  const bad = await server.inject({ method: 'POST', url: '/library/titles/not-a-uuid/web-request', ...asUser() });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, 'INVALID_TITLE_ID');
  const missing = await server.inject({ method: 'POST', url: `/library/titles/${T1}/web-request`, ...asUser() });
  assert.equal(missing.statusCode, 404);
});
