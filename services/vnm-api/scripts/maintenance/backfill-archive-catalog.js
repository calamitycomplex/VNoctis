import { pathToFileURL } from 'node:url';

/**
 * Operator-only maintenance; never import application startup.
 * Prerequisites: migration applied, Prisma Client generated, application writers stopped.
 * DATABASE_URL=file:/absolute/path/to/database.db node scripts/maintenance/backfill-archive-catalog.js --dry-run
 * Replace --dry-run with --apply to write. No flag defaults to dry-run.
 * Reads/writes database records only; does not inspect source paths or files.
 * Conflicts are reported, never repaired automatically. Exit 1 means review is required.
 */
const sourceFields = ['directoryPath', 'directoryName', 'sourceAvailable'];
const gameSelect = {
  id: true, archiveItemId: true, directoryPath: true, directoryName: true,
  sourceAvailable: true, createdAt: true, updatedAt: true,
};

function conflict(code, message) {
  throw Object.assign(new Error(message), { code });
}

export async function backfillArchiveCatalog(prisma, { apply = false, report = () => {} } = {}) {
  const summary = { mapped: 0, wouldMap: 0, skipped: 0, errors: 0 };
  const games = await prisma.game.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
  for (const { id } of games) {
    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
        const game = await tx.game.findUnique({ where: { id }, select: gameSelect });
        if (!game) conflict('GAME_MISSING', 'Game disappeared during backfill; stop concurrent writers.');
        if (game.archiveItemId !== null) {
          const item = await tx.archiveItem.findUnique({ where: { id: game.archiveItemId } });
          if (!item) conflict('ARCHIVE_ITEM_MISSING', `Missing ArchiveItem ${game.archiveItemId}.`);
          const title = await tx.title.findUnique({ where: { id: item.titleId } });
          if (!title) conflict('TITLE_MISSING', `Missing Title ${item.titleId}.`);
          const mismatches = sourceFields.filter((field) => item[field] !== game[field]);
          if (mismatches.length) conflict('INCONSISTENT_MAPPING', `Source fields differ: ${mismatches.join(', ')}.`);
          return { status: 'skipped', archiveItemId: item.id, titleId: title.id };
        }
        const existing = await tx.archiveItem.findUnique({ where: { directoryPath: game.directoryPath } });
        if (existing) {
          conflict('DIRECTORY_PATH_CONFLICT', `ArchiveItem ${existing.id} already occupies this path; possible partial mapping. Manual review required.`);
        }
        if (!apply) return { status: 'wouldMap' };
        const timestamps = { createdAt: game.createdAt, updatedAt: game.updatedAt };
        const title = await tx.title.create({ data: timestamps });
        const item = await tx.archiveItem.create({
          data: {
            titleId: title.id,
            directoryPath: game.directoryPath,
            directoryName: game.directoryName,
            sourceAvailable: game.sourceAvailable,
            ...timestamps,
          },
        });
        await tx.game.update({
          where: { id },
          data: { archiveItemId: item.id, updatedAt: game.updatedAt },
          select: { id: true },
        });
        return { status: 'mapped', archiveItemId: item.id, titleId: title.id };
      });
      summary[result.status]++;
    } catch (error) {
      summary.errors++;
      result = { status: 'error', code: error.code || 'BACKFILL_FAILED', message: error.message };
    }
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
