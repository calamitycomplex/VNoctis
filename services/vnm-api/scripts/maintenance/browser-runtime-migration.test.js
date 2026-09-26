import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { PrismaClient } from '@prisma/client';

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const migrationsDir = join(apiRoot, 'prisma', 'migrations');
const schemaPath = join(apiRoot, 'prisma', 'schema.prisma');
const NEW_MIGRATION = '20260925030000_add_browser_runtime';

const BROWSER_RUNTIME_COLUMNS = {
  id: { type: 'TEXT', notnull: 1, dflt: null },
  titleId: { type: 'TEXT', notnull: 1, dflt: null },
  state: { type: 'TEXT', notnull: 1, dflt: "'REQUESTED'" },
  archiveItemId: { type: 'TEXT', notnull: 0, dflt: null },
  note: { type: 'TEXT', notnull: 0, dflt: null },
  createdAt: { type: 'DATETIME', notnull: 1, dflt: 'CURRENT_TIMESTAMP' },
  updatedAt: { type: 'DATETIME', notnull: 1, dflt: null },
};

const WEB_REQUEST_COLUMNS = {
  id: { type: 'TEXT', notnull: 1, dflt: null },
  titleId: { type: 'TEXT', notnull: 1, dflt: null },
  userId: { type: 'TEXT', notnull: 1, dflt: null },
  createdAt: { type: 'DATETIME', notnull: 1, dflt: 'CURRENT_TIMESTAMP' },
};

async function listMigrationDirs() {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && /^\d+_/.test(e.name))
    .map((e) => e.name)
    .sort();
}

async function withTempDb(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'vnm-runtime-migration-'));
  const url = `file:${join(dir, 'vnm.db')}`;
  try {
    return await fn({ dir, url, dbPath: join(dir, 'vnm.db') });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function deploy(url) {
  execFileSync('npx', ['prisma', 'migrate', 'deploy', '--schema', schemaPath], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}

function migrationStatus(url) {
  return execFileSync('npx', ['prisma', 'migrate', 'status', '--schema', schemaPath], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  }).toString();
}

function tableColumns(db, table) {
  return Object.fromEntries(db.prepare(`PRAGMA table_info("${table}")`).all().map((r) => [r.name, r]));
}

function assertColumns(db, table, expected) {
  const cols = tableColumns(db, table);
  for (const [name, shape] of Object.entries(expected)) {
    assert.ok(cols[name], `missing ${table}.${name}`);
    assert.equal(cols[name].type, shape.type, `${table}.${name} type`);
    assert.equal(cols[name].notnull, shape.notnull, `${table}.${name} notnull`);
    assert.equal(cols[name].dflt_value, shape.dflt, `${table}.${name} default`);
  }
}

test('A. migrate from zero creates BrowserRuntime and WebRequest with exact definitions', async () => {
  await withTempDb(async ({ url, dbPath }) => {
    deploy(url);
    const db = new DatabaseSync(dbPath);
    try {
      assertColumns(db, 'BrowserRuntime', BROWSER_RUNTIME_COLUMNS);
      assertColumns(db, 'WebRequest', WEB_REQUEST_COLUMNS);

      const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all().map((r) => r.name);
      assert.ok(indexes.includes('BrowserRuntime_titleId_key'), 'unique Title runtime');
      assert.ok(indexes.includes('WebRequest_titleId_userId_key'), 'unique user request');

      // Existing tables keep their shape (only new tables were added).
      assertColumns(db, 'Title', { id: { type: 'TEXT', notnull: 1, dflt: null } });
      const gameCols = tableColumns(db, 'Game');
      for (const name of ['vndbId', 'vndbTitle', 'coverPath', 'buildStatus', 'archiveItemId']) {
        assert.ok(gameCols[name], `Game column ${name} preserved`);
      }
    } finally {
      db.close();
    }
  });
});

test('B. legacy database keeps rows and relationships while gaining the new tables', async () => {
  await withTempDb(async ({ dbPath }) => {
    const dirs = (await listMigrationDirs()).filter((name) => name !== NEW_MIGRATION);
    const db = new DatabaseSync(dbPath);
    try {
      for (const name of dirs) db.exec(await readFile(join(migrationsDir, name, 'migration.sql'), 'utf8'));

      db.exec(`
        INSERT INTO "User" ("id","username","passwordHash","role","createdAt","updatedAt")
          VALUES ('u-legacy','legacy','hash','viewer',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
        INSERT INTO "Title" ("id","createdAt","updatedAt","name","vndbTitle")
          VALUES ('t-legacy',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'Legacy Title','Legacy VN');
        INSERT INTO "ArchiveItem" ("id","titleId","directoryPath","directoryName","sourceAvailable","createdAt","updatedAt")
          VALUES ('a-legacy','t-legacy','/games/Legacy','Legacy',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
        INSERT INTO "Game" ("id","directoryPath","directoryName","extractedTitle","updatedAt","archiveItemId","vndbId")
          VALUES ('g-legacy','/games/Legacy','Legacy','Legacy Title',CURRENT_TIMESTAMP,'a-legacy','v17');
      `);

      db.exec(await readFile(join(migrationsDir, NEW_MIGRATION, 'migration.sql'), 'utf8'));

      assertColumns(db, 'BrowserRuntime', BROWSER_RUNTIME_COLUMNS);
      assertColumns(db, 'WebRequest', WEB_REQUEST_COLUMNS);

      const title = db.prepare('SELECT * FROM "Title" WHERE id = ?').get('t-legacy');
      assert.equal(title.name, 'Legacy Title');
      assert.equal(title.vndbTitle, 'Legacy VN');
      const game = db.prepare('SELECT * FROM "Game" WHERE id = ?').get('g-legacy');
      assert.equal(game.vndbId, 'v17');
      const joined = db.prepare(
        'SELECT g.id AS gameId FROM "ArchiveItem" i JOIN "Game" g ON g."archiveItemId" = i.id WHERE i.id = ?',
      ).get('a-legacy');
      assert.equal(joined.gameId, 'g-legacy');

      // New tables start empty.
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM "BrowserRuntime"').get().c, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM "WebRequest"').get().c, 0);
    } finally {
      db.close();
    }
  });
});

