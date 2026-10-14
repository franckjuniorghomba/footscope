import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { collect } from '../scripts/backtest/collect.mjs';
import { initializeBudget, MAX_CALLS } from '../scripts/backtest/budget.mjs';
import {
  ANALYSIS_PAIRS,
  COLLECTION_PAIRS,
  combineDatasets,
  defaultPlan,
  loadPlan,
  readJson,
  repoRoot,
  sha256,
  validatePlan,
} from '../scripts/backtest/data.mjs';
import { runBacktest } from '../scripts/backtest/engine.mjs';
import { providerResponse, seasonFixtures } from './fixtures/backtest-synthetic.mjs';

// BIS-185 : la limite de collecte (registre) et le périmètre d'analyse (historique
// combiné) sont distincts. Dix ligues × quatre saisons doivent produire le rapport.
const run = promisify(execFile);
const REAL_HISTORY =
  '/root/.local/share/jarvis/livrables/footscope/BIS-167/api-football/dataset.json';
const plan2026 = await loadPlan(join(repoRoot, 'scripts/backtest/plan-2026.json'));
const collectedAt = Date.parse('2026-10-14T20:00:00Z');
const pairs = (p) => p.leagues.length * p.seasons.length;

// Budget inchangé : la limite de collecte reste celle du registre.
assert.equal(MAX_CALLS, 30);
assert.equal(COLLECTION_PAIRS, MAX_CALLS);
assert.equal(ANALYSIS_PAIRS, pairs(defaultPlan) + pairs(plan2026));
const fortyPairs = { ...defaultPlan, seasons: [2023, 2024, 2025, 2026] };
assert.throws(() => validatePlan(fortyPairs), /Plan/, 'Collecte : 40 couples refusés');
assert.throws(() => validatePlan(fortyPairs, { openEnd: true }), /Plan/);
assert.equal(validatePlan(fortyPairs, { analysis: true }), fortyPairs);
assert.throws(
  () => validatePlan({ ...fortyPairs, seasons: [2022, ...fortyPairs.seasons] }, { analysis: true }),
  /Plan/,
  'Analyse : au plus 40 couples',
);
assert.throws(() => validatePlan(plan2026, { openEnd: true, analysis: true }), /Plan/);
assert.throws(() => validatePlan({ ...fortyPairs, history: plan2026.history }, { analysis: true }));

// Bloc « Évaluer la période neuve » du README, extrait tel quel.
const readme = await readFile(join(repoRoot, 'scripts/backtest/README.md'), 'utf8');
const runBlock = readme
  .split('### Évaluer la période neuve')[1]
  .split('```sh\n')[1]
  .split('```')[0];
assert(runBlock.includes(`--history ${REAL_HISTORY}`) && runBlock.includes('run.mjs'));
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

// Collecte 2026 simulée (dix appels, registre isolé à --used 20) puis commande README.
async function scenario(root, plan, historyPath, teamsFor) {
  let calls = 0;
  const budgetFile = join(root, 'budget.json');
  await initializeBudget({ budgetFile, used: 20, reason: 'Test isolé BIS-185' });
  const out = join(root, 'livrables');
  const current = await collect({
    out: join(out, 'api-football-2026'),
    budgetFile,
    plan,
    key: 'fixture-key',
    wait: async () => {},
    now: () => collectedAt,
    fetchImpl: async (url) => {
      calls++;
      const u = new URL(url);
      const league = Number(u.searchParams.get('league')),
        season = Number(u.searchParams.get('season'));
      return providerResponse(seasonFixtures(league, season, collectedAt, teamsFor(league)));
    },
  });
  assert.equal(calls, 10, 'Dix appels simulés pour la saison 2026');
  assert.equal(current.calls, 10);
  const command = runBlock.replace(REAL_HISTORY, historyPath);
  const { stdout } = await run('bash', ['-c', `set -eu\n${command}`], {
    cwd: repoRoot,
    env: { ...process.env, JARVIS_LIVRABLES: out, API_FOOTBALL_KEY: '' },
  });
  const summary = JSON.parse(stdout);
  const reportDir = join(out, 'historical-2026');
  for (const file of ['report.json', 'rapport-backtest.md', 'calibration.svg'])
    assert(await exists(join(reportDir, file)), file);
  const report = await readJson(join(reportDir, 'report.json'));
  assert.deepEqual(report.plan.seasons, [2023, 2024, 2025, 2026]);
  assert.deepEqual(report.plan.leagues, plan2026.leagues);
  assert.equal(pairs(report.plan), 40);
  assert.equal(Object.keys(report.coverage.byLeagueSeason).length, 40, 'Dix ligues × 4 saisons');
  assert.equal(report.plan.testEnd, '2026-10-14');
  assert.equal(report.sources.current.sha256, current.sha256);
  assert.equal(report.sources.history.sha256, sha256(await readFile(historyPath)));
  assert(report.test.forecasts.length > 0 && summary.matches > 0);
  assert(report.test.forecasts.every((r) => r.day >= '2026-07-01' && r.day < '2026-10-14'));
  assert(report.development.forecasts.every((r) => r.day >= '2025-07-01' && r.day < '2026-07-01'));
  assert.equal(report.modelValidated, false);
  assert.equal(report.realMoneyEligible, false);
  // Sans sommes vérifiées, le même périmètre combiné reste refusé par le moteur.
  const combined = combineDatasets({
    history: await readJson(historyPath),
    historySha256: report.sources.history.sha256,
    current: await readJson(current.path),
    currentSha256: current.sha256,
  });
  assert.throws(() => runBacktest(combined), /Plan/);
  const { sources, ...unsourced } = combined;
  assert.throws(() => runBacktest(unsourced, unsourced.plan, { analysis: true }), /sommes/);
  // Historique altéré : le rapport n'est pas produit sur le périmètre élargi.
  const bytes = await readFile(historyPath);
  if (historyPath.startsWith(root)) {
    await writeFile(historyPath, bytes + ' ');
    await assert.rejects(
      run('bash', ['-c', `set -eu\n${command.replace('historical-2026', 'altered')}`], {
        cwd: repoRoot,
        env: { ...process.env, JARVIS_LIVRABLES: out },
      }),
      (e) => /Backtest interrompu/.test(e.stderr),
    );
    assert(!(await exists(join(out, 'altered', 'report.json'))));
    await writeFile(historyPath, bytes);
  }
  return { report, summary };
}

