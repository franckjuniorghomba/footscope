import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import * as current from '../src/server/statistics.js';

// Copie exacte de src/server/statistics.js à a9470676ae41f3e040f977de9fa3c398fdec34cd.
// Garder cette référence indépendante du code optimisé, sans réécrire ses calculs.
const originalSource = String.raw`import { POLICY, MODEL_VERSION } from './policy.js';

export function distribution(lambda) {
  const p = [Math.exp(-lambda)];
  for (let i = 1; i < 30; i++) p.push((p[i - 1] * lambda) / i);
  return p;
}
export function eventProbability(market, selection, lh, la) {
  const h = distribution(lh),
    a = distribution(la);
  let prob = 0;
  const total = selection.match(/^(Over|Under) (\d+\.5)$/); // half-goal lines only: no refunds
  if (!(
    (market === 'Goals Over/Under' && total) ||
    (market === 'Both Teams Score' && ['Yes', 'No'].includes(selection)) ||
    (market === 'Match Winner' && ['Home', 'Draw', 'Away'].includes(selection)) ||
    (market === 'Double Chance' && ['Home/Draw', 'Draw/Away', 'Home/Away'].includes(selection))
  ))
    return null;
  for (let i = 0; i < h.length; i++)
    for (let j = 0; j < a.length; j++) {
      let wins = false;
      if (market === 'Goals Over/Under')
        wins = total[1] === 'Over' ? i + j > Number(total[2]) : i + j < Number(total[2]);
      if (market === 'Both Teams Score')
        wins = selection === 'Yes' ? i > 0 && j > 0 : i === 0 || j === 0;
      if (market === 'Match Winner')
        wins = selection === 'Home' ? i > j : selection === 'Away' ? i < j : i === j;
      if (market === 'Double Chance')
        wins = selection === 'Home/Draw' ? i >= j : selection === 'Draw/Away' ? j >= i : i !== j;
      if (wins) prob += h[i] * a[j];
    }
  return Math.min(1, prob);
}
function teamHistory(list, id, cutoff) {
  return (list || [])
    .filter(
      (f) =>
        f.fixture?.status?.short === 'FT' &&
        f.fixture.timestamp * 1000 < cutoff &&
        Number.isFinite(f.goals?.home) &&
        Number.isFinite(f.goals?.away) &&
        [f.teams.home.id, f.teams.away.id].includes(id),
    )
    .sort((a, b) => b.fixture.timestamp - a.fixture.timestamp)
    .slice(0, 10)
    .map((f) => ({
      gf: f.teams.home.id === id ? f.goals.home : f.goals.away,
      ga: f.teams.home.id === id ? f.goals.away : f.goals.home,
      at: f.fixture.timestamp * 1000,
      home: f.teams.home.id === id,
    }));
}
export function assessMatch(d, now = Date.now()) {
  const f = d.fixture,
    cutoff = Math.min(now, f.fixture.timestamp * 1000),
    h = teamHistory(d.home, f.teams.home.id, cutoff),
    a = teamHistory(d.away, f.teams.away.id, cutoff);
  const mean = (x, k) => x.reduce((s, v) => s + v[k], 0) / x.length;
  const enough = h.length >= POLICY.minHistory && a.length >= POLICY.minHistory;
  const lh = enough ? (mean(h, 'gf') + mean(a, 'ga')) / 2 : null,
    la = enough ? (mean(a, 'gf') + mean(h, 'ga')) / 2 : null;
  const model = enough
    ? { homeGoals: lh, awayGoals: la, homeSample: h.length, awaySample: a.length }
    : null;
  const common = [];
  if (f.fixture.status.short !== 'NS' || f.fixture.timestamp * 1000 <= now)
    common.push('Match commencé ou non programmé.');
  if (!enough) common.push('Au moins huit résultats antérieurs par équipe requis.');
  if (enough && [h, a].some((x) => now - x[0].at > POLICY.maxRecentAgeDays * 86400000))
    common.push('Dernier match terminé trop ancien.');
  for (const k of ['home', 'away', 'odds', 'injuries', 'lineups'])
    if (d.errors?.[k]) common.push('Source indisponible : ' + k + '.');
  const lineupsConfirmed = (d.lineups || []).filter((x) => x.startXI?.length === 11).length >= 2;
  if (f.fixture.timestamp * 1000 - now < 90 * 60000 && !lineupsConfirmed)
    common.push('Compositions non confirmées à moins de 90 minutes du match.');
  const events = [];
  for (const record of d.odds || [])
    for (const book of record.bookmakers || [])
      for (const market of book.bets || [])
        for (const v of market.values || []) {
          const odd = Number(v.odd);
          if (!Number.isFinite(odd) || odd <= 1) continue;
          const p = enough ? eventProbability(market.name, v.value, lh, la) : null;
          const reasons = [...common],
            age = now - Date.parse(record.update);
          if (!Number.isFinite(age) || age < -300000 || age > POLICY.maxOddsAgeMs)
            reasons.push('Cote absente, future ou âgée de plus de 3 heures.');
          if (p === null) reasons.push('Marché non modélisé : aucune validation automatique.');
          // Sensitivity envelope, NOT a calibrated confidence interval.
          let prudent = null;
          if (p !== null) {
            prudent = p;
            for (const sh of [0.75, 1, 1.25])
              for (const sa of [0.75, 1, 1.25])
                prudent = Math.min(
                  prudent,
                  eventProbability(market.name, v.value, lh * sh, la * sa),
                );
            prudent = Math.max(0, prudent - 0.05);
          }
          const edge = prudent === null ? null : prudent * odd - 1;
          if (p !== null && p < POLICY.minProbability)
            reasons.push('Probabilité exploratoire inférieure à 70 %.');
          if (edge !== null && edge < POLICY.minPrudentEdge)
            reasons.push('Avantage prudent inférieur à 2 %.');
          const insufficient = !enough || p === null || common.some((x) => /Source|ancien/.test(x));
          events.push({
            matchId: f.fixture.id,
            match: f.teams.home.name + ' — ' + f.teams.away.name,
            market: market.name,
            selection: v.value,
            odd,
            bookmaker: book.name,
            updated: record.update,
            kickoff: f.fixture.date,
            probability: p,
            prudentProbability: prudent,
            breakEven: 1 / odd,
            edge: p === null ? null : p * odd - 1,
            prudentEdge: edge,
            minOdds: prudent > 0 ? 1.02 / prudent : null,
            status: reasons.length
              ? insufficient
                ? 'insufficient'
                : 'reject'
              : 'simulation_eligible',
            reasons,
            realMoneyEligible: false,
          });
        }
  return {
    matchId: f.fixture.id,
    match: f.teams.home.name + ' — ' + f.teams.away.name,
    country: f.league.country,
    league: f.league.name,
    kickoff: f.fixture.date,
    model,
    lineupsConfirmed,
    absences: (d.injuries || []).map((x) => ({ player: x.player?.name, reason: x.player?.reason })),
    missing: Object.keys(d.errors || {}),
    events,
    common,
    retrievedAt: d.retrievedAt,
    modelVersion: MODEL_VERSION,
    modelValidated: false,
  };
}
`;
const currentSource = await readFile(
  new URL('../src/server/statistics.js', import.meta.url),
  'utf8',
);
const policyUrl = new URL('../src/server/policy.js', import.meta.url).href;
async function load(source, instrument = false) {
  source = source.replace("'./policy.js'", JSON.stringify(policyUrl));
  source = source.replace(
    "'./market.js'",
    JSON.stringify(new URL('../src/server/market.js', import.meta.url).href),
  );
  if (instrument) {
    // Compteurs injectés uniquement dans les modules du test, au point de calcul réel.
    const probabilityMarker = 'function eventProbability(market, selection, lh, la) {';
    const distributionMarker = 'function distribution(lambda) {';
    assert.equal(source.split(probabilityMarker).length, 2);
    assert.equal(source.split(distributionMarker).length, 2);
    source =
      'export const calls = { probability: 0, distribution: 0 };\n' +
      source
        .replace(probabilityMarker, probabilityMarker + ' calls.probability++;')
        .replace(distributionMarker, distributionMarker + ' calls.distribution++;');
  }
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}
const reference = await load(originalSource);
const before = await load(originalSource, true);
const after = await load(currentSource, true);
const now = Date.parse('2026-10-13T12:00:00Z');
const game = (id, home, away, gf, ga, at) => ({
  fixture: {
    id,
    timestamp: at / 1000,
    date: new Date(at).toISOString(),
    status: { short: 'FT' },
  },
  league: { country: 'France', name: 'Ligue simulée' },
  teams: { home: { id: home, name: 'Équipe A' }, away: { id: away, name: 'Équipe B' } },
  goals: { home: gf, away: ga },
});
function fixture(bookmakers = 10) {
  const target = game(99, 1, 2, 0, 0, now + 7200000);
  target.fixture.status.short = 'NS';
  return {
    fixture: target,
    // lh = 2, la = 1 : six lambdas effectifs distincts dans la sensibilité.
    home: Array.from({ length: 10 }, (_, i) => game(i, 1, 3, 3, 1, now - (i + 1) * 86400000)),
    away: Array.from({ length: 10 }, (_, i) => game(20 + i, 2, 4, 1, 1, now - (i + 1) * 86400000)),
    injuries: [],
    lineups: [],
    errors: {},
    retrievedAt: new Date(now).toISOString(),
    odds: [
      {
        update: new Date(now - 60000).toISOString(),
        bookmakers: Array.from({ length: bookmakers }, (_, i) => ({
          name: 'Book ' + i,
          bets: [
            {
              name: 'Goals Over/Under',
              values: [{ value: 'Over 0.5', odd: String(1.8 + i / 100) }],
            },
            { name: 'Both Teams Score', values: [{ value: 'No', odd: String(2.5 + i / 100) }] },
            { name: 'Match Winner', values: [{ value: 'Home', odd: String(2 + i / 100) }] },
            { name: 'Double Chance', values: [{ value: 'Home/Draw', odd: String(1.8 + i / 100) }] },
          ],
        })),
      },
    ],
  };
}
function compare(data, at = now) {
  // Repères descriptifs (BIS-172, BIS-200) : hors décision, absents de la copie de référence.
  const decisions = ({ market, sharpReference, ...report }) => report;
  const expected = reference.assessMatch(data, at);
  const snapshot = structuredClone(data);
  assert.deepStrictEqual(decisions(current.assessMatch(data, at)), expected);
  assert.deepStrictEqual(data, snapshot, 'Les données entrantes restent intactes');
  // deepStrictEqual ne compare pas l’ordre des clés : vérifier aussi la sérialisation.
  assert.equal(JSON.stringify(decisions(current.assessMatch(data, at))), JSON.stringify(expected));
  before.calls.probability = before.calls.distribution = 0;
  after.calls.probability = after.calls.distribution = 0;
  assert.deepStrictEqual(before.assessMatch(data, at), expected);
  assert.deepStrictEqual(decisions(after.assessMatch(data, at)), expected);
  assert.equal(expected.modelValidated, false);
  assert(expected.events.every((event) => event.realMoneyEligible === false));
  return expected;
}
const data = fixture();
const report = compare(data);
assert.equal(report.events.length, 40);
assert.equal(report.events[0].status, 'simulation_eligible');
assert(report.events.some((event) => event.status === 'reject'));
assert.deepStrictEqual(before.calls, { probability: 400, distribution: 800 });
assert.deepStrictEqual(after.calls, { probability: 40, distribution: 6 });
assert.equal(current.assessMatch.length, reference.assessMatch.length);
assert.equal(current.eventProbability.length, reference.eventProbability.length);
for (const books of [1, 8]) {
  compare(fixture(books));
  assert.equal(before.calls.probability, books * 40);
  assert.equal(after.calls.probability, 40);
}

