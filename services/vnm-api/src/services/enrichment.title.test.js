import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  enrichTitle,
  enrichTitleById,
  enrichTitleBySteamId,
  runBatchTitleEnrichment,
  titleLookupCandidates,
  pickMediaStorageGame,
  buildGameMirror,
  mapVnToTitleData,
} from './enrichment.js';

const VN = {
  id: 'v17', title: 'Canonical VN', alttitle: '原題', description: 'A description.',
  developers: [{ name: 'Studio' }], released: '2020-03-04', length_minutes: 300, rating: 85,
  tags: [{ name: 'Tag', spoiler: 0 }], screenshots: [{ url: 'https://img/1.jpg' }],
  image: { url: 'https://img/cover.jpg' },
};

const game = (id, overrides = {}) => ({
  id, extractedTitle: `Game ${id}`, sourceAvailable: true, buildStatus: 'not_built',
  hidden: false, extractedRuntime: 'keep', ...overrides,
});

const title = (id, overrides = {}) => ({
  id, name: 'Canonical VN', metadataSource: 'unmatched', metadataFetchedAt: null,
  vndbId: null, archiveItems: [], ...overrides,
});

/** In-memory Prisma stand-in: transactions clone and commit only on success. */
function db(titles) {
  const state = { titles: structuredClone(titles) };
  const findGame = (rows, id) => {
    for (const t of rows) for (const item of t.archiveItems) if (item.game?.id === id) return item.game;
    return null;
  };
  const findTitle = (rows, id) => rows.find((t) => t.id === id) || null;
  const mkTx = (rows) => ({
    title: { update: async ({ where, data }) => { const t = findTitle(rows, where.id); Object.assign(t, data); return t; } },
    game: { update: async ({ where, data }) => { const g = findGame(rows, where.id); Object.assign(g, data); return g; } },
  });
  return {
    state,
    $transaction: async (fn) => {
      const draft = structuredClone(state.titles);
      const result = await fn(mkTx(draft));
      state.titles = draft;
      return result;
    },
    title: {
      findMany: async ({ where } = {}) => {
        const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        return state.titles.filter((t) => {
          if (where?.metadataSource?.not && t.metadataSource === where.metadataSource.not) return false;
          return (t.metadataFetchedAt == null || t.metadataSource === 'unmatched' || new Date(t.metadataFetchedAt) < cutoff);
        });
      },
    },
  };
}

function fakeVndb({ results = [VN], byId = VN } = {}) {
  return {
    matchThreshold: 0.7, searchCalls: [], byIdCalls: [],
    async searchByTitle(text) { this.searchCalls.push(text); return results; },
    async getById(id) { this.byIdCalls.push(id); return byId; },
  };
}

function fakeSteam(details) {
  return { calls: [], async getAppDetails(appid) { this.calls.push(appid); return details; } };
}

const silent = { info() {}, warn() {}, error() {}, log() {} };

/** Game as committed in the fake store (transactions write to a draft copy). */
const committed = (d, titleIndex = 0, itemIndex = 0) => d.state.titles[titleIndex].archiveItems[itemIndex].game;

test('A. one Title/one Game: single lookup, Title authoritative, Game mirrored', async () => {
  const games = [game('a'.repeat(32))];
  const d = db([title('t1', { archiveItems: [{ id: 'i1', game: games[0] }] })]);
  const vndb = fakeVndb();

  await enrichTitle(d.state.titles[0], games, d, vndb, null, null, silent);

  assert.deepEqual(vndb.searchCalls, ['Canonical VN']);
  const t = d.state.titles[0];
  assert.equal(t.vndbId, 'v17');
  assert.equal(t.vndbTitle, 'Canonical VN');
  assert.equal(t.metadataSource, 'auto');
  assert.ok(t.metadataFetchedAt instanceof Date);
  const g = d.state.titles[0].archiveItems[0].game;
  assert.equal(g.vndbId, 'v17');
  assert.equal(g.vndbTitle, 'Canonical VN');
  assert.equal(g.metadataSource, 'auto');
});