const root = await mkdtemp(join(tmpdir(), 'footscope-backtest-scope-'));
try {
  // 1. Historique synthétique 10 ligues × 2023-2025 collecté par le plan par défaut (30 appels).
  const historyBudget = join(root, 'history-budget.json');
  await initializeBudget({ budgetFile: historyBudget, used: 0, reason: 'Test isolé' });
  const history = await collect({
    out: join(root, 'history'),
    budgetFile: historyBudget,
    key: 'fixture-key',
    wait: async () => {},
    now: () => collectedAt,
    fetchImpl: async (url) => {
      const u = new URL(url);
      return providerResponse(
        seasonFixtures(
          Number(u.searchParams.get('league')),
          Number(u.searchParams.get('season')),
          collectedAt,
        ),
      );
    },
  });
  // Seule l'épingle de somme diffère du plan 2026 figé (même planHash d'historique).
  const pinned = { ...plan2026, history: { ...plan2026.history, sha256: history.sha256 } };
  const synthetic = await scenario(join(root, 'synthetic'), pinned, history.path, () => ({}));
  assert.equal(synthetic.report.coverage.input, 40 * 56);
  console.log(
    `Synthetic 10 leagues × 4 seasons: ${synthetic.summary.matches} test matches, report written.`,
  );

  // 2. Vrai historique épinglé (SHA 7101245773e9…), plan 2026 exact : seulement s'il est présent.
  if (
    (await exists(REAL_HISTORY)) &&
    sha256(await readFile(REAL_HISTORY)) === plan2026.history.sha256
  ) {
    const real = await readJson(REAL_HISTORY);
    const teams = new Map();
    for (const f of real.fixtures)
      if (f.league.season === 2025)
        for (const side of ['home', 'away']) {
          if (!teams.has(f.league.id)) teams.set(f.league.id, new Set());
          teams.get(f.league.id).add(f.teams[side].id);
        }
    // Équipes réelles 2025, rencontres simulées hebdomadaires, identifiants hors plage réelle.
    const teamsFor = (league) => {
      const ids = [...teams.get(league)].sort((a, b) => a - b);
      return {
        teams: ids.slice(0, ids.length - (ids.length % 2)),
        spacingDays: 7,
        firstId: 2e9 + league * 1e4,
      };
    };
    const started = Date.now();
    const { report, summary } = await scenario(
      join(root, 'real'),
      plan2026,
      REAL_HISTORY,
      teamsFor,
    );
    assert.equal(report.sources.history.sha256, plan2026.history.sha256);
    const simulated = plan2026.leagues.reduce((n, l) => {
      const k = teamsFor(l).teams.length;
      return n + k * (k - 1);
    }, 0);
    assert.equal(
      report.coverage.input,
      real.fixtures.length + simulated,
      'Aucune rencontre perdue',
    );
    console.log(
      `Real pinned history ${plan2026.history.sha256.slice(0, 12)}… + simulated 2026: ${
        summary.matches
      } test matches, ${report.coverage.input} fixtures, ${Date.now() - started} ms.`,
    );
  } else {
    console.log('Real pinned history absent (CI): synthetic 10 × 4 scope only.');
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log(
  'Passed: collection limit 30 (= MAX_CALLS) separate from 40-pair analysis scope; README run.mjs --history completes on 10 leagues × 4 seasons.',
);