// Toutes les sélections prises en charge, y compris les lignes différentes du même marché.
const selections = [
  ['Goals Over/Under', ['Over 0.5', 'Under 0.5', 'Over 2.5', 'Under 2.5']],
  ['Both Teams Score', ['Yes', 'No']],
  ['Match Winner', ['Home', 'Draw', 'Away']],
  ['Double Chance', ['Home/Draw', 'Draw/Away', 'Home/Away']],
];
const all = fixture();
for (const book of all.odds[0].bookmakers)
  book.bets = selections.map(([name, values]) => ({
    name,
    values: values.map((value) => ({ value, odd: '2.0' })),
  }));
compare(all);
assert.deepStrictEqual(before.calls, { probability: 1200, distribution: 2400 });
assert.deepStrictEqual(after.calls, { probability: 120, distribution: 6 });
for (const [market, values] of [
  ...selections,
  ['Corners', ['Over 8.5']],
  ['Goals Over/Under', ['Over 2']],
])
  for (const selection of values)
    for (const [lh, la] of [
      [2, 1],
      [0, 0],
      [1.2, 3.7],
    ])
      assert.strictEqual(
        current.eventProbability(market, selection, lh, la),
        reference.eventProbability(market, selection, lh, la),
      );

// Les refus et les cotes propres à chaque bookmaker ne doivent pas être mis en cache.
const invalid = fixture();
for (const book of invalid.odds[0].bookmakers) {
  book.bets.push(
    { name: 'Goals Over/Under', values: [{ value: 'Over 2', odd: '2' }] },
    { name: 'Double Chance', values: [{ value: 'Home', odd: '2' }] },
    { name: 'Corners', values: [{ value: 'Over 8.5', odd: '2' }] },
  );
  book.bets[0].values.push(
    ...['NaN', 'Infinity', '', '1', '0', '-2'].map((odd) => ({ value: 'Over 0.5', odd })),
  );
}
const refused = compare(invalid);
assert.equal(refused.events.length, 70);
assert.equal(refused.events.filter((event) => event.status === 'insufficient').length, 30);
assert.deepStrictEqual(before.calls, { probability: 430, distribution: 860 });
assert.deepStrictEqual(after.calls, { probability: 43, distribution: 6 });
// BIS-217 : conserver un relevé périmé dans le scénario mixte, désormais à 3 h 01.
const records = fixture();
records.odds.push(structuredClone(records.odds[0]));
records.odds[1].update = new Date(now - 181 * 60000).toISOString();
const mixed = compare(records);
assert.equal(mixed.events[0].status, 'simulation_eligible');
assert.equal(mixed.events[40].status, 'reject');
assert.deepStrictEqual(after.calls, { probability: 40, distribution: 6 });