test('C. migration deploy is idempotent and status stays clean', async () => {
  await withTempDb(async ({ url }) => {
    deploy(url);
    deploy(url);
    assert.match(migrationStatus(url), /up to date|No pending/i);
  });
});

test('D. duplicate (titleId,userId) request is prevented at the database level', async () => {
  await withTempDb(async ({ url, dbPath }) => {
    deploy(url);
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA foreign_keys = ON');
      db.exec(`
        INSERT INTO "User" ("id","username","passwordHash","role","createdAt","updatedAt")
          VALUES ('u1','u1','h','viewer',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
        INSERT INTO "Title" ("id","createdAt","updatedAt") VALUES ('t1',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
        INSERT INTO "WebRequest" ("id","titleId","userId") VALUES ('r1','t1','u1');
      `);
      assert.throws(
        () => db.exec(`INSERT INTO "WebRequest" ("id","titleId","userId") VALUES ('r2','t1','u1')`),
        /UNIQUE|unique/i,
      );
    } finally {
      db.close();
    }
  });
});

test('E. archive item removal nulls the runtime selection; title removal cascades', async () => {
  await withTempDb(async ({ url, dbPath }) => {
    deploy(url);
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA foreign_keys = ON');
      db.exec(`
        INSERT INTO "User" ("id","username","passwordHash","role","createdAt","updatedAt")
          VALUES ('u1','u1','h','viewer',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
        INSERT INTO "Title" ("id","createdAt","updatedAt") VALUES ('t1',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
        INSERT INTO "ArchiveItem" ("id","titleId","directoryPath","directoryName","sourceAvailable","createdAt","updatedAt")
          VALUES ('a1','t1','/games/a','a',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
        INSERT INTO "BrowserRuntime" ("id","titleId","state","archiveItemId","updatedAt")
          VALUES ('rt1','t1','PREPARING','a1',CURRENT_TIMESTAMP);
        INSERT INTO "WebRequest" ("id","titleId","userId") VALUES ('wr1','t1','u1');
      `);
      db.prepare('DELETE FROM "ArchiveItem" WHERE id = ?').run('a1');
      assert.equal(db.prepare('SELECT "archiveItemId" FROM "BrowserRuntime" WHERE id = ?').get('rt1').archiveItemId, null);
      db.prepare('DELETE FROM "Title" WHERE id = ?').run('t1');
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM "BrowserRuntime"').get().c, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM "WebRequest"').get().c, 0);
    } finally {
      db.close();
    }
  });
});

test('F. Prisma end-to-end: runtime + request round-trip on a freshly migrated database', async () => {
  await withTempDb(async ({ url }) => {
    deploy(url);
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    try {
      const user = await prisma.user.create({ data: { username: 'live', passwordHash: 'h', role: 'viewer' } });
      const title = await prisma.title.create({ data: { name: 'Live Title' } });
      const item = await prisma.archiveItem.create({
        data: { titleId: title.id, directoryPath: '/games/Live', directoryName: 'Live', sourceAvailable: true },
      });

      await prisma.webRequest.create({ data: { titleId: title.id, userId: user.id } });
      const runtime = await prisma.browserRuntime.create({
        data: { titleId: title.id, state: 'PREPARING', archiveItemId: item.id, note: 'release A' },
      });
      assert.equal(runtime.state, 'PREPARING');
      assert.equal(runtime.archiveItemId, item.id);

      const loaded = await prisma.title.findUnique({
        where: { id: title.id },
        select: { browserRuntime: true, webRequests: { select: { userId: true } } },
      });
      assert.equal(loaded.browserRuntime.note, 'release A');
      assert.deepEqual(loaded.webRequests, [{ userId: user.id }]);

      await prisma.archiveItem.delete({ where: { id: item.id } });
      const afterDelete = await prisma.browserRuntime.findUnique({ where: { titleId: title.id } });
      assert.equal(afterDelete.archiveItemId, null);
    } finally {
      await prisma.$disconnect();
    }
  });
});
