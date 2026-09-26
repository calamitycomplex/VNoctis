/**
 * Disposable-database rehearsal for the BrowserSession launch-foundation model.
 *
 * Verifies the additive migration chain on a fresh database, that an existing
 * database survives a re-deploy with BrowserRuntime.manifestId preserved, and
 * that the nullable unique `activeKey` guard enforces at most one active session
 * per app user while allowing ended rows and different users.
 *
 * Uses a throwaway SQLite file under the OS temp dir. No live /data is touched.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { prismaSessionStore } from './runtimeTarget.js';

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(here, '..', '..');
const schemaPath = join(apiRoot, 'prisma', 'schema.prisma');

function makeDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vnm-bsess-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const url = `file:${join(dir, 'vnm.db')}`;
  return { url, env: { ...process.env, DATABASE_URL: url } };
}

function deploy(db) {
  execFileSync('npx', ['prisma', 'migrate', 'deploy', '--schema', schemaPath], { cwd: apiRoot, env: db.env });
}

function client(db) {
  process.env.DATABASE_URL = db.url;
  return new PrismaClient();
}

async function seedRuntime(prisma, suffix) {
  const user = await prisma.user.create({ data: { username: `u-${suffix}`, passwordHash: 'x' } });
  const title = await prisma.title.create({ data: { name: `Title ${suffix}` } });
  const runtime = await prisma.browserRuntime.create({
    data: { titleId: title.id, state: 'READY', manifestId: `manifest-${suffix}` },
  });
  return { user, title, runtime };
}

test('fresh database gains BrowserSession + BrowserRuntime.manifestId', async (t) => {
  const db = makeDb(t);
  deploy(db);
  const prisma = client(db);
  t.after(() => prisma.$disconnect());

  const cols = await prisma.$queryRawUnsafe(`PRAGMA table_info("BrowserSession")`);
  const names = cols.map((c) => c.name).sort();
  assert.deepEqual(names, [
    'activeKey', 'browserRuntimeId', 'createdAt', 'endedAt', 'id', 'kasmSessionId',
    'lastSeenAt', 'state', 'updatedAt', 'userId',
  ]);

  const runtimeCols = await prisma.$queryRawUnsafe(`PRAGMA table_info("BrowserRuntime")`);
  assert.ok(runtimeCols.some((c) => c.name === 'manifestId'));

  const { user, runtime } = await seedRuntime(prisma, 'a');
  const session = await prisma.browserSession.create({
    data: { browserRuntimeId: runtime.id, userId: user.id, activeKey: user.id, state: 'STARTING' },
  });
  assert.equal(session.state, 'STARTING');

  const userCols = await prisma.$queryRawUnsafe(`PRAGMA table_info("User")`);
  assert.ok(userCols.some((c) => c.name === 'kasmUsername'));
  assert.ok(userCols.some((c) => c.name === 'kasmUserId'));
});

test('activeKey guard blocks a duplicate active session, allows ended rows', async (t) => {
  const db = makeDb(t);
  deploy(db);
  const prisma = client(db);
  t.after(() => prisma.$disconnect());

  const { user, runtime } = await seedRuntime(prisma, 'b');
  const activeKey = user.id;
  await prisma.browserSession.create({ data: { browserRuntimeId: runtime.id, userId: user.id, activeKey, state: 'RUNNING' } });

  await assert.rejects(
    prisma.browserSession.create({ data: { browserRuntimeId: runtime.id, userId: user.id, activeKey, state: 'STARTING' } }),
  );

  // Ended rows clear activeKey to NULL; SQLite treats NULLs as distinct.
  await prisma.browserSession.create({ data: { browserRuntimeId: runtime.id, userId: user.id, activeKey: null, state: 'ENDED' } });
  await prisma.browserSession.create({ data: { browserRuntimeId: runtime.id, userId: user.id, activeKey: null, state: 'ENDED' } });
  const ended = await prisma.browserSession.count({ where: { browserRuntimeId: runtime.id, userId: user.id, activeKey: null } });
  assert.equal(ended, 2);
});

test('same user cannot hold two active sessions across different runtimes', async (t) => {
  const db = makeDb(t);
  deploy(db);
  const prisma = client(db);
  t.after(() => prisma.$disconnect());

  const { user, runtime: runtimeB } = await seedRuntime(prisma, 'c');
  await prisma.browserSession.create({
    data: { browserRuntimeId: runtimeB.id, userId: user.id, activeKey: user.id, state: 'RUNNING' },
  });

  // A second, DIFFERENT runtime for the same user must be rejected while the
  // first is active — this is what keeps custom_attribute_2 stable in Kasm.
  const titleC = await prisma.title.create({ data: { name: 'Title c2' } });
  const runtimeC = await prisma.browserRuntime.create({ data: { titleId: titleC.id, state: 'READY' } });
  await assert.rejects(
    prisma.browserSession.create({ data: { browserRuntimeId: runtimeC.id, userId: user.id, activeKey: user.id, state: 'STARTING' } }),
  );
});

test('different users may run the same runtime concurrently', async (t) => {
  const db = makeDb(t);
  deploy(db);
  const prisma = client(db);
  t.after(() => prisma.$disconnect());

  const { user, runtime } = await seedRuntime(prisma, 'd');
  const userB = await prisma.user.create({ data: { username: 'u-d2', passwordHash: 'x' } });
  await prisma.browserSession.create({
    data: { browserRuntimeId: runtime.id, userId: user.id, activeKey: user.id, state: 'RUNNING' },
  });
  // Same runtime row, second user — allowed because each user has its own
  // dedicated Kasm identity and activeKey namespace.
  await prisma.browserSession.create({
    data: { browserRuntimeId: runtime.id, userId: userB.id, activeKey: userB.id, state: 'RUNNING' },
  });
  const sessions = await prisma.browserSession.count({ where: { browserRuntimeId: runtime.id } });
  assert.equal(sessions, 2);
});

test('prismaSessionStore reserve/markFailed maps to the ACTIVE_SESSION_EXISTS guard', async (t) => {
  const db = makeDb(t);
  deploy(db);
  const prisma = client(db);
  t.after(() => prisma.$disconnect());

  const { user, runtime } = await seedRuntime(prisma, 'e');
  const store = prismaSessionStore(prisma);

  const first = await store.reserve({ browserRuntimeId: runtime.id, userId: user.id });
  await assert.rejects(
    store.reserve({ browserRuntimeId: runtime.id, userId: user.id }),
    (e) => e.code === 'ACTIVE_SESSION_EXISTS',
  );

  await store.markStarted(first.id, 'ks-1');
  const running = await prisma.browserSession.findUnique({ where: { id: first.id } });
  assert.equal(running.state, 'RUNNING');
  assert.equal(running.kasmSessionId, 'ks-1');

  // Failing/releasing clears activeKey so a retry for the same user succeeds.
  await store.markFailed(first.id);
  const failed = await prisma.browserSession.findUnique({ where: { id: first.id } });
  assert.equal(failed.state, 'ERROR');
  assert.equal(failed.activeKey, null);
  const retry = await store.reserve({ browserRuntimeId: runtime.id, userId: user.id });
  assert.ok(retry.id);
});

test('existing database survives a re-deploy with manifestId preserved', async (t) => {
  const db = makeDb(t);
  deploy(db);
  const prisma = client(db);
  t.after(() => prisma.$disconnect());

  const { runtime } = await seedRuntime(prisma, 'd');
  await prisma.$disconnect();

  // Idempotent re-deploy must not error or rebuild data.
  deploy(db);

  const again = client(db);
  t.after(() => again.$disconnect());
  const reread = await again.browserRuntime.findUnique({ where: { id: runtime.id } });
  assert.equal(reread.manifestId, 'manifest-d');
  const table = await again.$queryRawUnsafe(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='BrowserSession'`,
  );
  assert.equal(table.length, 1);
});