const scenarios = [
  [
    'historique insuffisant',
    (d) => {
      d.home.length = 7;
    },
  ],
  [
    'sources indisponibles',
    (d) => {
      d.errors = { home: 'indisponible', odds: 'indisponible' };
    },
  ],
  [
    'historique ancien',
    (d) => {
      for (const f of d.home) f.fixture.timestamp -= 60 * 86400;
    },
  ],
  [
    'cotes futures',
    (d) => {
      d.odds[0].update = new Date(now + 300001).toISOString();
    },
  ],
  [
    'horodatage absent',
    (d) => {
      delete d.odds[0].update;
    },
  ],
  [
    'match commencé',
    (d) => {
      d.fixture.fixture.status.short = 'LIVE';
    },
  ],
  [
    'compositions absentes',
    (d) => {
      d.fixture.fixture.timestamp = (now + 60000) / 1000;
    },
  ],
  [
    'cotes absentes',
    (d) => {
      delete d.odds;
    },
  ],
  [
    'bookmakers absents',
    (d) => {
      delete d.odds[0].bookmakers;
    },
  ],
  [
    'marchés absents',
    (d) => {
      delete d.odds[0].bookmakers[0].bets;
    },
  ],
  [
    'sélections absentes',
    (d) => {
      delete d.odds[0].bookmakers[0].bets[0].values;
    },
  ],
];
for (const [label, change] of scenarios) {
  const changed = fixture();
  change(changed);
  const result = compare(changed);
  if (label === 'historique insuffisant') {
    assert.equal(result.model, null);
    assert(result.events.every((event) => event.status === 'insufficient'));
    assert.deepStrictEqual(after.calls, { probability: 0, distribution: 0 });
  }
}
// Deux appels avec des historiques différents ne partagent aucun état ni résultat.
const changed = fixture();
for (const f of changed.home) f.goals.home = 5;
const changedReport = compare(changed);
assert.notEqual(changedReport.events[0].probability, report.events[0].probability);
assert.deepStrictEqual(after.calls, { probability: 40, distribution: 6 });
compare(data);
assert.deepStrictEqual(after.calls, { probability: 40, distribution: 6 });
compare(data, now + 4 * 3600000);
const zero = fixture();
for (const f of [...zero.home, ...zero.away]) f.goals = { home: 0, away: 0 };
compare(zero);
assert.deepStrictEqual(after.calls, { probability: 40, distribution: 1 });
const equal = fixture();
for (const f of equal.home) f.goals.home = 1;
compare(equal);
assert.deepStrictEqual(after.calls, { probability: 40, distribution: 3 });

