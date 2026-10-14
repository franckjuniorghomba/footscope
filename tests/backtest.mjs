import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect } from '../scripts/backtest/collect.mjs';
import {
  dayStart,
  externalDirectory,
  fixedDay,
  readJson,
  repoRoot,
  sha256,
  validateDataset,
  validatePlan,
} from '../scripts/backtest/data.mjs';
import { EVENTS, forecast, runBacktest } from '../scripts/backtest/engine.mjs';
import { bootstrapDays, scores } from '../scripts/backtest/metrics.mjs';
import { assessMatch } from '../src/server/statistics.js';
import { selectCouponDetailed } from '../src/server/coupon.js';
import { writeReport } from '../scripts/backtest/run.mjs';

const input = 'tests/fixtures/backtest-demo.json';
const demo = await readJson(input);
const report = runBacktest(demo);
assert.equal(report.kind, 'demonstration');
assert.equal(report.test.matches, 16);
assert.equal(
  report.test.forecasts.length,
  160,
  'Tous les matchs et les dix événements sont évalués',
);
assert.equal(report.test.tickets.count, 8);
assert.equal(
  report.test.tickets.passRate,
  0.75,
  'Démonstration comprenant tickets gagnants et perdants',
);
assert(report.deferred.marketComparison && report.deferred.yield);
assert.equal(report.modelValidated, false);
assert.equal(report.realMoneyEligible, false);
assert.equal(fixedDay('2025-07-01T04:59:59Z'), '2025-06-30');
assert.equal(fixedDay('2025-07-01T05:00:00Z'), '2025-07-01');

const firstDay = report.test.forecasts[0].day;
const mutation = structuredClone(demo);
for (const f of mutation.fixtures)
  if (fixedDay(f.fixture.date) >= firstDay) {
    f.goals.home = 12;
    f.goals.away = 12;
  }
const changed = runBacktest(mutation);
const predictions = (r) =>
  r.test.forecasts.filter((e) => e.day === firstDay).map(({ won, ...e }) => e);
assert.deepEqual(
  predictions(changed),
  predictions(report),
  'Ni résultats du jour ni du futur dans les prédictions',
);
assert.deepEqual(
  changed.test.ticketRecords[0].selections.map((e) => [e.matchId, e.market, e.selection]),
  report.test.ticketRecords[0].selections.map((e) => [e.matchId, e.market, e.selection]),
  'Composition indépendante des résultats cibles',
);
const later = structuredClone(demo);
later.fixtures.at(-1).goals.home = 20;
assert.deepEqual(
  runBacktest(later).test.forecasts.slice(0, -20),
  report.test.forecasts.slice(0, -20),
);

const target = demo.fixtures.find((f) => fixedDay(f.fixture.date) === firstDay);
const now = dayStart(firstDay),
  iso = new Date(now).toISOString();
