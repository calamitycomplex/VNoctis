import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { PrismaClient } from '@prisma/client';
import { backfillTitleMetadata } from './backfill-title-metadata.js';

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const migrationsDir = join(apiRoot, 'prisma', 'migrations');
const schemaPath = join(apiRoot, 'prisma', 'schema.prisma');
const NEW_MIGRATION = '20260925020000_add_title_metadata';

/** New Title columns and the exact nullability/default each must have. */
const NEW_TITLE_COLUMNS = {
  vndbId: { type: 'TEXT', notnull: 0, dflt: null },
  vndbTitle: { type: 'TEXT', notnull: 0, dflt: null },
  vndbTitleOriginal: { type: 'TEXT', notnull: 0, dflt: null },
  synopsis: { type: 'TEXT', notnull: 0, dflt: null },
  developer: { type: 'TEXT', notnull: 0, dflt: null },
  releaseDate: { type: 'DATETIME', notnull: 0, dflt: null },
  lengthMinutes: { type: 'INTEGER', notnull: 0, dflt: null },
  vndbRating: { type: 'REAL', notnull: 0, dflt: null },
  coverPath: { type: 'TEXT', notnull: 0, dflt: null },
  tags: { type: 'TEXT', notnull: 1, dflt: "'[]'" },
  screenshots: { type: 'TEXT', notnull: 1, dflt: "'[]'" },
  metadataSource: { type: 'TEXT', notnull: 1, dflt: "'unmatched'" },
  metadataFetchedAt: { type: 'DATETIME', notnull: 0, dflt: null },
};

async function listMigrationDirs() {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && /^\d+_/.test(e.name))
    .map((e) => e.name)
    .sort();
}

async function withTempDb(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'vnm-title-migration-'));
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

function titleColumns(db) {
  const rows = db.prepare('PRAGMA table_info("Title")').all();
  return Object.fromEntries(rows.map((r) => [r.name, r]));
}

function assertNewTitleColumns(db) {
  const cols = titleColumns(db);
  for (const [name, expected] of Object.entries(NEW_TITLE_COLUMNS)) {
    assert.ok(cols[name], `missing Title column ${name}`);
    assert.equal(cols[name].type, expected.type, `${name} type`);
    assert.equal(cols[name].notnull, expected.notnull, `${name} notnull`);
    assert.equal(cols[name].dflt_value, expected.dflt, `${name} default`);
  }
}

test('A. migrate from zero adds every Title metadata column with correct definition', async () => {
  await withTempDb(async ({ url, dbPath }) => {
    deploy(url);
    const db = new DatabaseSync(dbPath);
    try {
      assertNewTitleColumns(db);
      // Pre-existing Title columns are preserved.
      const cols = titleColumns(db);
      for (const name of ['id', 'name', 'createdAt', 'updatedAt']) assert.ok(cols[name], name);
      // Game metadata columns are untouched.
      const gameCols = Object.fromEntries(db.prepare('PRAGMA table_info("Game")').all().map((r) => [r.name, r]));
      for (const name of ['vndbId', 'vndbTitle', 'synopsis', 'developer', 'tags', 'screenshots', 'coverPath']) {
        assert.ok(gameCols[name], `Game column ${name} preserved`);
      }
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM "Title"').get().c, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM "ArchiveItem"').get().c, 0);
    } finally {
      db.close();
    }
  });
});