console.log(
  'Passed: strict probability-cache equivalence, refusal cases, per-call isolation; eventProbability 400 → 40, distribution 800 → 6.',
);
if (process.argv.includes('--benchmark')) {
  // Modules non instrumentés, même fixture et now, 1000 appels mesurés par version.
  for (let i = 0; i < 100; i++) {
    reference.assessMatch(data, now);
    current.assessMatch(data, now);
  }
  const durations = { before: [], after: [] };
  function measure(mod, samples) {
    const start = performance.now();
    mod.assessMatch(data, now);
    samples.push(performance.now() - start);
  }
  for (let i = 0; i < 1000; i++) {
    // Alterner l’ordre pour réduire le biais d’échauffement et de charge.
    if (i % 2) {
      measure(current, durations.after);
      measure(reference, durations.before);
    } else {
      measure(reference, durations.before);
      measure(current, durations.after);
    }
  }
  const median = (samples) => {
    samples.sort((a, b) => a - b);
    return (samples[499] + samples[500]) / 2;
  };
  const beforeMs = median(durations.before),
    afterMs = median(durations.after);
  console.log(
    JSON.stringify(
      {
        node: process.version,
        iterations: 1000,
        warmup: 100,
        bookmakers: 10,
        markets: 4,
        eventProbability: { before: 400, after: 40 },
        distribution: { before: 800, after: 6 },
        medianMs: { before: beforeMs, after: afterMs },
        speedup: beforeMs / afterMs,
      },
      null,
      2,
    ),
  );
}
