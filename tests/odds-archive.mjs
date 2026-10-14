import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ARCHIVE_MAX_BYTES, archiveRecord } from '../src/server/odds-archive.js';

// Archive des cotes (BIS-192) : seules les réponses réellement reçues du fournisseur sont
// archivées, un objet par (match, relevé), sans appel supplémentaire ni effet sur le ticket.
const source = fs
  .readFileSync('dist/server/index.js', 'utf8')
  .replace(/(?:var|const) API_SPACING_MS\s*=\s*6500\s*;/, 'var API_SPACING_MS = 0;')
  .replace(/var ARCHIVE_TIMEOUT_MS\s*=\s*(?:2000|2e3)\s*;/, 'var ARCHIVE_TIMEOUT_MS = 50;');
assert(source.includes('var ARCHIVE_TIMEOUT_MS = 50;'), 'Archive timeout must be patchable');
const isolate = async (tag) =>
  (
    await import(
      'data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#' + tag
    )
  ).default;

const secret = 'mock-key-0123456789abcdef';
const now = Date.now(),
  kick = now + 3 * 3600000;
const fixedDay = (iso) => new Date(Date.parse(iso) - 5 * 3600000).toISOString().slice(0, 10);
const date = fixedDay(new Date(kick).toISOString());
const T1 = new Date(now - 120000).toISOString(),
  T2 = new Date(now - 60000).toISOString();
const rows = [1, 2].map((id, i) => ({
  fixture: {
    id,
    date: new Date(kick + i * 60000).toISOString(),
    timestamp: Math.floor((kick + i * 60000) / 1000),
    status: { short: 'NS' },
  },
  league: { id: 61, name: 'Ligue 1', country: 'France', season: 2026 },
  teams: {
    home: { id: 140 + i * 2, name: 'Home ' + i },
    away: { id: 141 + i * 2, name: 'Away ' + i },
  },
  goals: { home: null, away: null },
}));
// Deux relevés distincts : match 1 mis à jour en T1, match 2 en T2.
const quote = (id, books = 1) => ({
  league: rows[id - 1].league,
  fixture: { id, date: rows[id - 1].fixture.date, timestamp: rows[id - 1].fixture.timestamp },
  update: id === 1 ? T1 : T2,
  bookmakers: Array.from({ length: books }, (_, b) => ({
    id: b + 1,
    name: b ? 'Book ' + b : 'Book',
    bets: [
      { id: 5, name: 'Goals Over/Under', values: [{ value: 'Over 0.5', odd: '1.80' }] },
      { id: 4, name: 'Asian Handicap', values: [{ value: 'Home -1', odd: '2.10' }] },
    ],
  })),
});
let requests = 0,
  oddsRequests = 0,
  hugePage = false;
globalThis.fetch = async (url, init) => {
  requests++;
  assert.equal(init.headers['x-apisports-key'], secret);
  const u = new URL(url);
  let response = [],
    paging = { total: 1 };
  if (u.pathname.endsWith('/fixtures')) {
    if (u.searchParams.has('date')) response = u.searchParams.get('date') === date ? rows : [];
    else if (u.searchParams.has('id'))
      response = rows.filter((r) => r.fixture.id === Number(u.searchParams.get('id')));
    else if (u.searchParams.has('team')) {
      const id = Number(u.searchParams.get('team'));
      response = Array.from({ length: 10 }, (_, i) => ({
        fixture: {
          id: 900 + i,
          timestamp: Math.floor((now - (i + 1) * 86400000) / 1000),
          status: { short: 'FT' },
        },
        teams: { home: { id }, away: { id: 999 } },
        goals: { home: 3, away: 2 },
      }));
    }
  } else if (u.pathname.endsWith('/odds')) {
    oddsRequests++;
    if (u.searchParams.has('fixture')) response = [quote(Number(u.searchParams.get('fixture')))];
    else if (u.searchParams.get('date') === date)
      response = hugePage ? [quote(1, 400)] : [quote(1), quote(2)];
  }
  return Response.json({ response, paging, errors: {} });
};

