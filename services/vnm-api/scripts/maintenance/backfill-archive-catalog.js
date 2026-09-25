import { pathToFileURL } from 'node:url';
import { ensureArchiveMapping } from '../../src/services/archiveCatalog.js';

/**
 * Operator-only maintenance; never import application startup.
 * Prerequisites: migration applied, Prisma Client generated, application writers stopped.
 * DATABASE_URL=file:/absolute/path/to/database.db node scripts/maintenance/backfill-archive-catalog.js --dry-run
 * Replace --dry-run with --apply to write. No flag defaults to dry-run.
 * Reads/writes database records only; does not inspect source paths or files.
 * Conflicts are reported, never repaired automatically. Exit 1 means review is required.
 *
 * Mapping rules are shared with the runtime scanner (src/services/archiveCatalog.js),
 * so backfill and discovery produce the same deterministic Title -> ArchiveItem -> Game
 * shape. Orchestration (dry-run, resumability, reporting) stays here.
 */
const gameSelect = {
  id: true, archiveItemId: true, directoryPath: true, directoryName: true,
  sourceAvailable: true, extractedTitle: true, createdAt: true, updatedAt: true,
};

export async function backfillArchiveCatalog(prisma, { apply = false, report = () => {} } = {}) {
  const summary = { mapped: 0, wouldMap: 0, skipped: 0, errors: 0 };
  const games = await prisma.game.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
  for (const { id } of games) {
    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
        const game = await tx.game.findUnique({ where: { id }, select: gameSelect });
        if (!game) {
          return { code: 'GAME_MISSING', message: 'Game disappeared during backfill; stop concurrent writers.' };
        }
        const mapping = await ensureArchiveMapping(tx, game, {
          apply,
          titleName: game.extractedTitle || game.directoryName,
          timestamps: { createdAt: game.createdAt, updatedAt: game.updatedAt },
        });
        if (mapping.status === 'conflict') return { code: mapping.code, message: mapping.message };
        if (mapping.status === 'would-create') return { status: 'wouldMap' };
        return {
          status: mapping.status === 'created' ? 'mapped' : 'skipped',
          archiveItemId: mapping.item?.id,
          titleId: mapping.title?.id,
        };
      });
    } catch (error) {
      summary.errors++;
      report({ gameId: id, status: 'error', code: error.code || 'BACKFILL_FAILED', message: error.message });
      continue;
    }
    if (result.code) summary.errors++;
    else summary[result.status]++;
    report({ gameId: id, ...result });
  }
  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !['--dry-run', '--apply'].includes(args[0]))) {
    throw new Error('Usage: backfill-archive-catalog.js [--dry-run | --apply]');
  }
  const url = process.env.DATABASE_URL;
  if (!url?.startsWith('file:/')) {
    throw new Error('Set DATABASE_URL explicitly to file:/absolute/path/to/database.db.');
  }
  const apply = args[0] === '--apply';
  console.log(
    `[Archive catalog backfill] SQLite target=${JSON.stringify(url)} | ` +
    (apply ? 'APPLY — DATABASE WRITES ENABLED' : 'DRY-RUN — database writes disabled'),
  );
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const summary = await backfillArchiveCatalog(prisma, {
      apply, report: (result) => console.log(JSON.stringify(result)),
    });
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...summary }));
    if (summary.errors) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
