/**
 * Disposable-database rehearsal for the Prisma migration chain and the
 * publish-column compatibility preflight.
 *
 * Each test creates a throwaway SQLite file under the OS temp dir and runs the
 * real `prisma migrate deploy` against the repository schema/migrations, so the
 * standard chain is exercised exactly as at API startup. No running stack, no
 * /data, and no real database is touched.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { GAME_PUBLISH_COLUMNS, PUBLISH_FIELDS_MIGRATION, deployMigrations } from '../src/services/migrationCompat.js';

const prismaDir = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(prismaDir, '..');
const schemaPath = join(prismaDir, 'schema.prisma');

const silentLogger = { info() {}, warn() {} };
const ALL_COLUMNS = GAME_PUBLISH_COLUMNS.map(({ name }) => name);

function makeDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vnm-migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const url = `file:${join(dir, 'vnm.db')}`;
  return { url, cwd: apiRoot, env: { ...process.env, DATABASE_URL: url } };
}

function deploy(db) {
  execFileSync('npx', ['prisma', 'migrate', 'deploy', '--schema', schemaPath], {
    cwd: db.cwd,
    env: db.env,
  });
}

function client(db) {
  process.env.DATABASE_URL = db.url;
  return new PrismaClient();
}

function runCompat(db, prisma) {
  return deployMigrations({
    prisma,
    exec: (args, options) => execFileSync('npx', args, options),
    logger: silentLogger,
    cwd: db.cwd,
    env: db.env,
    schemaPath,
  });
}

async function columns(prisma) {
  const rows = await prisma.$queryRawUnsafe(`PRAGMA table_info("Game")`);
  return Object.fromEntries(rows.map((row) => [row.name, row]));
}

async function columnShape(prisma) {
  const rows = await columns(prisma);
  return Object.fromEntries(
    ALL_COLUMNS.map((name) => {
      const row = rows[name];
      return [name, row ? { type: row.type, notnull: Number(row.notnull), dflt: row.dflt_value } : null];
    })
  );
}

const EXPECTED_SHAPE = Object.fromEntries(
  GAME_PUBLISH_COLUMNS.map((c) => [c.name, { type: c.type, notnull: c.notnull, dflt: c.default }])
);

const gameId = () => 'a'.repeat(32);
const gameData = (id) => ({
  id,
  directoryPath: `/games/Fixture-${id}`,
  directoryName: `Fixture-${id}`,
  extractedTitle: `Fixture ${id}`,
});

async function historyStats(prisma) {
  // A rolled-back row is intentionally still unfinished; only a row that is
  // neither finished nor rolled back represents a failed migration.
  const failed = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS n FROM "_prisma_migrations"
      WHERE finished_at IS NULL AND rolled_back_at IS NULL`
  );
  const rows = await prisma.$queryRawUnsafe(
    `SELECT finished_at FROM "_prisma_migrations" WHERE migration_name = '${PUBLISH_FIELDS_MIGRATION}'`
  );
  return {
    unfinished: Number(failed[0].n),
    publishMigrationRows: rows.length,
    // The migration must end up applied; a stale rolled-back row may also exist.
    publishMigrationFinished: rows.some((r) => r.finished_at != null),
  };
}

/**
 * Turn a freshly migrated database into a legacy state: create a Game row,
 * drop the publish columns that are not kept (simulating an interrupted legacy
 * raw-ALTER startup), and remove the migration history record.
 */
async function simulateLegacy(prisma, keep) {
  const id = gameId();
  await prisma.game.create({
    data: {
      ...gameData(id),
      publishStatus: 'published',
      publishedAt: new Date('2020-01-01T00:00:00Z'),
      publishedVersion: 'legacy-hash',
    },
  });

  for (const name of ALL_COLUMNS) {
    if (keep.includes(name)) continue;
    await prisma.$executeRawUnsafe(`ALTER TABLE "Game" DROP COLUMN "${name}"`);
  }

  await prisma.$executeRawUnsafe(
    `DELETE FROM "_prisma_migrations" WHERE migration_name = '${PUBLISH_FIELDS_MIGRATION}'`
  );

  return id;
}

async function assertUpgradedAndPreserved(prisma, id, keep, expectedPublishStatus = 'published') {
  assert.deepEqual(await columnShape(prisma), EXPECTED_SHAPE, 'publish columns must match schema.prisma');

  const row = await prisma.game.findUnique({ where: { id } });
  assert.ok(row, 'Game row must survive');
  assert.equal(row.extractedTitle, `Fixture ${id}`);
  assert.equal(row.publishStatus, expectedPublishStatus);
  assert.equal(row.publishedVersion, keep.includes('publishedVersion') ? 'legacy-hash' : null);
  assert.equal(
    row.publishedAt ? row.publishedAt.toISOString() : null,
    keep.includes('publishedAt') ? '2020-01-01T00:00:00.000Z' : null
  );

  const stats = await historyStats(prisma);
  assert.equal(stats.unfinished, 0, 'no failed migration record may remain');
  assert.ok(stats.publishMigrationRows >= 1);
  assert.equal(stats.publishMigrationFinished, true);

  // Rerun must be idempotent.
  assert.deepEqual(await columnShape(prisma), EXPECTED_SHAPE);
}

