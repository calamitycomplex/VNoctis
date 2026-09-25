/**
 * Migration/runtime compatibility helpers for the Game publish columns.
 *
 * `publishStatus`, `publishedAt`, and `publishedVersion` are declared in
 * schema.prisma and expected by the Prisma Client. Historically they were added
 * at runtime only when `VNM_R2_MODE=true`, so a fresh non-R2 database lacked
 * them. They are created by the standard additive migration
 * `20260925000000_add_game_publish_fields`.
 *
 * SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so a legacy database
 * that already has ANY publish column would fail that migration with a
 * duplicate-column error. A legacy database can also have only a SUBSET of the
 * columns if an older raw-ALTER startup was interrupted between statements.
 *
 * Before running `prisma migrate deploy`, this module detects that situation and
 * repairs it without rebuilding Game:
 *   - Game exists, the migration is not applied, and at least one publish column
 *     is present  -> add only the missing columns, verify all three now match
 *     schema.prisma, mark the migration applied, then deploy the rest;
 *   - a previous attempt left this migration in a failed state and no publish
 *     columns exist -> roll the failed record back so deploy re-runs it;
 *   - otherwise -> plain deploy (fresh database, or normal additive migration).
 *
 * There is no table rebuild and no data loss. A duplicate-column failure during
 * deploy is still handled as a defensive fallback, but the preflight normally
 * avoids ever creating a failed migration record.
 */

export const PUBLISH_FIELDS_MIGRATION = '20260925000000_add_game_publish_fields';

/**
 * Legacy publish columns with their additive DDL and the exact shape they must
 * have to match schema.prisma.
 */
export const GAME_PUBLISH_COLUMNS = [
  {
    name: 'publishStatus',
    type: 'TEXT',
    notnull: 1,
    default: "'not_published'",
    ddl: `ALTER TABLE "Game" ADD COLUMN "publishStatus" TEXT NOT NULL DEFAULT 'not_published'`,
  },
  {
    name: 'publishedAt',
    type: 'DATETIME',
    notnull: 0,
    default: null,
    ddl: `ALTER TABLE "Game" ADD COLUMN "publishedAt" DATETIME`,
  },
  {
    name: 'publishedVersion',
    type: 'TEXT',
    notnull: 0,
    default: null,
    ddl: `ALTER TABLE "Game" ADD COLUMN "publishedVersion" TEXT`,
  },
];

const PUBLISH_COLUMN_NAMES = GAME_PUBLISH_COLUMNS.map(({ name }) => name);

/**
 * Return the set of column names currently on the Game table.
 *
 * Uses raw SQL so it works even when the Prisma Client expects columns the
 * database does not yet have.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<Set<string>>}
 */
export async function gameColumnNames(prisma) {
  const rows = await prisma.$queryRawUnsafe(`PRAGMA table_info("Game")`);
  return new Set(rows.map((row) => row.name));
}

/**
 * True when the Game table exists.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<boolean>}
 */
export async function gameTableExists(prisma) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'Game'`
  );
  return rows.length > 0;
}

/**
 * True when every publish column is present and matches schema.prisma.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<boolean>}
 */
export async function publishColumnsMatchSchema(prisma) {
  const rows = await prisma.$queryRawUnsafe(`PRAGMA table_info("Game")`);
  const byName = new Map(rows.map((row) => [row.name, row]));

  for (const column of GAME_PUBLISH_COLUMNS) {
    const row = byName.get(column.name);
    if (!row) return false;
    if (String(row.type).toUpperCase() !== column.type) return false;
    if (Number(row.notnull) !== column.notnull) return false;
    const dflt = row.dflt_value == null ? null : String(row.dflt_value);
    if (dflt !== column.default) return false;
  }

  return true;
}

/**
 * True when the Game table already has all three publish columns.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<boolean>}
 */
export async function gameHasPublishColumns(prisma) {
  return publishColumnsMatchSchema(prisma);
}

/**
 * True when Game has at least one (but not necessarily all) publish column.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<boolean>}
 */
export async function gameHasAnyPublishColumn(prisma) {
  const existing = await gameColumnNames(prisma);
  return PUBLISH_COLUMN_NAMES.some((name) => existing.has(name));
}

/**
 * Add any publish columns that are actually missing (idempotent, no rebuild).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<string[]>} names of columns added
 */
export async function ensureGamePublishColumns(prisma) {
  const existing = await gameColumnNames(prisma);
  const added = [];

  for (const { name, ddl } of GAME_PUBLISH_COLUMNS) {
    if (existing.has(name)) continue;
    try {
      await prisma.$executeRawUnsafe(ddl);
      added.push(name);
    } catch {
      // Lost a race with another startup or migration: column now exists.
    }
  }

  return added;
}

/**
 * Whether a failed `prisma migrate deploy` is the legacy duplicate-column case
 * for the publish fields. Accepts a string or an Error (uses stdout/stderr).
 *
 * @param {Error|string} error
 * @returns {boolean}
 */
export function isLegacyPublishColumnFailure(error) {
  const output = [
    typeof error === 'string' ? error : error?.stdout,
    typeof error === 'string' ? '' : error?.stderr,
    typeof error === 'string' ? '' : error?.message,
  ]
    .filter(Boolean)
    .map(String)
    .join('\n');

  if (!/duplicate column name/i.test(output)) return false;
  return PUBLISH_COLUMN_NAMES.some((name) => output.includes(name));
}

/**
 * Migration history state for the publish-fields migration.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} name
 * @returns {Promise<'applied'|'failed'|'pending'>}
 */
export async function migrationState(prisma, name = PUBLISH_FIELDS_MIGRATION) {
  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT finished_at, rolled_back_at
         FROM "_prisma_migrations"
        WHERE migration_name = '${name}'
        ORDER BY started_at DESC
        LIMIT 1`
    );
  } catch {
    // No migrations table yet — treat as pending (deploy will create it).
    return 'pending';
  }

  const row = rows[0];
  if (!row) return 'pending';
  if (row.finished_at != null) return 'applied';
  if (row.rolled_back_at != null) return 'pending';
  return 'failed';
}