test('B. one Title/two Games: one lookup, both Games mirrored, runtime fields untouched', async () => {
  const a = game('a'.repeat(32), { buildStatus: 'built', hidden: true });
  const b = game('b'.repeat(32), { buildStatus: 'building' });
  const d = db([title('t1', { archiveItems: [{ id: 'i1', game: a }, { id: 'i2', game: b }] })]);
  const vndb = fakeVndb();

  await enrichTitle(d.state.titles[0], [a, b], d, vndb, null, null, silent);

  assert.equal(vndb.searchCalls.length, 1);
  assert.equal(committed(d, 0, 0).vndbTitle, 'Canonical VN');
  assert.equal(committed(d, 0, 1).vndbTitle, 'Canonical VN');
  assert.equal(committed(d, 0, 0).buildStatus, 'built');
  assert.equal(committed(d, 0, 1).buildStatus, 'building');
  assert.equal(committed(d, 0, 0).hidden, true);
  assert.equal(committed(d, 0, 0).extractedRuntime, 'keep');
});

test('C. manual Title is skipped by automatic batch enrichment', async () => {
  const g = game('a'.repeat(32));
  const d = db([title('t1', { metadataSource: 'manual', archiveItems: [{ id: 'i1', game: g }] })]);
  const vndb = fakeVndb();

  const summary = await runBatchTitleEnrichment(d, vndb, null, null, silent);
  assert.equal(vndb.searchCalls.length, 0);
  assert.equal(summary.enriched, 0);
});

test('D. stale/unmatched Titles are included in batch enrichment', async () => {
  const g1 = game('a'.repeat(32));
  const g2 = game('b'.repeat(32));
  const stale = title('t1', { metadataSource: 'auto', metadataFetchedAt: new Date('2020-01-01'), archiveItems: [{ id: 'i1', game: g1 }] });
  const unmatched = title('t2', { metadataSource: 'unmatched', archiveItems: [{ id: 'i2', game: g2 }] });
  const d = db([stale, unmatched]);
  const vndb = fakeVndb();

  const summary = await runBatchTitleEnrichment(d, vndb, null, null, silent);
  assert.equal(vndb.searchCalls.length, 2);
  assert.equal(summary.enriched, 2);
});

test('E. multi-Game stale disagreement is overwritten by Title-authoritative enrichment', async () => {
  const a = game('a'.repeat(32), { vndbTitle: 'Old A' });
  const b = game('b'.repeat(32), { vndbTitle: 'Old B' });
  const d = db([title('t1', { archiveItems: [{ id: 'i1', game: a }, { id: 'i2', game: b }] })]);

  await enrichTitle(d.state.titles[0], [a, b], d, fakeVndb(), null, null, silent);
  assert.equal(committed(d, 0, 0).vndbTitle, 'Canonical VN');
  assert.equal(committed(d, 0, 1).vndbTitle, 'Canonical VN');
});

test('F. lookup identity prefers Title.name and deduplicates candidates', () => {
  assert.deepEqual(
    titleLookupCandidates({ id: 't1', name: 'Canonical VN' }, [{ extractedTitle: 'Canonical VN' }, { extractedTitle: 'Other' }]),
    ['Canonical VN', 'Other'],
  );
  assert.deepEqual(
    titleLookupCandidates({ id: 't1', name: null }, [{ extractedTitle: 'A' }, { extractedTitle: 'a' }]),
    ['A'],
  );
  assert.deepEqual(titleLookupCandidates({ id: 't1', name: '  ' }, [{ extractedTitle: 'Fallback' }]), ['Fallback']);
});

test('G. unmatched lookup marks Title (and Games) unmatched without crashing', async () => {
  const g = game('a'.repeat(32));
  const d = db([title('t1', { archiveItems: [{ id: 'i1', game: g }] })]);
  const vndb = fakeVndb({ results: [] });

  await enrichTitle(d.state.titles[0], [g], d, vndb, null, null, silent);
  assert.equal(d.state.titles[0].metadataSource, 'unmatched');
  assert.equal(committed(d).metadataSource, 'unmatched');
});