const history = demo.fixtures.filter((f) => fixedDay(f.fixture.date) < firstDay);
const assessment = assessMatch(
  {
    fixture: {
      ...target,
      fixture: { ...target.fixture, status: { short: 'NS' } },
      goals: { home: null, away: null },
    },
    home: history,
    away: history,
    errors: {},
    retrievedAt: iso,
    odds: [
      {
        update: iso,
        bookmakers: [
          {
            name: 'Fixture bookmaker',
            bets: [...new Set(EVENTS.map(([m]) => m))].map((m) => ({
              name: m,
              values: EVENTS.filter(([k]) => m === k).map(([, v]) => ({ value: v, odd: 2 })),
            })),
          },
        ],
      },
    ],
  },
  now,
);
for (const event of assessment.events) {
  assert.deepEqual(
    forecast(assessment.model, event.market, event.selection),
    { probability: event.probability, prudentProbability: event.prudentProbability },
    'Parité numérique avec poisson-sensitivity-v1',
  );
}
for (const ticket of report.test.ticketRecords) {
  assert(ticket.selections.length <= 4);
  assert.equal(new Set(ticket.selections.map((e) => e.matchId)).size, ticket.selections.length);
  assert(ticket.prudentProbability >= 0.5);
  assert.equal(ticket.realMoneyEligible, false);
  // Rejouer tous les candidats avec le sélecteur réel pour détecter une composition recopiée ou différente.
  const clock = dayStart(ticket.day),
    timestamp = new Date(clock).toISOString();
  const rows = report.test.forecasts.filter((e) => e.day === ticket.day && e.researchCandidate);
  const byMatch = new Map();
  for (const row of rows) {
    if (!byMatch.has(row.matchId)) byMatch.set(row.matchId, []);
    byMatch.get(row.matchId).push({
      ...row,
      status: 'simulation_eligible',
      bookmaker: 'offline-unpriced',
      prudentEdge: 0,
      updated: timestamp,
      kickoff: demo.fixtures.find((f) => f.fixture.id === row.matchId).fixture.date,
    });
  }
  const selected = selectCouponDetailed(
    [...byMatch.values()].map((events) => ({ events, retrievedAt: timestamp })),
    clock,
  );
  assert.deepEqual(
    selected.selections.map((e) => [e.matchId, e.market, e.selection]),
    ticket.selections.map((e) => [e.matchId, e.market, e.selection]),
  );
}
const noHistory = structuredClone(demo);
noHistory.fixtures = noHistory.fixtures.filter((f) => fixedDay(f.fixture.date) >= firstDay);
assert.equal(
  runBacktest(noHistory).test.tickets.count,
  0,
  'Aucun ticket forcé sans huit antécédents par équipe',
);
const incomplete = {
  ...demo,
  kind: 'historical',
  source: 'API-Football',
  plan: { ...demo.plan, leagues: [39, 61] },
};
assert.throws(() => runBacktest(incomplete), /incomplet/);
const duplicate = structuredClone(demo);
duplicate.fixtures.push(duplicate.fixtures[0]);
assert.throws(() => validateDataset(duplicate), /dupliqué/);
assert.throws(
  () => validatePlan({ ...demo.plan, leagues: Array.from({ length: 31 }, (_, i) => i + 1) }),
  /budget/,
);
const s = scores(
  [
    { matchId: 1, won: 1, p: 0.8 },
    { matchId: 2, won: 0, p: 0.2 },
  ],
  'p',
);
assert(Math.abs(s.brier - 0.04) < 1e-12);
assert(Math.abs(s.logLoss + Math.log(0.8)) < 1e-12);
assert.equal(s.calibration[8].count, 1);
assert.equal(scores([], 'p').brier, null);
assert(Number.isFinite(scores([{ matchId: 1, won: 0, p: 1 }], 'p').logLoss));
const clusters = [
  [0, 1],
  [1, 1],
];
const clusterStatistic = (days) => ({
  average: days.flat().reduce((a, b) => a + b, 0) / days.flat().length,
});
const clustered = bootstrapDays(clusters, clusterStatistic, 200, 167);
assert.deepEqual(clustered, bootstrapDays(clusters, clusterStatistic, 200, 167));
assert.deepEqual(
  clustered.average.interval95,
  [0.5, 1],
  'Les deux valeurs d’une journée restent dans leur grappe',
);
assert.equal(bootstrapDays([[1]], clusterStatistic, 200, 167).average.interval95, null);
assert.equal(bootstrapDays([], () => ({ value: null }), 200, 167).value.interval95, null);

