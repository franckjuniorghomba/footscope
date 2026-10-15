import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs
  .readFileSync('dist/server/index.js', 'utf8')
  .replace(/(?:var|const) API_SPACING_MS\s*=\s*6500\s*;/, 'var API_SPACING_MS = 0;');
const mod = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const w = mod.default;
assert.equal(mod.ottawaDay('2026-10-13T02:00:00Z'), '2026-10-12');
assert.equal(mod.ottawaDay('2026-10-13T05:00:00Z'), '2026-10-13');
const now = Date.now();
const game = (id, home, away, gf, ga, at) => ({
  fixture: {
    id,
    timestamp: Math.floor(at / 1000),
    date: new Date(at).toISOString(),
    status: { short: 'FT' },
  },
  league: { country: 'France', name: 'Ligue A' },
  teams: { home: { id: home, name: 'A' }, away: { id: away, name: 'B' } },
  goals: { home: gf, away: ga },
});
const target = game(99, 1, 2, 0, 0, now + 7200000);
target.fixture.status.short = 'NS';
const data = {
  fixture: target,
  home: Array.from({ length: 10 }, (_, i) => game(i, 1, 3, 2, 1, now - (i + 1) * 86400000)),
  away: Array.from({ length: 10 }, (_, i) => game(20 + i, 2, 4, 2, 1, now - (i + 1) * 86400000)),
  injuries: [],
  lineups: [],
  errors: {},
  retrievedAt: new Date().toISOString(),
  odds: [
    {
      update: new Date(now).toISOString(),
      bookmakers: [
        {
          name: 'Book',
          bets: [
            {
              name: 'Goals Over/Under',
              values: [
                { value: 'Over 0.5', odd: '1.80' },
                { value: 'Over 2', odd: '2' },
              ],
            },
            { name: 'Corners Over Under', values: [{ value: 'Over 8.5', odd: '2' }] },
          ],
        },
      ],
    },
  ],
};
let report = mod.assessMatch(data, now);
assert.equal(report.events[0].status, 'simulation_eligible');
assert.equal(report.events[0].realMoneyEligible, false);
assert(report.events[0].prudentProbability < report.events[0].probability);
assert.equal(report.events[1].status, 'insufficient');
assert.equal(report.events[2].status, 'insufficient');
const changed = structuredClone(data);
changed.home.push(game(700, 1, 5, 99, 0, now + 100000));
assert.deepEqual(
  mod.assessMatch(changed, now).model,
  report.model,
  'Future outcomes must not leak into forecast',
);
// BIS-217 : l'ancien refus à 1 h devient une admission ; tester la nouvelle frontière.
for (const minutes of [60, 180, 1439, 1440]) {
  changed.odds[0].update = new Date(now - minutes * 60000).toISOString();
  const result = mod.assessMatch(changed, now);
  assert.equal(result.events[0].status, 'simulation_eligible');
  assert.equal(mod.selectCoupon([result], now).length, 1);
  assert.equal(result.modelValidated, false);
  assert.equal(result.events[0].realMoneyEligible, false);
}
for (const updated of [
  new Date(now - 1441 * 60000).toISOString(),
  undefined,
  'invalid',
  new Date(now + 300001).toISOString(),
]) {
  changed.odds[0].update = updated;
  const result = mod.assessMatch(changed, now);
  assert.equal(result.events[0].status, 'reject');
  assert(result.events[0].reasons.includes('Cote absente, future ou âgée de plus de 24 heures.'));
  assert.equal(mod.selectCoupon([result], now).length, 0);
}
changed.odds[0].update = new Date(now).toISOString();
changed.fixture.fixture.timestamp = Math.floor((now + 300000) / 1000);
assert(mod.assessMatch(changed, now).events[0].reasons.some((x) => x.includes('Compositions')));
assert.equal(mod.eventProbability('Player Goalscorer', 'A', 2, 1), null);
assert.equal(mod.eventProbability('Goals Over/Under', 'Over 2', 2, 1), null);
assert(
  Math.abs(
    mod.eventProbability('Both Teams Score', 'Yes', 2, 1) - (1 - Math.exp(-2)) * (1 - Math.exp(-1)),
  ) < 1e-10,
);
assert(
  Math.abs(
    mod.eventProbability('Match Winner', 'Home', 2, 1) +
      mod.eventProbability('Match Winner', 'Draw', 2, 1) +
      mod.eventProbability('Match Winner', 'Away', 2, 1) -
      1,
  ) < 1e-8,
);
const bucketData = new Map();
const bucket = {
  get: async (k) =>
    bucketData.has(k) ? { json: async () => JSON.parse(bucketData.get(k)) } : null,
  put: async (k, v) => {
    bucketData.set(k, v);
  },
  list: async ({ prefix }) => ({
    objects: [...bucketData.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((key) => ({ key, uploaded: new Date() })),
  }),
};
const env = {
  BUCKET: bucket,
  API_FOOTBALL_KEY: 'fake-secret',
  OPENAI_API_KEY: 'fake-llm-secret',
  LLM_MODEL: 'test-model',
};
let llmRequest;
globalThis.fetch = async (url, opt) => {
  if (url.includes('api.openai.com')) {
    llmRequest = JSON.parse(opt.body);
    return Response.json({
      output: [
        {
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                summary: 'Explication de simulation',
                verdict: 'validated',
                selections: [{ matchId: 1000 }],
                reasons: [],
                risks: [],
              }),
            },
          ],
        },
      ],
    });
  }
  const u = new URL(url);
  const response = u.pathname.endsWith('/fixtures')
    ? u.searchParams.has('id')
      ? [data.fixture]
      : u.searchParams.get('team') === '1'
        ? data.home
        : data.away
    : u.pathname.endsWith('/odds')
      ? data.odds
      : [];
  return Response.json({ response, errors: {} });
};
const call = async (action, body) =>
  await w.fetch(
    new Request('https://site/api/assistant/' + action, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );
const scanned = await (await call('scan', { matchId: 99 })).json();
assert(scanned.token);
const review = await (
  await call('review', {
    tokens: [scanned.token],
    selections: [
      {
        matchId: 99,
        market: 'Goals Over/Under',
        selection: 'Over 0.5',
        bookmaker: 'Book',
        odd: 99,
      },
    ],
  })
).json();
assert.equal(review.verdict, 'simulation_eligible');
assert.equal(review.reviews[0].odd, 1.8);
assert.equal(review.realMoneyEligible, false);
assert.equal(review.engine, 'llm');
assert.equal(review.selections.length, 0, 'LLM cannot add selections');
assert.equal(llmRequest.store, false);
// BIS-217 : contrat HTTP scan/review aux deux côtés de la nouvelle frontière.
// La cote client falsifiée reste ignorée, y compris pour une cote ancienne admissible.
for (const minutes of [1439, 1441]) {
  data.odds[0].update = new Date(now - minutes * 60000).toISOString();
  // Isolat et stockage neufs : éviter de relire le cache du relevé précédent.
  const agedWorker = (
    await import(
      'data:text/javascript;base64,' +
        Buffer.from(source + '\n// age ' + minutes).toString('base64')
    )
  ).default;
  const agedCall = (action, body) =>
    agedWorker.fetch(
      new Request('https://site/api/assistant/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { ...env, BUCKET: undefined },
    );
  const agedScan = await (await agedCall('scan', { matchId: 99 })).json();
  const agedReview = await (
    await agedCall('review', {
      tokens: [agedScan.token],
      selections: [
        {
          matchId: 99,
          market: 'Goals Over/Under',
          selection: 'Over 0.5',
          bookmaker: 'Book',
          odd: 99,
          updated: new Date(now).toISOString(),
        },
      ],
    })
  ).json();
  assert.equal(agedReview.verdict, minutes === 1439 ? 'simulation_eligible' : 'reject');
  assert.equal(agedReview.reviews[0].updated, data.odds[0].update);
  assert.equal(agedReview.reviews[0].odd, 1.8);
  assert.equal(agedReview.realMoneyEligible, false);
  if (minutes === 1441)
    assert(
      agedReview.reviews[0].reasons.includes('Cote absente, future ou âgée de plus de 24 heures.'),
    );
}
data.odds[0].update = new Date(now).toISOString();
const corrupt = {
  ...scanned.token,
  payload: scanned.token.payload.replace('Over 0.5', 'Over 4.5'),
};
assert.equal(
  (await call('review', { tokens: [corrupt], selections: [{ matchId: 99 }] })).status,
  502,
);
const duplicate = await (
  await call('review', {
    tokens: [scanned.token],
    selections: [
      { matchId: 99, market: 'Goals Over/Under', selection: 'Over 0.5', bookmaker: 'Book' },
      { matchId: 99, market: 'Goals Over/Under', selection: 'Over 0.5', bookmaker: 'Book' },
    ],
  })
).json();
assert.equal(duplicate.verdict, 'reject');
const missing = await (
  await call('review', {
    tokens: [],
    selections: [
      {
        matchId: 99,
        market: 'Player Shots',
        selection: 'Over 3',
        bookmaker: 'Book',
        updated: new Date(now).toISOString(),
      },
    ],
  })
).json();
assert.equal(missing.verdict, 'insufficient');
assert.equal(
  missing.reviews[0].updated,
  null,
  'Une sélection absente ne reprend jamais l’heure client',
);
const date = mod.ottawaDay(target.fixture.date);
const proposed = await (
  await call('propose', { tokens: [scanned.token], scope: { date }, eligibleCount: 1 })
).json();
assert.equal(proposed.saved, true);
assert.equal(proposed.selections.length, 1);
assert(bucketData.has('latest/' + date + '.json'));
const metric = await (await w.fetch(new Request('https://site/api/performance'), env)).json();
assert.equal(metric.recordedCoupons, 1);
assert.equal(metric.settledSelections, 0);
const health = await (await call('health', {})).json();
assert.equal(health.connected, true);
assert.equal(
  mod.settledOutcome({ market: 'Both Teams Score', selection: 'Yes' }, data.home[0]),
  true,
);
assert.equal(
  mod.settledOutcome({ market: 'Goals Over/Under', selection: 'Under 2.5' }, data.home[0]),
  false,
);
assert.equal(mod.settledOutcome({ market: 'Match Winner', selection: 'Home' }, target), null);
console.log(
  'Passed: Poisson sums, supported settlement lines, temporal leakage, uncertainty sensitivity, freshness, lineups, signed evidence, LLM cannot override filters, current bookmaker price and duplicate guard.',
);