test('fresh non-R2 database migrated from zero has all three publish columns and is accepted by the client', async (t) => {
  const db = makeDb(t);
  deploy(db);
  const prisma = client(db);
  try {
    assert.deepEqual(await columnShape(prisma), EXPECTED_SHAPE);

    const created = await prisma.game.create({ data: gameData(gameId()) });
    assert.equal(created.publishStatus, 'not_published');

    const read = await prisma.game.findUnique({ where: { id: created.id } });
    assert.equal(read.extractedTitle, created.extractedTitle);
    assert.equal((await historyStats(prisma)).unfinished, 0);
  } finally {
    await prisma.$disconnect();
  }
});

const LEGACY_SUBSETS = [
  { label: 'all three publish columns', keep: ['publishStatus', 'publishedAt', 'publishedVersion'] },
  { label: 'only publishStatus', keep: ['publishStatus'] },
  { label: 'publishStatus + publishedAt', keep: ['publishStatus', 'publishedAt'] },
];

for (const { label, keep } of LEGACY_SUBSETS) {
  test(`legacy database with ${label} upgrades cleanly and preserves data`, async (t) => {
    const db = makeDb(t);
    deploy(db);
    const prisma = client(db);
    try {
      const id = await simulateLegacy(prisma, keep);

      const result = await runCompat(db, prisma);
      assert.equal(result.recovered, true);
      assert.equal(result.mode, 'legacy-publish-columns');

      await assertUpgradedAndPreserved(prisma, id, keep);

      // Second run: already applied, no-op deploy.
      const again = await runCompat(db, prisma);
      assert.equal(again.recovered, false);
      assert.equal(again.mode, 'up-to-date');
      assert.equal((await historyStats(prisma)).unfinished, 0);
    } finally {
      await prisma.$disconnect();
    }
  });
}

test('upgrade from a fully pre-migration database (no publish columns) applies the migration normally', async (t) => {
  const db = makeDb(t);
  deploy(db);
  const prisma = client(db);
  try {
    const id = gameId();
    await prisma.game.create({ data: gameData(id) });

    // Simulate the pre-fix schema: columns absent and the migration unapplied.
    for (const name of ALL_COLUMNS) {
      await prisma.$executeRawUnsafe(`ALTER TABLE "Game" DROP COLUMN "${name}"`);
    }
    await prisma.$executeRawUnsafe(
      `DELETE FROM "_prisma_migrations" WHERE migration_name = '${PUBLISH_FIELDS_MIGRATION}'`
    );

    const result = await runCompat(db, prisma);
    assert.equal(result.mode, 'normal');

    await assertUpgradedAndPreserved(prisma, id, [], 'not_published');
    const stats = await historyStats(prisma);
    assert.equal(stats.unfinished, 0);
    assert.equal(stats.publishMigrationFinished, true);
  } finally {
    await prisma.$disconnect();
  }
});

test('a previously failed migration record with no publish columns is rolled back and re-applied', async (t) => {
  const db = makeDb(t);
  deploy(db);
  const prisma = client(db);
  try {
    const id = gameId();
    await prisma.game.create({ data: gameData(id) });

    for (const name of ALL_COLUMNS) {
      await prisma.$executeRawUnsafe(`ALTER TABLE "Game" DROP COLUMN "${name}"`);
    }
    await prisma.$executeRawUnsafe(
      `DELETE FROM "_prisma_migrations" WHERE migration_name = '${PUBLISH_FIELDS_MIGRATION}'`
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "_prisma_migrations"
         (id, checksum, migration_name, started_at, finished_at, applied_steps_count, logs, rolled_back_at)
       VALUES ('failed-row', 'x', '${PUBLISH_FIELDS_MIGRATION}', current_timestamp, NULL, 0, 'simulated failure', NULL)`
    );

    const result = await runCompat(db, prisma);
    assert.equal(result.mode, 'retry-failed');

    assert.deepEqual(await columnShape(prisma), EXPECTED_SHAPE);
    const row = await prisma.game.findUnique({ where: { id } });
    assert.equal(row.extractedTitle, `Fixture ${id}`);
    assert.equal(row.publishStatus, 'not_published');

    const stats = await historyStats(prisma);
    assert.equal(stats.unfinished, 0);
    assert.equal(stats.publishMigrationFinished, true);
  } finally {
    await prisma.$disconnect();
  }
});

test('a non-recoverable migration failure still throws from deployMigrations', async (t) => {
  const db = makeDb(t);
  const prisma = client(db);
  try {
    await assert.rejects(
      deployMigrations({
        prisma,
        exec: () => {
          const err = new Error('Command failed: database is locked');
          err.stderr = Buffer.from('Error: P3018\nDatabase error: database is locked');
          throw err;
        },
        logger: silentLogger,
        cwd: db.cwd,
        env: db.env,
        schemaPath,
      }),
      /database is locked/
    );
  } finally {
    await prisma.$disconnect();
  }
});