test('B. legacy database keeps Title/Game rows and relationships while gaining columns', async () => {
  await withTempDb(async ({ url, dbPath }) => {
    const dirs = (await listMigrationDirs()).filter((name) => name !== NEW_MIGRATION);
    const db = new DatabaseSync(dbPath);
    try {
      for (const name of dirs) {
        db.exec(await readFile(join(migrationsDir, name, 'migration.sql'), 'utf8'));
      }

      db.exec(`
        INSERT INTO "Title" ("id","createdAt","updatedAt","name")
          VALUES ('t-legacy', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'Legacy Title');
        INSERT INTO "ArchiveItem" ("id","titleId","directoryPath","directoryName","sourceAvailable","createdAt","updatedAt")
          VALUES ('a-legacy','t-legacy','/games/Legacy Dir','Legacy Dir',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
        INSERT INTO "Game" ("id","directoryPath","directoryName","extractedTitle","updatedAt","archiveItemId","vndbId","vndbTitle")
          VALUES ('g-legacy','/games/Legacy Dir','Legacy Dir','Legacy Title',CURRENT_TIMESTAMP,'a-legacy','v17','Legacy VN');
      `);

      db.exec(await readFile(join(migrationsDir, NEW_MIGRATION, 'migration.sql'), 'utf8'));

      assertNewTitleColumns(db);
      // Rows, relationships, and Game metadata survive.
      const title = db.prepare('SELECT * FROM "Title" WHERE id = ?').get('t-legacy');
      assert.equal(title.name, 'Legacy Title');
      assert.equal(title.metadataSource, 'unmatched');
      assert.equal(title.tags, '[]');
      const game = db.prepare('SELECT * FROM "Game" WHERE id = ?').get('g-legacy');
      assert.equal(game.vndbId, 'v17');
      assert.equal(game.vndbTitle, 'Legacy VN');
      const joined = db.prepare(
        'SELECT i.id AS itemId, g.id AS gameId FROM "ArchiveItem" i JOIN "Game" g ON g."archiveItemId" = i.id WHERE i.id = ?',
      ).get('a-legacy');
      assert.equal(joined.gameId, 'g-legacy');
    } finally {
      db.close();
    }
  });
});

test('C. migration deploy is idempotent and status stays clean', async () => {
  await withTempDb(async ({ url }) => {
    deploy(url);
    deploy(url); // second run must be a clean no-op
    const status = migrationStatus(url);
    assert.match(status, /up to date|No pending/i);
    assert.doesNotMatch(status, /following migration/i);
  });
});

test('D. migration history records the new migration as applied, with no failures', async () => {
  await withTempDb(async ({ url, dbPath }) => {
    deploy(url);
    const db = new DatabaseSync(dbPath);
    try {
      const rows = db.prepare('SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"').all();
      const applied = rows.find((r) => r.migration_name === NEW_MIGRATION);
      assert.ok(applied, 'new migration recorded as applied');
      assert.ok(applied.finished_at, 'migration finished');
      assert.equal(applied.rolled_back_at, null, 'migration not rolled back');
    } finally {
      db.close();
    }
  });
});

test('E. end-to-end backfill against a freshly migrated database is idempotent', async () => {
  await withTempDb(async ({ url }) => {
    deploy(url);
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    try {
      const title = await prisma.title.create({ data: { name: 'Live Title' } });
      const item = await prisma.archiveItem.create({
        data: { titleId: title.id, directoryPath: '/games/Live', directoryName: 'Live', sourceAvailable: true },
      });
      await prisma.game.create({
        data: {
          id: 'f'.repeat(32), directoryPath: '/games/Live', directoryName: 'Live',
          extractedTitle: 'Live Title', archiveItemId: item.id,
          vndbId: 'v42', vndbTitle: 'Live VN', synopsis: 'Live synopsis',
          developer: 'Live Dev', tags: '["Tag"]', screenshots: '["s.jpg"]',
          coverPath: '/covers/legacy.jpg', metadataSource: 'auto', metadataFetchedAt: new Date('2024-03-01T00:00:00Z'),
        },
      });

      await backfillTitleMetadata(prisma, { apply: true });
      const afterFirst = await prisma.title.findUnique({ where: { id: title.id } });
      assert.equal(afterFirst.vndbId, 'v42');
      assert.equal(afterFirst.vndbTitle, 'Live VN');
      assert.equal(afterFirst.synopsis, 'Live synopsis');
      assert.equal(afterFirst.coverPath, '/covers/legacy.jpg');
      assert.deepEqual(JSON.parse(afterFirst.tags), ['Tag']);
      assert.equal(afterFirst.metadataSource, 'auto');

      const game = await prisma.game.findUnique({ where: { id: 'f'.repeat(32) } });
      assert.equal(game.vndbTitle, 'Live VN');
      assert.equal(game.tags, '["Tag"]');

      const beforeSecond = { ...afterFirst };
      const summary = await backfillTitleMetadata(prisma, { apply: true });
      const afterSecond = await prisma.title.findUnique({ where: { id: title.id } });
      assert.equal(summary.fieldsPopulated, 0);
      assert.equal(afterSecond.updatedAt.getTime(), beforeSecond.updatedAt.getTime());
    } finally {
      await prisma.$disconnect();
    }
  });
});
