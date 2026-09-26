/**
 * Focused tests for race-safe Kasm launch-target selection.
 *
 * Verifies the invariants that make the per-user Kasm identity design correct:
 * target selection cannot cross app-user IDs or runtime IDs, same-user launches
 * serialize, and different users launch concurrently on separate identities.
 *
 * The Kasm client is fully mocked; no live Kasm call is made.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LaunchTargetError,
  createLockRegistry,
  deriveKasmUsername,
  ensureKasmIdentity,
  launchBrowserSession,
} from './runtimeTarget.js';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const RX = 'aaaaaaaa-1111-1111-1111-111111111111';
const RY = 'bbbbbbbb-2222-2222-2222-222222222222';

const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeKasm() {
  const calls = [];
  const usersByName = new Map();
  let seq = 0;
  return {
    calls,
    usersByName,
    async findUserByUsername(username) {
      calls.push(['find', username]);
      return usersByName.get(username) ?? null;
    },
    async createUser({ username }) {
      const user_id = `ku-${++seq}`;
      const user = { user_id, username };
      usersByName.set(username, user);
      calls.push(['create', username]);
      return user;
    },
    async setRuntimeTarget({ kasmUserId, appUserId, browserRuntimeId }) {
      calls.push(['set', { kasmUserId, appUserId, browserRuntimeId }]);
      await tick();
    },
    async requestSession({ userId }) {
      calls.push(['request', { userId }]);
      await tick();
      return { kasm_id: `ks-${++seq}` };
    },
  };
}

test('deriveKasmUsername is deterministic and rejects non-UUIDs', () => {
  assert.equal(deriveKasmUsername(A), `vnoctis-${A}`);
  assert.equal(deriveKasmUsername(A), deriveKasmUsername(A));
  assert.throws(() => deriveKasmUsername('not-a-uuid'), (e) => e.code === 'INVALID_USER_ID');
});

test('lock registry serializes per key and parallelizes distinct keys', async () => {
  const locks = createLockRegistry();
  const order = [];
  const slow = (name, ms) => locks.run('k', async () => {
    order.push(`start-${name}`);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`end-${name}`);
  });
  await Promise.all([slow('a', 20), slow('b', 1)]);
  assert.deepEqual(order, ['start-a', 'end-a', 'start-b', 'end-b']);

  const parallelOrder = [];
  const locks2 = createLockRegistry();
  const p1 = locks2.run('x', async () => { await new Promise((r) => setTimeout(r, 20)); parallelOrder.push('x'); });
  const p2 = locks2.run('y', async () => { await new Promise((r) => setTimeout(r, 1)); parallelOrder.push('y'); });
  await Promise.all([p1, p2]);
  assert.deepEqual(parallelOrder, ['y', 'x']);
});

test('ensureKasmIdentity reuses a DB identity or finds an existing Kasm user', async () => {
  const k = fakeKasm();
  k.usersByName.set(`vnoctis-${A}`, { user_id: 'ku-known', username: `vnoctis-${A}` });

  const reused = await ensureKasmIdentity({ appUserId: A, client: k, existing: { kasmUserId: 'ku-db', kasmUsername: 'vnoctis-db' } });
  assert.equal(reused.kasmUserId, 'ku-db');
  assert.equal(reused.created, false);

  const found = await ensureKasmIdentity({ appUserId: A, client: k });
  assert.equal(found.kasmUserId, 'ku-known');
  assert.equal(found.created, false);

  const created = await ensureKasmIdentity({ appUserId: B, client: k });
  assert.equal(created.kasmUsername, `vnoctis-${B}`);
  assert.equal(created.created, true);
  assert.ok(created.kasmUserId);
});

test('launchBrowserSession sets the target then requests, on the user identity', async () => {
  const k = fakeKasm();
  const { kasmUserId, request } = await launchBrowserSession({ userId: A, browserRuntimeId: RX, client: k });

  const set = k.calls.find((c) => c[0] === 'set')[1];
  assert.equal(set.appUserId, A);
  assert.equal(set.browserRuntimeId, RX);
  assert.equal(set.kasmUserId, kasmUserId);

  const requestCall = k.calls.find((c) => c[0] === 'request')[1];
  assert.equal(requestCall.userId, kasmUserId);
  assert.ok(request.kasm_id);
  // Ordering: set must precede request.
  assert.ok(k.calls.findIndex((c) => c[0] === 'set') < k.calls.findIndex((c) => c[0] === 'request'));
});

test('target selection cannot cross app-user IDs', async () => {
  const k = fakeKasm();
  const [a, b] = await Promise.all([
    launchBrowserSession({ userId: A, browserRuntimeId: RX, client: k }),
    launchBrowserSession({ userId: B, browserRuntimeId: RY, client: k }),
  ]);

  assert.notEqual(a.kasmUserId, b.kasmUserId); // dedicated identities
  const byRuntime = new Map(k.calls.filter((c) => c[0] === 'set').map((c) => [c[1].browserRuntimeId, c[1]]));
  assert.equal(byRuntime.get(RX).appUserId, A);
  assert.equal(byRuntime.get(RY).appUserId, B);
});

test('target selection cannot cross runtime IDs under same-user concurrency', async () => {
  const k = fakeKasm();
  await Promise.all([
    launchBrowserSession({ userId: A, browserRuntimeId: RX, client: k }),
    launchBrowserSession({ userId: A, browserRuntimeId: RY, client: k }),
  ]);

  // Serialized: every set is immediately followed by its matching request.
  const seq = k.calls.filter((c) => c[0] === 'set' || c[0] === 'request');
  const runtimes = seq.filter((c) => c[0] === 'set').map((c) => c[1].browserRuntimeId);
  assert.deepEqual(runtimes, [RX, RY]);
  for (let i = 0; i < seq.length; i += 2) {
    assert.equal(seq[i][0], 'set');
    assert.equal(seq[i + 1][0], 'request');
    assert.equal(seq[i][1].kasmUserId, seq[i + 1][1].userId);
  }
});

test('invalid ids are rejected before any Kasm call', async () => {
  const k = fakeKasm();
  await assert.rejects(launchBrowserSession({ userId: 'nope', browserRuntimeId: RX, client: k }), (e) => e.code === 'INVALID_USER_ID');
  await assert.rejects(launchBrowserSession({ userId: A, browserRuntimeId: 'nope', client: k }), (e) => e.code === 'INVALID_RUNTIME_ID');
  assert.equal(k.calls.length, 0);
});

test('persistIdentity is only called when a new Kasm identity is created', async () => {
  const k = fakeKasm();
  const seen = [];
  await launchBrowserSession({ userId: A, browserRuntimeId: RX, client: k, persistIdentity: async (id) => seen.push(id) });
  await launchBrowserSession({
    userId: A,
    browserRuntimeId: RX,
    client: k,
    existingIdentity: { kasmUserId: 'ku-db', kasmUsername: `vnoctis-${A}` },
    persistIdentity: async (id) => seen.push(id),
  });
  assert.equal(seen.length, 1);
});

test('LaunchTargetError carries a stable code', () => {
  const e = new LaunchTargetError('ACTIVE_SESSION_EXISTS', 'busy');
  assert.equal(e.code, 'ACTIVE_SESSION_EXISTS');
  assert.equal(e.name, 'LaunchTargetError');
});