function memoryBucket(db, { failArchive = false, hangArchive = false } = {}) {
  const stats = { archiveAttempts: 0 };
  return {
    stats,
    get: async (key) =>
      db.has(key) ? { etag: 'e', json: async () => JSON.parse(db.get(key)) } : null,
    put: async (key, value, options = {}) => {
      if (key.startsWith('odds-archive/')) {
        stats.archiveAttempts++;
        if (failArchive) throw Error('R2 indisponible ' + key);
        if (hangArchive) return new Promise(() => {});
      }
      const ifNone = options.onlyIf instanceof Headers && options.onlyIf.get('If-None-Match');
      if (ifNone === '*' && db.has(key)) return null;
      db.set(key, value);
      return {};
    },
    list: async ({ prefix }) => ({
      objects: [...db.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((key) => ({ key, uploaded: new Date() })),
    }),
  };
}
const archiveKeys = (db) => [...db.keys()].filter((k) => k.startsWith('odds-archive/')).sort();

async function analysis(w, env) {
  const call = async (action, body) =>
    w.fetch(
      new Request('https://site/api/assistant/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': 'owner' },
        body: JSON.stringify(body),
      }),
      env,
    );
  const prepared = await (await call('prepare', { date })).json();
  assert.equal(prepared.ids.length, 2);
  for (const day of prepared.quoteDays) {
    let page = 1,
      total = 1;
    do {
      const r = await call('quotes', { jobId: prepared.jobId, day, page });
      assert.equal(r.status, 200);
      total = (await r.json()).total;
      page++;
    } while (page <= total);
  }
  for (const id of prepared.ids)
    assert.equal((await call('scan', { jobId: prepared.jobId, matchId: id })).status, 200);
  let result;
  do {
    result = await (await call('propose', { jobId: prepared.jobId })).json();
    for (const id of result.needsRecheck || [])
      assert.equal(
        (await call('scan', { jobId: prepared.jobId, matchId: id, recheck: true })).status,
        200,
      );
  } while (result.needsRecheck?.length);
  return result;
}
// Seuls les horodatages et identifiants générés diffèrent d'une exécution à l'autre.
const stable = (value) =>
  JSON.parse(
    JSON.stringify(value)
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<date>')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>'),
  );
const diagnostics = async (w, env) => {
  const text = await (await w.fetch(new Request('https://site/api/diagnostics'), env)).text();
  assert(!text.includes(secret), 'Diagnostics must never expose the provider key');
  assert(!text.includes('R2 indisponible'), 'Diagnostics must not echo storage errors');
  return JSON.parse(text).oddsArchive;
};

// 1. Analyse simulée avec 2 relevés de cotes : exactement 2 objets d'archive.
const db = new Map();
const env = { BUCKET: memoryBucket(db), API_FOOTBALL_KEY: secret };
const w1 = await isolate('a');
const baseline = await analysis(w1, env);
const baselineRequests = requests;
assert(baseline.selections.length > 0, 'The baseline must produce a ticket to compare');
assert.equal(baseline.realMoneyEligible, false);
const keys = archiveKeys(db);
assert.equal(keys.length, 2, 'Two odds snapshots give two archive objects');
const compact = (iso) => iso.replace(/[-:.]/g, '');
assert.deepEqual(keys, [
  'odds-archive/' + date + '/1/' + compact(T1) + '.json',
  'odds-archive/' + date + '/2/' + compact(T2) + '.json',
]);
const stored = JSON.parse(db.get(keys[0]));
assert.deepEqual(stored, {
  version: 1,
  fixtureId: 1,
  league: { id: 61, name: 'Ligue 1', country: 'France', season: 2026 },
  kickoff: rows[0].fixture.date,
  update: T1,
  retrievedAt: stored.retrievedAt,
  // Au plus 20 matchs : l'analyse relève les cotes match par match.
  query: 'odds?fixture=1&page=1',
  truncated: false,
  droppedBookmakers: 0,
  bookmakers: [
    {
      id: 1,
      name: 'Book',
      markets: [{ name: 'Goals Over/Under', values: [{ value: 'Over 0.5', odd: '1.80' }] }],
    },
  ],
});
assert(Number.isFinite(Date.parse(stored.retrievedAt)));
for (const k of keys) {
  assert(!db.get(k).includes(secret), 'No provider key in the archive');
  assert(!db.get(k).includes('owner'), 'No visitor identity in the archive');
}
let metrics = await diagnostics(w1, env);
assert.equal(metrics.written, 2);
assert.equal(metrics.failures, 0);

// 2. Succès de cache (mémoire puis R2) : aucune réponse archivée, aucune écriture.
const oddsPage = 'https://site/api/odds?date=' + date + '&page=1';
assert.equal((await w1.fetch(new Request(oddsPage), env)).status, 200);
const afterMiss = requests,
  responsesBefore = (await diagnostics(w1, env)).responses,
  attemptsBefore = env.BUCKET.stats.archiveAttempts;
assert.equal(afterMiss, baselineRequests + 1, 'The first page read is a real provider response');
assert.equal(archiveKeys(db).length, 2, 'Same snapshots through another query add nothing');
assert.equal((await w1.fetch(new Request(oddsPage), env)).status, 200);
const w2 = await isolate('bucket-hit');
assert.equal((await w2.fetch(new Request(oddsPage), env)).status, 200);
assert.equal(requests, afterMiss, 'Cache hits make no provider request');
assert.equal((await diagnostics(w1, env)).responses, responsesBefore);
assert.equal((await diagnostics(w2, env)).responses, 0);
assert.equal(
  env.BUCKET.stats.archiveAttempts,
  attemptsBefore,
  'Cache hits never reach the archive',
);