test('H. media downloads once under Title identity for a multi-Game Title', async () => {
  const titleId = '11111111-2222-3333-4444-555555555555';
  const covers = await mkdtemp(join(tmpdir(), 'vnm-covers-'));
  const shots = await mkdtemp(join(tmpdir(), 'vnm-shots-'));
  const origFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => { fetchCount++; return { ok: true, statusText: 'OK', arrayBuffer: async () => Buffer.from('img') }; };
  try {
    const a = game('a'.repeat(32));
    const b = game('b'.repeat(32), { sourceAvailable: false });
    const d = db([title(titleId, { archiveItems: [{ id: 'i1', game: a }, { id: 'i2', game: b }] })]);

    await enrichTitle(d.state.titles[0], [a, b], d, fakeVndb(), covers, shots, silent);

    // Storage adapter is still used for steamAppId targeting, but no longer for media.
    assert.equal(pickMediaStorageGame([a, b]).id, a.id);
    // One cover + one screenshot download, stored under the Title UUID.
    assert.equal(fetchCount, 2);
    assert.equal(d.state.titles[0].coverPath, `/covers/titles/${titleId}.jpg`);
    assert.deepEqual(JSON.parse(d.state.titles[0].screenshots), [`/screenshots/titles/${titleId}/0.jpg`]);
    assert.equal(committed(d, 0, 0).coverPath, `/covers/titles/${titleId}.jpg`);
    assert.equal(committed(d, 0, 1).coverPath, `/covers/titles/${titleId}.jpg`);
    assert.deepEqual(await readdir(join(covers, 'titles')), [`${titleId}.jpg`]);
    assert.deepEqual(await readdir(join(shots, 'titles', titleId)), ['0.jpg']);
    // No Game-keyed duplicate media.
    assert.deepEqual(await readdir(covers), ['titles']);
    assert.deepEqual(await readdir(shots), ['titles']);
  } finally {
    globalThis.fetch = origFetch;
    await rm(covers, { recursive: true, force: true });
    await rm(shots, { recursive: true, force: true });
  }
});

test('I. DB write failure rolls back so Title and sibling Games cannot diverge', async () => {
  const a = game('a'.repeat(32));
  const b = game('b'.repeat(32));
  const titles = [title('t1', { archiveItems: [{ id: 'i1', game: a }, { id: 'i2', game: b }] })];
  const state = { titles: structuredClone(titles) };
  const findT = (rows) => rows[0];
  const findG = (rows, id) => { for (const t of rows) for (const it of t.archiveItems) if (it.game?.id === id) return it.game; };
  const prisma = {
    $transaction: async (fn) => {
      const draft = structuredClone(state.titles);
      try {
        const result = await fn({
          title: { update: async ({ data }) => { Object.assign(findT(draft), data); return findT(draft); } },
          game: {
            update: async ({ where, data }) => {
              if (where.id === b.id) throw new Error('injected failure');
              Object.assign(findG(draft, where.id), data);
              return findG(draft, where.id);
            },
          },
        });
        state.titles = draft;
        return result;
      } catch (err) {
        // draft discarded → state unchanged
        throw err;
      }
    },
  };

  await assert.rejects(
    enrichTitle(state.titles[0], [a, b], prisma, fakeVndb(), null, null, silent),
    /injected failure/,
  );
  assert.equal(state.titles[0].vndbId, null);
  assert.equal('vndbId' in a, false);
  assert.equal('vndbId' in b, false);
});

test('J. enrichTitleById force-links and mirrors; enrichTitleBySteamId writes steamAppId only to a Game', async () => {
  const g = game('a'.repeat(32));
  const d = db([title('t1', { archiveItems: [{ id: 'i1', game: g }] })]);

  await enrichTitleById('v17', d.state.titles[0], [g], d, fakeVndb(), null, null, silent);
  assert.equal(d.state.titles[0].vndbId, 'v17');
  assert.equal(committed(d).vndbId, 'v17');

  const steamDetails = { name: 'Steam VN', short_description: 'sd', developers: ['Steam Dev'], release_date: { coming_soon: false, date: '2021' }, genres: [], screenshots: [], metacritic: { score: 80 } };
  await enrichTitleBySteamId('123', d.state.titles[0], [g], d, fakeSteam(steamDetails), null, null, silent, { steamAppIdTarget: g.id });
  assert.equal(d.state.titles[0].vndbTitle, 'Steam VN');
  assert.equal(d.state.titles[0].steamAppId, undefined); // Title has no steamAppId
  assert.equal(committed(d).steamAppId, '123');
});

test('K. buildGameMirror and mapVnToTitleData exclude Game-only fields', () => {
  const mirror = buildGameMirror({ vndbId: 'v1', steamAppId: '9', extractedTitle: 'X', name: 'N' });
  assert.deepEqual(Object.keys(mirror).sort(), ['vndbId']);
  const data = mapVnToTitleData(VN);
  assert.equal(data.steamAppId, undefined);
  assert.equal(data.vndbId, 'v17');
});