/**
 * Run `prisma migrate deploy`, repairing legacy publish-column states first.
 *
 * `exec` is invoked as `exec(args, options)` and must return/throw like
 * `child_process.execFileSync('npx', args, options)`.
 *
 * @param {{
 *   prisma: import('@prisma/client').PrismaClient,
 *   exec: (args: string[], options: object) => unknown,
 *   logger?: { info?: Function, warn?: Function },
 *   cwd: string,
 *   env: NodeJS.ProcessEnv,
 *   schemaPath?: string,
 * }} params
 * @returns {Promise<{ recovered: boolean, mode: string, added: string[] }>}
 */
export async function deployMigrations({
  prisma,
  exec,
  logger,
  cwd,
  env,
  schemaPath,
}) {
  const schemaArgs = schemaPath ? ['--schema', schemaPath] : [];
  const options = { cwd, env };

  const runDeploy = () => exec(['prisma', 'migrate', 'deploy', ...schemaArgs], options);
  const resolveApplied = () =>
    exec(['prisma', 'migrate', 'resolve', '--applied', PUBLISH_FIELDS_MIGRATION, ...schemaArgs], options);
  const resolveRolledBack = () =>
    exec(['prisma', 'migrate', 'resolve', '--rolled-back', PUBLISH_FIELDS_MIGRATION, ...schemaArgs], options);

  // Defensive fallback: only reached if the preflight could not classify the
  // state. Marking applied is safe only once the columns match schema.prisma.
  const applyMigration = async () => {
    try {
      runDeploy();
    } catch (err) {
      if (!isLegacyPublishColumnFailure(err) || !(await publishColumnsMatchSchema(prisma))) {
        throw err;
      }
      logger?.warn?.('Duplicate publish-column migration error — recovering without rebuild');
      resolveApplied();
      runDeploy();
    }
  };

  if (!(await gameTableExists(prisma))) {
    await applyMigration();
    return { recovered: false, mode: 'fresh', added: [] };
  }

  const state = await migrationState(prisma);
  if (state === 'applied') {
    await applyMigration();
    return { recovered: false, mode: 'up-to-date', added: [] };
  }

  const hasAnyPublishColumn = await gameHasAnyPublishColumn(prisma);

  if (hasAnyPublishColumn) {
    // Partial or full legacy state: add what is missing, prove the shape, then
    // mark this migration applied so deploy never hits a duplicate-column error.
    const added = await ensureGamePublishColumns(prisma);

    if (!(await publishColumnsMatchSchema(prisma))) {
      throw new Error(
        `Game publish columns exist but do not match schema.prisma after repair ` +
          `(added: ${added.join(', ') || 'none'}); refusing to mark ${PUBLISH_FIELDS_MIGRATION} applied`
      );
    }

    logger?.warn?.(
      { added },
      'Legacy publish columns already present — repaired missing columns and marked migration applied'
    );
    resolveApplied();
    await applyMigration();
    return { recovered: true, mode: 'legacy-publish-columns', added };
  }

  if (state === 'failed') {
    // A previous interrupted attempt failed this migration while no publish
    // columns landed: roll the failed record back so deploy re-runs it.
    logger?.warn?.('Retrying previously failed publish-fields migration');
    resolveRolledBack();
    await applyMigration();
    return { recovered: false, mode: 'retry-failed', added: [] };
  }

  await applyMigration();
  return { recovered: false, mode: 'normal', added: [] };
}
