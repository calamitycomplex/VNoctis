import { pathToFileURL } from 'node:url';

/**
 * Operator-only maintenance: copy logical VN metadata from legacy Game rows up
 * to the authoritative Title row. Never imported by application startup.
 *
 * Prerequisites: migration applied, Prisma Client generated, application
 * writers stopped.
 *
 *   DATABASE_URL=file:/absolute/path/to/database.db \
 *     node scripts/maintenance/backfill-title-metadata.js --dry-run
 *
 * Replace --dry-run with --apply to write. No flag defaults to dry-run.
 *
 * Guarantees:
 *   - dry-run by default; --apply required for writes
 *   - idempotent: already-populated Title fields are never overwritten
 *   - Game rows are never modified (Title writes only)
 *   - no filesystem access, no downloads, no VNDB/Steam calls
 *   - ArchiveItem rows and Title.name are never modified
 *   - VNDB identity conflicts are hard: competing vndbId values block all
 *     automatic logical consolidation for that Title
 *
 * Reads/writes database records only. Conflicts are reported, never repaired.
 */

/** Logical fields copied from Game to Title (vndbId handled separately). */
export const LOGICAL_FIELDS = [
  'vndbTitle',
  'vndbTitleOriginal',
  'synopsis',
  'developer',
  'releaseDate',
  'lengthMinutes',
  'vndbRating',
  'coverPath',
  'tags',
  'screenshots',
];

/** Game fields stored as JSON strings whose semantics are arrays. */
const JSON_FIELDS = new Set(['tags', 'screenshots']);

/** Default metadataSource is treated as "not yet meaningfully populated". */
const EMPTY_METADATA_SOURCE = 'unmatched';

const TITLE_SELECT = {
  id: true,
  vndbId: true,
  vndbTitle: true,
  vndbTitleOriginal: true,
  synopsis: true,
  developer: true,
  releaseDate: true,
  lengthMinutes: true,
  vndbRating: true,
  coverPath: true,
  tags: true,
  screenshots: true,
  metadataSource: true,
  metadataFetchedAt: true,
  archiveItems: {
    select: {
      id: true,
      directoryName: true,
      game: {
        select: {
          id: true,
          vndbId: true,
          vndbTitle: true,
          vndbTitleOriginal: true,
          synopsis: true,
          developer: true,
          releaseDate: true,
          lengthMinutes: true,
          vndbRating: true,
          coverPath: true,
          tags: true,
          screenshots: true,
          metadataSource: true,
          metadataFetchedAt: true,
        },
      },
    },
  },
};