// 3. Relevé identique rejoué par le fournisseur (nouvel isolat, cache expiré) : 0 objet ajouté.
for (const k of [...db.keys()]) if (k.startsWith('api-cache/')) db.delete(k);
const w3 = await isolate('replay');
const oddsBefore = oddsRequests;
const replay = await analysis(w3, env);
assert(oddsRequests > oddsBefore, 'The replay really comes from the provider');
assert.deepEqual(archiveKeys(db), keys, 'An identical snapshot adds no archive object');
metrics = await diagnostics(w3, env);
assert.equal(metrics.written, 0);
assert(metrics.duplicates >= 2);
assert.deepEqual(stable(replay), stable(baseline));

// Les avertissements de l'archive sont capturés pour vérifier qu'ils ne portent aucune valeur.
const warnings = [];
const warn = console.warn;
console.warn = (...args) => warnings.push(args.join(' '));

// 4. Même nombre de requêtes avec ou sans archive : l'archive n'ajoute aucun appel.
const countRequests = async (bucket, tag) => {
  const start = requests;
  await analysis(await isolate(tag), { BUCKET: bucket, API_FOOTBALL_KEY: secret });
  return requests - start;
};
const withArchive = await countRequests(memoryBucket(new Map()), 'count-on');
const archiveOff = memoryBucket(new Map(), { failArchive: true });
const withoutArchive = await countRequests(archiveOff, 'count-off');
assert.equal(withArchive, withoutArchive);
assert.equal(withArchive, baselineRequests, 'Requests per analysis stay constant');

// 5. Panne R2 sur l'archive (exception, puis écriture bloquée) : analyse et ticket identiques.
for (const [tag, options] of [
  ['fail', { failArchive: true }],
  ['hang', { hangArchive: true }],
]) {
  const brokenDb = new Map();
  const brokenEnv = { BUCKET: memoryBucket(brokenDb, options), API_FOOTBALL_KEY: secret };
  const w = await isolate(tag);
  const started = performance.now();
  const result = await analysis(w, brokenEnv);
  assert(performance.now() - started < 5000, 'A stuck archive write stays bounded');
  assert.deepEqual(stable(result), stable(baseline), tag + ': ticket unchanged');
  assert.equal(archiveKeys(brokenDb).length, 0);
  assert(brokenEnv.BUCKET.stats.archiveAttempts >= 2);
  const m = await diagnostics(w, brokenEnv);
  assert.equal(m.written, 0);
  assert(tag === 'fail' ? m.failures >= 2 : m.timeouts >= 1, tag + ': counted in diagnostics');
  assert(Number.isFinite(Date.parse(m.lastFailureAt)));
}
console.warn = warn;
assert(warnings.length >= 2, 'Archive failures are logged');
for (const line of warnings) {
  assert(!line.includes(secret) && !line.includes('odds-archive/'), 'Logs carry no value');
}

// 6. Plafond de taille : un relevé démesuré (400 bookmakers) reste sous la borne, signalé.
hugePage = true;
const capDb = new Map();
const capEnv = { BUCKET: memoryBucket(capDb), API_FOOTBALL_KEY: secret };
const w6 = await isolate('cap');
assert.equal(
  (await w6.fetch(new Request('https://site/api/odds?date=' + date + '&page=1'), capEnv)).status,
  200,
);
const [capKey] = archiveKeys(capDb);
const capBody = capDb.get(capKey);
assert(new TextEncoder().encode(capBody).length <= ARCHIVE_MAX_BYTES);
const capRecord = JSON.parse(capBody);
assert.equal(capRecord.truncated, true);
assert.equal(capRecord.bookmakers.length + capRecord.droppedBookmakers, 400);
assert.equal((await diagnostics(w6, capEnv)).truncated, 1);

// 7. Bornes unitaires : données absentes ou invalides jamais inventées.
assert.equal(archiveRecord({ fixture: { id: 1 }, bookmakers: [] }, 'odds?fixture=1'), null);
assert.equal(archiveRecord({ fixture: { id: 'x' }, update: T1 }, 'odds?fixture=1'), null);
const noKick = archiveRecord(
  {
    fixture: { id: 7 },
    update: T1,
    bookmakers: [
      {
        name: 'Book',
        bets: [
          {
            name: 'Match Winner',
            values: [
              { value: 'Home', odd: '2.10' },
              { value: 'Draw', odd: 'abc' },
              { value: 'Away', odd: '1.00' },
            ],
          },
          { name: 'Match Winner', values: [{ value: 'Home', odd: '9.00' }] },
        ],
      },
    ],
  },
  'odds?fixture=7',
);
const noKickRecord = JSON.parse(noKick.body);
assert.equal(noKickRecord.kickoff, null);
assert.equal(noKick.key, 'odds-archive/' + fixedDay(T1) + '/7/' + compact(T1) + '.json');
assert.deepEqual(noKickRecord.bookmakers[0].markets, [
  { name: 'Match Winner', values: [{ value: 'Home', odd: '2.10' }] },
]);

console.log(
  'Passed: odds archive — 2 snapshots give 2 objects, identical replay and cache hits add none, same request count (' +
    baselineRequests +
    ' per analysis), R2 failure and stuck write leave the ticket unchanged and are counted, size cap ' +
    ARCHIVE_MAX_BYTES +
    ' bytes, no invented data.',
);
