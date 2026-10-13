import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs
  .readFileSync('dist/server/index.js', 'utf8')
  .replace(/(?:var|const) API_SPACING_MS\s*=\s*6500\s*;/, 'var API_SPACING_MS = 0;');
const module = await import(
  'data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#all'
);
const w = module.default;
const now = Date.now(),
  kick = now + 3 * 3600000;
const date = module.fixedDay(new Date(kick).toISOString());
const rows = Array.from({ length: 21 }, (_, i) => ({
  fixture: {
    id: i + 1,
    date: new Date(kick + i * 60000).toISOString(),
    timestamp: Math.floor((kick + i * 60000) / 1000),
    status: { short: 'NS' },
  },
  league: { country: 'France', name: 'A' },
  teams: {
    home: { id: 100 + i * 2, name: 'Home ' + i },
    away: { id: 101 + i * 2, name: 'Away ' + i },
  },
  goals: { home: null, away: null },
}));
const db = new Map();
const bucket = {
  get: async (key) => (db.has(key) ? { json: async () => JSON.parse(db.get(key)) } : null),
  put: async (key, value) => db.set(key, value),
  list: async ({ prefix }) => ({
    objects: [...db.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((key) => ({ key, uploaded: new Date() })),
  }),
};
const env = { BUCKET: bucket, API_FOOTBALL_KEY: 'mock-key' };
const quote = (id) => ({
  fixture: { id },
  update: new Date().toISOString(),
  bookmakers: [
    {
      name: 'Book',
      bets: [{ name: 'Goals Over/Under', values: [{ value: 'Over 0.5', odd: '1.80' }] }],
    },
  ],
});
let rawRequests = 0;
globalThis.fetch = async (url) => {
  rawRequests++;
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
        goals: { home: id >= 138 ? 3 : 2, away: id >= 138 ? 3 : 1 },
      }));
    }
  } else if (u.pathname.endsWith('/odds')) {
    if (u.searchParams.has('fixture')) response = [quote(Number(u.searchParams.get('fixture')))];
    else if (u.searchParams.get('date') === date) {
      paging.total = 2;
      response = u.searchParams.get('page') === '1' ? [quote(1), quote(2)] : [quote(20)];
    }
  }
  return Response.json({ response, paging, errors: {} });
};
const call = async (action, body, user = 'owner') =>
  w.fetch(
    new Request('https://site/api/assistant/' + action, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': user },
      body: JSON.stringify(body),
    }),
    env,
  );
const prepared = await (await call('prepare', { date })).json();
assert.equal(prepared.ids.length, 21);
assert.equal(prepared.ids.at(-1), 21);
assert.equal(prepared.limit, null);
assert.equal(
  (await call('scan', { jobId: prepared.jobId, matchId: 1 })).status,
  409,
  'Cannot screen missing pages as absent markets',
);
for (const day of prepared.quoteDays) {
  let page = 1,
    total = 1;
  do {
    const d = await (await call('quotes', { jobId: prepared.jobId, day, page })).json();
    total = d.total;
    page++;
  } while (page <= total);
}
assert.equal(
  (await call('propose', { jobId: prepared.jobId })).status,
  409,
  'Cannot propose an incomplete analysis',
);
assert.equal((await call('scan', { jobId: prepared.jobId, matchId: 99 })).status, 400);
assert.equal(
  (await call('scan', { jobId: prepared.jobId, matchId: 1 }, 'other')).status,
  502,
  'Cannot read another owner job',
);
let uncovered = 0;
for (const id of prepared.ids) {
  const d = await (await call('scan', { jobId: prepared.jobId, matchId: id })).json();
  assert(d.report);
  if (id === 15) {
    assert.match(d.report.firstRejection, /toutes les pages/);
    uncovered++;
  }
}
assert.equal(uncovered, 1);
let result;
let checked = 0;
do {
  result = await (await call('propose', { jobId: prepared.jobId })).json();
  for (const id of result.needsRecheck || []) {
    const r = await call('scan', { jobId: prepared.jobId, matchId: id, recheck: true });
    assert.equal(r.status, 200);
    checked++;
  }
} while (result.needsRecheck?.length);
assert.equal(result.coverageComplete, true);
assert.equal(result.analyzed, 21);
assert.equal(result.eligibleCount, 21);
assert(
  result.selections.some((e) => e.matchId === 20),
  'Best event beyond the old 12-match boundary must be included',
);
assert(result.selections.length <= 4);
assert.equal(result.realMoneyEligible, false);
assert(checked > 0);
const rank = (id, p, book = 'Book') => ({
  matchId: id,
  retrievedAt: new Date().toISOString(),
  events: [
    {
      matchId: id,
      status: 'simulation_eligible',
      kickoff: new Date(now + 7200000).toISOString(),
      updated: new Date().toISOString(),
      bookmaker: book,
      prudentProbability: p,
      prudentEdge: 0.1,
    },
  ],
});
const ranked = module.selectCoupon([
  rank(1, 0.9, 'A'),
  rank(2, 0.8, 'A'),
  rank(3, 0.8, 'A'),
  rank(4, 0.8, 'A'),
  rank(5, 0.86, 'B'),
  rank(6, 0.86, 'B'),
  rank(7, 0.86, 'B'),
  rank(8, 0.86, 'B'),
]);
assert.equal(
  ranked[0].bookmaker,
  'B',
  'Compare all four probabilities, not only the strongest single',
);
console.log(
  'Passed: full 21-match universe, every odds page, missing-data screening, incomplete-job refusal, owner guard, final refresh, selection beyond match 12, same-bookmaker coupon ranking. Requests: ' +
    rawRequests,
);
