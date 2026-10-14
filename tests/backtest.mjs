import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, symlink, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect } from '../scripts/backtest/collect.mjs';
import { initializeBudget } from '../scripts/backtest/budget.mjs';
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
// Régression du relecteur : dix mélanges déterministes et l'ordre inverse.
const stableReport = (r) => ({ ...r, elapsedMs: 0 });
let shuffleSeed = 42;
for (let k = 0; k < 11; k++) {
  const shuffled = structuredClone(demo);
  if (k === 10) shuffled.fixtures.reverse();
  else
    for (let i = shuffled.fixtures.length - 1; i > 0; i--) {
      shuffleSeed = (Math.imul(shuffleSeed, 1103515245) + 12345) >>> 0;
      const j = Math.floor((shuffleSeed / 2 ** 32) * (i + 1));
      [shuffled.fixtures[i], shuffled.fixtures[j]] = [shuffled.fixtures[j], shuffled.fixtures[i]];
    }
  assert.deepEqual(stableReport(runBacktest(shuffled)), stableReport(report));
}
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
  const newBudget = async (name, used = 0) => {
    const budgetFile = join(root, name + '-budget.json');
    await initializeBudget({ budgetFile, used, reason: 'Test synthétique isolé' });
    return budgetFile;
  };
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
    assert.equal(
      (await readJson(budgetFile)).attempts.length,
      calls,
      'Chaque fetch réel commence après la réservation persistante',
    );
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
  const budgetFile = await newBudget('success');
  const result = await collect({
    out,
    budgetFile,
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
  await collect({ out, budgetFile, plan, fetchImpl });
  assert.equal(calls, 30, 'Reprise sans clé depuis le cache : zéro nouvel appel');
  assert(!JSON.stringify(await readJson(join(out, 'collection.json'))).includes('fixture-key'));
  assert(!(await readFile(budgetFile, 'utf8')).includes('fixture-key'));
  const journalBytes = await readFile(join(out, 'collection.json'));
  await unlink(join(out, 'collection.json'));
  await assert.rejects(
    collect({ out, budgetFile, key: 'fixture-key', plan, fetchImpl }),
    /Cache existant sans journal/,
  );
  assert.equal(calls, 30, 'Suppression du journal : zéro nouvel appel réel');
  await assert.rejects(
    collect({ out: join(root, 'other-out'), budgetFile, key: 'fixture-key', plan, fetchImpl }),
    /Budget global/,
  );
  assert.equal(calls, 30, 'Changement de --out : zéro nouvel appel réel');
  await writeFile(join(out, 'collection.json'), journalBytes);
  const budgetBytes = await readFile(budgetFile);
  await unlink(budgetFile);
  await assert.rejects(
    collect({ out, budgetFile, key: 'fixture-key', plan, fetchImpl }),
    /absent ou illisible/,
  );
  assert.equal(calls, 30, 'Registre absent avec cache : refus avant réseau');
  await writeFile(budgetFile, '{');
  await assert.rejects(
    collect({ out, budgetFile, key: 'fixture-key', plan, fetchImpl }),
    /absent ou illisible/,
  );
  await writeFile(
    budgetFile,
    JSON.stringify({ schemaVersion: 1, initialCalls: -1, reason: 'invalid', attempts: [] }),
  );
  await assert.rejects(
    collect({ out, budgetFile, key: 'fixture-key', plan, fetchImpl }),
    /incohérent/,
  );
  await writeFile(budgetFile, budgetBytes);
  await assert.rejects(
    initializeBudget({ budgetFile, used: 0, reason: 'Ne pas écraser' }),
    /existant/,
  );
  const nestedBudget = join(out, 'nested-budget.json');
  await initializeBudget({ budgetFile: nestedBudget, used: 0, reason: 'Test chemin interdit' });
  await assert.rejects(
    collect({ out, budgetFile: nestedBudget, plan, fetchImpl }),
    /hors du dossier/,
  );
  assert.equal(calls, 30);
  const migratedBudget = await newBudget('migration-old-journal', 30);
  await collect({ out, budgetFile: migratedBudget, plan, fetchImpl });
  assert.equal(calls, 30, 'Ancien journal repris avec solde audité : aucun nouvel appel');
  await writeFile(join(out, 'fixtures-39-2023.json'), '[]');
  await assert.rejects(
    collect({ out, budgetFile, key: 'fixture-key', plan, fetchImpl }),
    /Cache altéré/,
  );
  assert.equal(calls, 30);
  const missingKey = join(root, 'missing-key');
  await assert.rejects(
    collect({ out: missingKey, budgetFile: await newBudget('missing-key'), plan, fetchImpl }),
    /KEY absente/,
  );
  assert.equal(calls, 30);
  const failed = join(root, 'failed');
  const failedBudget = await newBudget('failed');
  let failedCalls = 0;
  const broken = async () => {
    failedCalls++;
    throw new DOMException('fixture-key transport details', 'TimeoutError');
  };
  await assert.rejects(
    collect({ out: failed, budgetFile: failedBudget, key: 'fixture-key', plan, fetchImpl: broken }),
    (e) => !e.message.includes('fixture-key') && /Transport/.test(e.message),
  );
  assert.equal((await readJson(join(failed, 'collection.json'))).attempts.length, 1);
  assert.equal((await readJson(failedBudget)).attempts.length, failedCalls);
  await assert.rejects(
    collect({ out: failed, budgetFile: failedBudget, key: 'fixture-key', plan, fetchImpl: broken }),
    /aucun retry/,
  );
  await unlink(join(failed, 'collection.json'));
  await assert.rejects(
    collect({
      out: join(root, 'failed-other'),
      budgetFile: failedBudget,
      key: 'fixture-key',
      plan,
      fetchImpl: broken,
    }),
    /aucun retry/,
  );
  assert.equal(failedCalls, 1, 'Échec transport consommé même après changement de sortie');
  const failuresBudget = await newBudget('thirty-failures');
  let refusedCalls = 0;
  const unavailable = async () => {
    refusedCalls++;
    return { ok: false, status: 503 };
  };
  for (let league = 1; league <= 30; league++) {
    await assert.rejects(
      collect({
        out: join(root, 'failure-' + league),
        budgetFile: failuresBudget,
        key: 'fixture-key',
        plan: { ...plan, leagues: [league], seasons: [2023] },
        fetchImpl: unavailable,
        wait: async () => {},
      }),
      /HTTP 503/,
    );
  }
  await assert.rejects(
    collect({
      out: join(root, 'failure-31'),
      budgetFile: failuresBudget,
      key: 'fixture-key',
      plan: { ...plan, leagues: [31], seasons: [2023] },
      fetchImpl: unavailable,
    }),
    /Budget global/,
  );
  assert.equal(refusedCalls, 30, 'Trente refus 5xx épuisent également le budget global');
  const paginated = join(root, 'paginated');
  await assert.rejects(
    collect({
      out: paginated,
      budgetFile: await newBudget('paginated'),
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
  await assert.rejects(
    collect({ out: locked, budgetFile: await newBudget('locked'), plan, fetchImpl }),
    /verrou/,
  );
  const refused = join(root, 'refused');
  await assert.rejects(
    collect({
      out: refused,
      budgetFile: await newBudget('refused'),
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
      budgetFile: await newBudget('provider-error'),
      key: 'fixture-key',
      plan,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ errors: { token: 'fixture-key' } }),
      }),
    }),
    (e) => !e.message.includes('fixture-key') && /erreur/.test(e.message),
  );
  // Deux vrais processus, deux sorties, un seul registre ; on compte les fetch exécutés.
  const concurrentBudget = await newBudget('concurrent');
  const fetchLog = join(root, 'actual-fetches.log');
  const workerPath = join(root, 'collect-worker.mjs');
  await writeFile(
    workerPath,
    `
    import assert from 'node:assert/strict';
    import { appendFile, readFile } from 'node:fs/promises';
    import { once } from 'node:events';
    import { collect } from ${JSON.stringify(new URL('../scripts/backtest/collect.mjs', import.meta.url).href)};
    const demo = JSON.parse(await readFile(new URL(${JSON.stringify(new URL('../tests/fixtures/backtest-demo.json', import.meta.url).href)}), 'utf8'));
    const plan = ${JSON.stringify(plan)};
    let calls = 0;
    try {
      await collect({ out: process.argv[2], key: 'fixture-key', plan, wait: async () => {},
        fetchImpl: async (url) => {
          const u = new URL(url);
          const league = +u.searchParams.get('league'), season = +u.searchParams.get('season');
          const budget = JSON.parse(await readFile(process.env.BACKTEST_BUDGET_FILE, 'utf8'));
          assert(budget.attempts.some(a => a.id === league + '-' + season));
          await appendFile(${JSON.stringify(fetchLog)}, 'fetch\\n');
          if (++calls === 1) {
            console.log('NETWORK_RESERVED');
            await once(process.stdin, 'data');
            process.stdin.pause();
          }
          const f = structuredClone(demo.fixtures[0]);
          f.league.id = league; f.league.season = season; f.fixture.id = league * 10000 + season;
          return { ok: true, json: async () => ({ errors: [], response: [f], results: 1, paging: { current: 1, total: 1 } }) };
        }
      });
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  `,
  );
  const startWorker = (name) => {
    let child;
    const done = new Promise((resolve) => {
      child = execFile(
        process.execPath,
        [workerPath, join(root, name)],
        {
          env: { ...process.env, BACKTEST_BUDGET_FILE: concurrentBudget },
          timeout: 15000,
        },
        (error, stdout, stderr) => resolve({ error, stdout, stderr }),
      );
    });
    return { child, done };
  };
  const first = startWorker('concurrent-a');
  try {
    await new Promise((resolve, reject) => {
      first.child.stdout.on('data', (data) => {
        if (String(data).includes('NETWORK_RESERVED')) resolve();
      });
      first.done.then(({ error }) => {
        if (error) reject(error);
      });
    });
    const second = startWorker('concurrent-b');
    const refusedWorker = await second.done;
    assert(refusedWorker.error && /budget verrouillé/.test(refusedWorker.stderr));
    first.child.stdin.end('continue');
    const finishedWorker = await first.done;
    assert.equal(finishedWorker.error, null, finishedWorker.stderr);
    assert.equal((await readFile(fetchLog, 'utf8')).trim().split('\n').length, 30);
    const again = startWorker('concurrent-b');
    const exhaustedWorker = await again.done;
    assert(exhaustedWorker.error && /Budget global/.test(exhaustedWorker.stderr));
    assert.equal(
      (await readFile(fetchLog, 'utf8')).trim().split('\n').length,
      30,
      'Deux processus simultanés et nouvelle relance : au plus trente fetch réels',
    );
  } finally {
    first.child.kill();
  }
  console.log(
    'Budget réel simulé : relance=30, journal supprimé=30, autre --out=30, deux processus=30.',
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