const root = await mkdtemp(join(tmpdir(), 'footscope-backtest-test-'));
try {
  await assert.rejects(externalDirectory(join(repoRoot, 'generated-results')), /hors dépôt/);
  await symlink(repoRoot, join(root, 'repo-link'));
  await assert.rejects(
    externalDirectory(join(root, 'repo-link', 'generated-results')),
    /hors dépôt/,
  );
  const plan = {
    ...demo.plan,
    leagues: [39, 61, 78, 88, 94, 135, 140, 144, 179, 203],
    seasons: [2023, 2024, 2025],
  };
  let calls = 0,
    waits = [];
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(options.headers['x-apisports-key'], 'fixture-key');
    assert.equal(options.redirect, 'error');
    const u = new URL(url),
      league = Number(u.searchParams.get('league')),
      season = Number(u.searchParams.get('season'));
    const f = structuredClone(demo.fixtures[0]);
    f.fixture.id = league * 10000 + season;
    f.league.id = league;
    f.league.season = season;
    return {
      ok: true,
      json: async () => ({
        errors: [],
        response: [f],
        results: 1,
        paging: { current: 1, total: 1 },
      }),
    };
  };
  const out = join(root, 'success');
  const result = await collect({
    out,
    key: 'fixture-key',
    plan,
    fetchImpl,
    wait: async (ms) => waits.push(ms),
    now: () => dayStart('2026-10-14'),
  });
  assert.equal(calls, 30);
  assert.equal(result.calls, 30);
  assert.equal(waits.length, 29);
  assert(waits.every((ms) => ms === 6500));
  assert.equal(result.sha256, sha256(await readFile(result.path)));
  await writeReport(result.path, join(root, 'historical-rendered'));
  const collected = await readFile(result.path, 'utf8');
  await writeFile(result.path, collected + ' ');
  await assert.rejects(writeReport(result.path, join(root, 'altered-rendered')), /altéré/);
  await writeFile(result.path, collected);
  await collect({ out, plan, fetchImpl });
  assert.equal(calls, 30, 'Reprise sans clé depuis le cache : zéro nouvel appel');
  assert(!JSON.stringify(await readJson(join(out, 'collection.json'))).includes('fixture-key'));
  await writeFile(join(out, 'fixtures-39-2023.json'), '[]');
  await assert.rejects(collect({ out, key: 'fixture-key', plan, fetchImpl }), /Cache altéré/);
  assert.equal(calls, 30);
  const missingKey = join(root, 'missing-key');
  await assert.rejects(collect({ out: missingKey, plan, fetchImpl }), /KEY absente/);
  assert.equal(calls, 30);
  const failed = join(root, 'failed');
  const broken = async () => {
    throw Error('fixture-key transport details');
  };
  await assert.rejects(
    collect({ out: failed, key: 'fixture-key', plan, fetchImpl: broken }),
    (e) => !e.message.includes('fixture-key') && /Transport/.test(e.message),
  );
  assert.equal((await readJson(join(failed, 'collection.json'))).attempts.length, 1);
  await assert.rejects(
    collect({ out: failed, key: 'fixture-key', plan, fetchImpl }),
    /aucun retry/,
  );
  const paginated = join(root, 'paginated');
  await assert.rejects(
    collect({
      out: paginated,
      key: 'fixture-key',
      plan,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          response: [demo.fixtures[0]],
          results: 1,
          errors: [],
          paging: { current: 1, total: 2 },
        }),
      }),
    }),
    /paginée/,
  );
  const locked = join(root, 'locked');
  await externalDirectory(locked);
  await writeFile(join(locked, 'collect.lock'), '');
  await assert.rejects(collect({ out: locked, plan, fetchImpl }), /verrou/);
  const refused = join(root, 'refused');
  await assert.rejects(
    collect({
      out: refused,
      key: 'fixture-key',
      plan,
      fetchImpl: async () => ({ ok: false, status: 429 }),
    }),
    /HTTP 429/,
  );
  assert.equal((await readJson(join(refused, 'collection.json'))).attempts.length, 1);
  const providerError = join(root, 'provider-error');
  await assert.rejects(
    collect({
      out: providerError,
      key: 'fixture-key',
      plan,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ errors: { token: 'fixture-key' } }),
      }),
    }),
    (e) => !e.message.includes('fixture-key') && /erreur/.test(e.message),
  );
  const rendered = join(root, 'rendered');
  await writeReport(input, rendered);
  const md = await readFile(join(rendered, 'rapport-backtest.md'), 'utf8');
  assert(
    md.includes('DÉMONSTRATION SYNTHÉTIQUE') &&
      md.includes('rendement non calculable') &&
      md.includes('Conclusion en cinq lignes'),
  );
  assert((await readFile(join(rendered, 'calibration.svg'), 'utf8')).startsWith('<svg'));
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log(
  'Passed: temporal backtest, current-model and selector parity, no invented prices, clustered bootstrap, thirty-call budget, cache, redaction and offline report.',
);