/** Parse a tags/screenshots JSON string into an array, without throwing. */
function parseJsonArray(raw) {
  if (Array.isArray(raw)) return { ok: true, value: raw };
  if (typeof raw !== 'string') return { ok: false };
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? { ok: true, value: parsed } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** A value is present when it is not null/undefined and not a blank string. */
function isPresent(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

/** A scalar value is meaningful when present and, for JSON fields, non-empty. */
function isMeaningful(field, value) {
  if (!isPresent(value)) return false;
  if (JSON_FIELDS.has(field)) {
    const parsed = parseJsonArray(value);
    return parsed.ok && parsed.value.length > 0;
  }
  return true;
}

/** Comparison key for consensus detection; JSON arrays compared structurally. */
function comparableKey(field, value) {
  if (JSON_FIELDS.has(field)) {
    const parsed = parseJsonArray(value);
    return parsed.ok ? JSON.stringify(parsed.value) : null;
  }
  return value instanceof Date ? value.getTime() : String(value);
}

/** Persist a chosen value using the same representation convention as Game. */
function storedValue(field, value) {
  if (JSON_FIELDS.has(field)) return JSON.stringify(value);
  return value;
}

/** timestamp comparison key. */
function timeKey(value) {
  return new Date(value).getTime();
}

function conflictEntry({ titleId, itemId, gameId, field, values, metadataSource, reason, contributors }) {
  return {
    titleId, archiveItemId: itemId ?? null, gameId: gameId ?? null, field,
    values, metadataSource: metadataSource ?? null, reason,
    contributors: contributors ?? null,
  };
}

/**
 * Backfill Title logical metadata from its ArchiveItems' compatibility Games.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{apply?: boolean, report?: Function}} [options]
 * @returns {Promise<object>} structured summary
 */
export async function backfillTitleMetadata(prisma, { apply = false, report = () => {} } = {}) {
  const summary = {
    titlesInspected: 0, titlesUpdated: 0, titlesWouldUpdate: 0, titlesSkipped: 0,
    titlesWithoutMetadata: 0, fieldsPopulated: 0, conflicts: 0, malformedValues: 0,
  };

  const titles = await prisma.title.findMany({ select: { id: true }, orderBy: { id: 'asc' } });

  for (const { id } of titles) {
    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
        const title = await tx.title.findUnique({ where: { id }, select: TITLE_SELECT });
        if (!title) return { status: 'missing' };

        const linked = title.archiveItems
          .filter((item) => item.game)
          .map((item) => ({ itemId: item.id, game: item.game }));

        if (linked.length === 0) return { status: 'no-metadata' };

        const anyMeaningful = linked.some(({ game }) =>
          LOGICAL_FIELDS.some((field) => isMeaningful(field, game[field])) || isMeaningful('vndbId', game.vndbId));
        if (!anyMeaningful) return { status: 'no-metadata' };

        const conflicts = [];
        const malformed = [];
        const update = {};
        const adoptedSources = new Set();
        let identityEstablished = false;

        // ── vndbId identity: the hard safety rule ───────────────
        const withVndb = linked.filter(({ game }) => isMeaningful('vndbId', game.vndbId));
        const titleHasVndb = isMeaningful('vndbId', title.vndbId);
        let identityOk = true;

        if (titleHasVndb) {
          const mismatched = withVndb.filter(({ game }) => game.vndbId !== title.vndbId);
          if (mismatched.length > 0) {
            identityOk = false;
            conflicts.push(conflictEntry({
              titleId: id, field: 'vndbId',
              values: [...new Set([title.vndbId, ...withVndb.map(({ game }) => game.vndbId)])],
              reason: 'Title.vndbId disagrees with contributing Game.vndbId',
              contributors: mismatched.map(({ itemId, game }) => ({
                archiveItemId: itemId, gameId: game.id, value: game.vndbId, metadataSource: game.metadataSource,
              })),
            }));
          }
        } else {
          const distinct = new Set(withVndb.map(({ game }) => comparableKey('vndbId', game.vndbId)));
          if (distinct.size === 1) {
            update.vndbId = withVndb[0].game.vndbId;
            identityEstablished = true;
            adoptedSources.add(withVndb[0].game.metadataSource === 'manual' ? 'manual' : 'auto');
          } else if (distinct.size > 1) {
            identityOk = false;
            conflicts.push(conflictEntry({
              titleId: id, field: 'vndbId',
              values: [...new Set(withVndb.map(({ game }) => game.vndbId))],
              reason: 'competing VNDB identities; logical metadata not consolidated',
              contributors: withVndb.map(({ itemId, game }) => ({
                archiveItemId: itemId, gameId: game.id, value: game.vndbId, metadataSource: game.metadataSource,
              })),
            }));
          }
        }

        // ── per-field consensus (only when identity is not in hard conflict) ──
        if (identityOk) {
          for (const field of LOGICAL_FIELDS) {
            if (isMeaningful(field, title[field])) continue;

            const entries = [];
            let fieldMalformed = false;
            for (const { itemId, game } of linked) {
              const raw = game[field];
              if (!isPresent(raw)) continue;
              if (JSON_FIELDS.has(field)) {
                const parsed = parseJsonArray(raw);
                if (!parsed.ok) {
                  fieldMalformed = true;
                  malformed.push({ titleId: id, archiveItemId: itemId, gameId: game.id, field, raw });
                  continue;
                }
                if (parsed.value.length === 0) continue;
                entries.push({ itemId, game, key: JSON.stringify(parsed.value), value: parsed.value });
              } else {
                entries.push({ itemId, game, key: comparableKey(field, raw), value: raw });
              }
            }

            if (fieldMalformed) {
              conflicts.push(conflictEntry({
                titleId: id, field,
                values: entries.map(({ value }) => value),
                reason: 'malformed JSON metadata value; field left unpopulated',
                contributors: malformed
                  .filter((m) => m.titleId === id && m.field === field)
                  .map((m) => ({ archiveItemId: m.archiveItemId, gameId: m.gameId, value: m.raw, metadataSource: null })),
              }));
              continue;
            }
            if (entries.length === 0) continue;

            const manualEntries = entries.filter(({ game }) => game.metadataSource === 'manual');
            const chosen = manualEntries.length > 0 ? manualEntries : entries;
            const distinct = new Set(chosen.map(({ key }) => key));

            if (distinct.size > 1) {
              conflicts.push(conflictEntry({
                titleId: id, field,
                values: [...new Set(chosen.map(({ value }) => (JSON_FIELDS.has(field) ? JSON.stringify(value) : value)))],
                reason: 'multiple meaningful values disagree',
                contributors: chosen.map(({ itemId, game, value }) => ({
                  archiveItemId: itemId, gameId: game.id,
                  value: JSON_FIELDS.has(field) ? JSON.stringify(value) : value,
                  metadataSource: game.metadataSource,
                })),
              }));
              continue;
            }

            const winning = chosen[0];
            update[field] = storedValue(field, winning.value);
            adoptedSources.add(winning.game.metadataSource === 'manual' ? 'manual' : 'auto');
          }

          // ── metadataSource policy ──────────────────────────────
          const titleSourcePopulated = Boolean(title.metadataSource) && title.metadataSource !== EMPTY_METADATA_SOURCE;
          if (!titleSourcePopulated && (adoptedSources.size > 0 || identityEstablished)) {
            update.metadataSource = adoptedSources.has('manual') ? 'manual' : 'auto';
          }

          // ── metadataFetchedAt policy ───────────────────────────
          const adoptedSomething = Object.keys(update).some((key) => key !== 'metadataSource');
          if (title.metadataFetchedAt == null && adoptedSomething) {
            const stamped = linked.filter(({ game }) => game.metadataFetchedAt != null);
            if (stamped.length > 0) {
              const times = stamped.map(({ game }) => timeKey(game.metadataFetchedAt));
              const distinctTimes = new Set(times);
              const distinctSources = new Set(stamped.map(({ game }) => game.metadataSource));
              if (distinctTimes.size === 1) {
                update.metadataFetchedAt = stamped[0].game.metadataFetchedAt;
              } else if (distinctSources.size === 1) {
                update.metadataFetchedAt = new Date(Math.max(...times));
              } else {
                malformed.push({
                  titleId: id, archiveItemId: null, gameId: null, field: 'metadataFetchedAt',
                  decision: 'mixed metadataSource timestamps; left NULL',
                });
              }
            }
          }
        }

        const fieldKeys = Object.keys(update);
        const status = fieldKeys.length === 0
          ? (conflicts.length ? 'skipped-conflict' : 'skipped')
          : (apply ? 'updated' : 'would-update');

        if (apply && fieldKeys.length > 0) {
          await tx.title.update({ where: { id }, data: update });
        }

        return { status, fields: fieldKeys, conflicts, malformed };
      });
    } catch (error) {
      summary.conflicts++;
      report({ type: 'error', titleId: id, code: error.code || 'BACKFILL_FAILED', message: error.message });
      continue;
    }

    if (result.status === 'missing') continue;

    summary.titlesInspected++;
    if (result.status === 'no-metadata') summary.titlesWithoutMetadata++;
    if (result.status === 'updated') { summary.titlesUpdated++; summary.fieldsPopulated += result.fields.length; }
    if (result.status === 'would-update') { summary.titlesWouldUpdate++; summary.fieldsPopulated += result.fields.length; }
    if (result.status === 'skipped' || result.status === 'skipped-conflict') summary.titlesSkipped++;

    summary.conflicts += result.conflicts?.length ?? 0;
    summary.malformedValues += result.malformed?.filter((m) => !m.decision).length ?? 0;

    report({ type: 'title', titleId: id, status: result.status, fields: result.fields });
    for (const c of result.conflicts ?? []) report({ type: 'conflict', ...c });
    for (const m of result.malformed ?? []) report({ type: m.decision ? 'decision' : 'malformed', ...m });
  }

  report({ type: 'summary', ...summary });
  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !['--dry-run', '--apply'].includes(args[0]))) {
    throw new Error('Usage: backfill-title-metadata.js [--dry-run | --apply]');
  }
  const url = process.env.DATABASE_URL;
  if (!url?.startsWith('file:/')) {
    throw new Error('Set DATABASE_URL explicitly to file:/absolute/path/to/database.db.');
  }
  const apply = args[0] === '--apply';
  console.log(
    `[Title metadata backfill] SQLite target=${JSON.stringify(url)} | ` +
    (apply ? 'APPLY — DATABASE WRITES ENABLED' : 'DRY-RUN — database writes disabled'),
  );
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const summary = await backfillTitleMetadata(prisma, {
      apply, report: (result) => console.log(JSON.stringify(result)),
    });
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...summary }));
    if (summary.conflicts) process.exitCode = 1;
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
