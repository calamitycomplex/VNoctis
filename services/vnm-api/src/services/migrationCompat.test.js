import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GAME_PUBLISH_COLUMNS,
  PUBLISH_FIELDS_MIGRATION,
  deployMigrations,
  ensureGamePublishColumns,
  gameHasAnyPublishColumn,
  gameTableExists,
  isLegacyPublishColumnFailure,
  migrationState,
  publishColumnsMatchSchema,
} from './migrationCompat.js';

const silentLogger = { info() {}, warn() {} };
const schemaRow = (column) => ({
  name: column.name,
  type: column.type,
  notnull: column.notnull,
  dflt_value: column.default,
});
const byName = (name) => schemaRow(GAME_PUBLISH_COLUMNS.find((c) => c.name === name));

function fakePrisma({ columns = [], tableExists = true, migration = null } = {}) {
  const executed = [];
  const rows = [...columns];
  return {
    executed,
    $queryRawUnsafe: async (sql) => {
      if (sql.includes('table_info')) return rows;
      if (sql.includes('sqlite_master')) return tableExists ? [{ name: 'Game' }] : [];
      if (sql.includes('_prisma_migrations')) return migration ? [migration] : [];
      throw new Error(`unexpected sql: ${sql}`);
    },
    $executeRawUnsafe: async (ddl) => {
      executed.push(ddl);
      const match = ddl.match(/ADD COLUMN "([^"]+)"/);
      if (match) {
        rows.push({
          name: match[1],
          type: ddl.includes('DATETIME') ? 'DATETIME' : 'TEXT',
          notnull: ddl.includes('NOT NULL') ? 1 : 0,
          dflt_value: ddl.includes("'not_published'") ? "'not_published'" : null,
        });
      }
    },
  };
}

test('adds every publish column when the Game table has none', async () => {
  const prisma = fakePrisma({ columns: [] });
  const added = await ensureGamePublishColumns(prisma);
  assert.deepEqual(added, ['publishStatus', 'publishedAt', 'publishedVersion']);
  assert.deepEqual(prisma.executed, GAME_PUBLISH_COLUMNS.map(({ ddl }) => ddl));
});

test('adds only the missing publish columns for a partial legacy subset', async () => {
  const prisma = fakePrisma({ columns: [byName('publishStatus'), byName('publishedVersion')] });
  const added = await ensureGamePublishColumns(prisma);
  assert.deepEqual(added, ['publishedAt']);
  assert.equal(prisma.executed.length, 1);
  assert.match(prisma.executed[0], /"publishedAt" DATETIME/);
});

test('is a no-op when all publish columns already exist', async () => {
  const prisma = fakePrisma({
    columns: GAME_PUBLISH_COLUMNS.map((c) => byName(c.name)),
  });
  assert.deepEqual(await ensureGamePublishColumns(prisma), []);
  assert.deepEqual(prisma.executed, []);
});

test('publishColumnsMatchSchema requires exact type, nullability, and default', async () => {
  assert.equal(await publishColumnsMatchSchema(fakePrisma({ columns: GAME_PUBLISH_COLUMNS.map((c) => byName(c.name)) })), true);
  assert.equal(await publishColumnsMatchSchema(fakePrisma({ columns: [] })), false);

  const wrongType = GAME_PUBLISH_COLUMNS.map((c) => byName(c.name));
  wrongType[0] = { ...wrongType[0], type: 'INTEGER' };
  assert.equal(await publishColumnsMatchSchema(fakePrisma({ columns: wrongType })), false);

  const wrongNotNull = GAME_PUBLISH_COLUMNS.map((c) => byName(c.name));
  wrongNotNull[0] = { ...wrongNotNull[0], notnull: 0 };
  assert.equal(await publishColumnsMatchSchema(fakePrisma({ columns: wrongNotNull })), false);

  const wrongDefault = GAME_PUBLISH_COLUMNS.map((c) => byName(c.name));
  wrongDefault[0] = { ...wrongDefault[0], dflt_value: null };
  assert.equal(await publishColumnsMatchSchema(fakePrisma({ columns: wrongDefault })), false);
});

test('gameHasAnyPublishColumn detects partial subsets', async () => {
  assert.equal(await gameHasAnyPublishColumn(fakePrisma({ columns: [] })), false);
  assert.equal(await gameHasAnyPublishColumn(fakePrisma({ columns: [byName('publishedAt')] })), true);
  assert.equal(
    await gameHasAnyPublishColumn(fakePrisma({ columns: [byName('publishStatus'), byName('publishedAt')] })),
    true
  );
});

test('gameTableExists and migrationState report history accurately', async () => {
  assert.equal(await gameTableExists(fakePrisma({ tableExists: false })), false);
  assert.equal(await gameTableExists(fakePrisma({ tableExists: true })), true);

  assert.equal(await migrationState(fakePrisma({ migration: null })), 'pending');
  assert.equal(await migrationState(fakePrisma({ migration: { finished_at: 1, rolled_back_at: null } })), 'applied');
  assert.equal(await migrationState(fakePrisma({ migration: { finished_at: null, rolled_back_at: 2 } })), 'pending');
  assert.equal(await migrationState(fakePrisma({ migration: { finished_at: null, rolled_back_at: null } })), 'failed');
});

test('detects the legacy duplicate-publish-column migration failure', () => {
  const err = Object.assign(new Error('Command failed'), {
    stderr: Buffer.from(
      'Error: P3018\nMigration name: 20260925000000_add_game_publish_fields\n' +
        'Database error: duplicate column name: publishStatus'
    ),
  });
  assert.equal(isLegacyPublishColumnFailure(err), true);
  assert.equal(isLegacyPublishColumnFailure('duplicate column name: publishedAt'), true);
  assert.equal(isLegacyPublishColumnFailure('duplicate column name: someOtherColumn'), false);
  assert.equal(isLegacyPublishColumnFailure('database is locked'), false);
  assert.equal(isLegacyPublishColumnFailure(undefined), false);
});

function recordingExec() {
  const calls = [];
  const exec = (args) => {
    calls.push(args.join(' '));
  };
  return { calls, exec };
}

test('deployMigrations runs a plain deploy on a fresh database (no Game table)', async () => {
  const prisma = fakePrisma({ tableExists: false });
  const { calls, exec } = recordingExec();
  const result = await deployMigrations({ prisma, exec, logger: silentLogger, cwd: '/x', env: {} });
  assert.equal(result.mode, 'fresh');
  assert.equal(result.recovered, false);
  assert.deepEqual(calls, ['prisma migrate deploy']);
});

test('deployMigrations repairs a partial legacy subset before any deploy failure', async () => {
  const prisma = fakePrisma({
    columns: [byName('publishStatus')],
    migration: { finished_at: null, rolled_back_at: null },
  });
  const { calls, exec } = recordingExec();
  const result = await deployMigrations({ prisma, exec, logger: silentLogger, cwd: '/x', env: {} });

  assert.equal(result.recovered, true);
  assert.equal(result.mode, 'legacy-publish-columns');
  assert.deepEqual(result.added, ['publishedAt', 'publishedVersion']);
  // Only the missing columns are altered, then the migration is marked applied.
  assert.equal(prisma.executed.length, 2);
  assert.deepEqual(calls, [
    `prisma migrate resolve --applied ${PUBLISH_FIELDS_MIGRATION}`,
    'prisma migrate deploy',
  ]);
});

test('deployMigrations marks an all-columns legacy database applied without a failed deploy', async () => {
  const prisma = fakePrisma({
    columns: GAME_PUBLISH_COLUMNS.map((c) => byName(c.name)),
    migration: null,
  });
  const { calls, exec } = recordingExec();
  const result = await deployMigrations({ prisma, exec, logger: silentLogger, cwd: '/x', env: {} });

  assert.equal(result.recovered, true);
  assert.deepEqual(result.added, []);
  assert.deepEqual(prisma.executed, []);
  assert.deepEqual(calls, [
    `prisma migrate resolve --applied ${PUBLISH_FIELDS_MIGRATION}`,
    'prisma migrate deploy',
  ]);
});

test('deployMigrations rolls back a failed record when no publish columns landed', async () => {
  const prisma = fakePrisma({
    columns: [],
    migration: { finished_at: null, rolled_back_at: null },
  });
  const { calls, exec } = recordingExec();
  const result = await deployMigrations({ prisma, exec, logger: silentLogger, cwd: '/x', env: {} });

  assert.equal(result.mode, 'retry-failed');
  assert.deepEqual(calls, [
    `prisma migrate resolve --rolled-back ${PUBLISH_FIELDS_MIGRATION}`,
    'prisma migrate deploy',
  ]);
});

test('deployMigrations is a plain deploy when the migration is already applied', async () => {
  const prisma = fakePrisma({
    columns: GAME_PUBLISH_COLUMNS.map((c) => byName(c.name)),
    migration: { finished_at: 1, rolled_back_at: null },
  });
  const { calls, exec } = recordingExec();
  const result = await deployMigrations({ prisma, exec, logger: silentLogger, cwd: '/x', env: {} });

  assert.equal(result.mode, 'up-to-date');
  assert.deepEqual(calls, ['prisma migrate deploy']);
});

test('refuses to mark applied when the repaired shape does not match schema.prisma', async () => {
  // publishStatus pre-existing with the WRONG definition; publishedAt/Version missing.
  const prisma = fakePrisma({
    columns: [{ name: 'publishStatus', type: 'INTEGER', notnull: 0, dflt_value: null }],
    migration: null,
  });
  const { exec } = recordingExec();
  await assert.rejects(
    deployMigrations({ prisma, exec, logger: silentLogger, cwd: '/x', env: {} }),
    /do not match schema\.prisma/
  );
});
