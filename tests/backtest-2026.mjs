import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect } from '../scripts/backtest/collect.mjs';
import { initializeBudget, MAX_CALLS } from '../scripts/backtest/budget.mjs';
import {
  COLLECTION_DAY,
  combineDatasets,
  defaultPlan,
  fixedDay,
  loadPlan,
  readJson,
  repoRoot,
  sha256,
  validatePlan,
} from '../scripts/backtest/data.mjs';
import { runBacktest } from '../scripts/backtest/engine.mjs';
import { writeReport } from '../scripts/backtest/run.mjs';
import { providerResponse, seasonFixtures } from './fixtures/backtest-synthetic.mjs';

const run = promisify(execFile);
// Plan et somme du jeu BIS-167 tels que collectés : toute dérive casse la reprise du cache.
const BIS167_PLAN_HASH = 'f41afaad2da70ae9c02ce129dfc2647ee4f7f6285e402a41133655d01f5c015f';
const BIS167_DATASET_SHA = '7101245773e9037bf0ec86b348f542d729eb572d841e2a554fc49851e8257f8c';
const pairs = (p) => p.leagues.flatMap((l) => p.seasons.map((s) => `${l}-${s}`));

// Plan figé 2026 : mêmes ligues, une saison, dix couples, historique épinglé.
const plan2026 = await loadPlan(join(repoRoot, 'scripts/backtest/plan-2026.json'));
assert.equal(pairs(plan2026).length, 10, 'Le plan 2026 demande exactement dix couples');
assert.deepEqual(plan2026.leagues, defaultPlan.leagues);
assert.deepEqual(plan2026.seasons, [2026]);
assert.equal(plan2026.testStart, '2026-07-01');
assert.equal(plan2026.testEnd, COLLECTION_DAY);
assert.equal(plan2026.history.sha256, BIS167_DATASET_SHA);
assert.equal(plan2026.history.planHash, BIS167_PLAN_HASH);
assert.notEqual(sha256(JSON.stringify(plan2026)), BIS167_PLAN_HASH, 'planHash séparé');
assert.throws(() => validatePlan(plan2026), /Plan/, 'Le runner refuse un plan non résolu');
assert.throws(() => validatePlan({ ...plan2026, history: undefined }, { openEnd: true }));
// Non-régression du plan par défaut, chargé implicitement ou par --plan plan.json.
assert.equal(sha256(JSON.stringify(defaultPlan)), BIS167_PLAN_HASH);
assert.equal(
  sha256(JSON.stringify(await loadPlan(join(repoRoot, 'scripts/backtest/plan.json')))),
  BIS167_PLAN_HASH,
);

// Collecte le 2026-10-14 à 15:00 GMT−5 : la journée du 14 a déjà un match FT, mais reste exclue.
const collectedAt = Date.parse('2026-10-14T20:00:00Z');
let calls = 0;
const fetchImpl = async (url, options) => {
  calls++;
  assert.equal(options.redirect, 'error');
  const u = new URL(url);
  return providerResponse(
    seasonFixtures(
      Number(u.searchParams.get('league')),
      Number(u.searchParams.get('season')),
      collectedAt,
    ),
  );
};
const options = { key: 'fixture-key', fetchImpl, wait: async () => {}, now: () => collectedAt };
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

const root = await mkdtemp(join(tmpdir(), 'footscope-backtest-2026-'));
try {
  // Sans --plan : même plan, même planHash, même jeu, aucun champ de collecte ajouté.
  const defaultBudget = join(root, 'default-budget.json');
  await initializeBudget({ budgetFile: defaultBudget, used: 0, reason: 'Test isolé' });
  const legacy = await collect({
    out: join(root, 'legacy'),
    budgetFile: defaultBudget,
    ...options,
  });
  assert.equal(calls, 30);
  const legacyJournal = await readJson(join(root, 'legacy', 'collection.json'));
  const legacyDataset = await readJson(legacy.path);
  assert.equal(legacyJournal.planHash, BIS167_PLAN_HASH);
  assert.deepEqual(legacyDataset.plan, defaultPlan);
  assert.deepEqual(Object.keys(legacyDataset.collection), ['calls', 'files']);
  assert.deepEqual(Object.keys(legacy).sort(), ['calls', 'fixtures', 'path', 'sha256']);
  assert.equal(
    (await readJson(join(root, 'legacy', 'dataset-checksum.json'))).planHash,
    BIS167_PLAN_HASH,
  );
  // Forme documentée du rapport par défaut : seul `coverage.afterTestEnd` est ajouté,
  // vide quand aucune rencontre n'est datée de testEnd ou après (cas du jeu BIS-167).
  const legacyReport = runBacktest(legacyDataset);
  assert.deepEqual(Object.keys(legacyReport.coverage), [
    'input',
    'completed',
    'byLeagueSeason',
    'exclusions',
    'afterTestEnd',
  ]);
  assert.deepEqual(legacyReport.coverage.afterTestEnd, { count: 0, byStatus: {} });
  assert.equal(legacyReport.sources, undefined);
  calls = 0;

  // Procédure de l'humain : registre partagé plein (30/30), archivage, puis --used 20.
  const budgetFile = join(root, 'budget-api-football.json');
  const archive = join(root, 'budget-api-football-bis167.json');
  await initializeBudget({ budgetFile, used: 30, reason: 'Registre partagé simulé 30/30' });
  const out2026 = join(root, 'api-football-2026');
  await assert.rejects(
    collect({ out: out2026, budgetFile, plan: plan2026, ...options }),
    /Budget global maximal/,
  );
  await assert.rejects(
    initializeBudget({ budgetFile, used: 20, reason: 'Écrasement interdit' }),
    /Registre existant/,
  );
  assert.equal(calls, 0, 'Registre plein : aucun appel');
  assert(!(await exists(archive)));
  await rename(budgetFile, archive);
  await run(
    process.execPath,
    ['scripts/backtest/budget.mjs', '--used', '20', '--reason', 'Autorisation BIS-185 simulée'],
    { cwd: repoRoot, env: { ...process.env, BACKTEST_BUDGET_FILE: budgetFile } },
  );
  assert.equal((await readJson(archive)).initialCalls, 30, 'Archive intacte');
  const fresh = await collect({ out: out2026, budgetFile, plan: plan2026, ...options });
  assert.equal(calls, 10);
  assert.equal(fresh.calls, 10);
  const registry = await readJson(budgetFile);
  assert.equal(registry.initialCalls + registry.attempts.length, MAX_CALLS);
  assert(registry.attempts.every((a) => a.planHash === sha256(JSON.stringify(plan2026))));
  // 11e appel refusé avant le réseau, quel que soit le plan ou le dossier.
  await assert.rejects(
    collect({ out: join(root, 'eleventh'), budgetFile, ...options }),
    /Budget global maximal/,
  );
  await assert.rejects(
    collect({
      out: join(root, 'eleventh-league'),
      budgetFile,
      plan: { ...plan2026, leagues: [...plan2026.leagues, 71] },
      ...options,
    }),
    /Budget global maximal/,
  );
  assert.equal(calls, 10, 'Onzième appel refusé par le registre initialisé à --used 20');
  const cli = await run(
    process.execPath,
    ['scripts/backtest/collect.mjs', '--plan', 'scripts/backtest/plan-2026.json', '--out', out2026],
    {
      cwd: repoRoot,
      env: { ...process.env, BACKTEST_BUDGET_FILE: budgetFile, API_FOOTBALL_KEY: '' },
    },
  );
  assert.equal(JSON.parse(cli.stdout).sha256, fresh.sha256, 'Reprise CLI depuis le cache');
  await assert.rejects(
    run(
      process.execPath,
      ['scripts/backtest/collect.mjs', '--plan', 'absent.json', '--out', out2026],
      {
        cwd: repoRoot,
        env: { ...process.env, BACKTEST_BUDGET_FILE: budgetFile },
      },
    ),
    (e) => /Plan illisible/.test(e.stderr),
  );
  assert.equal(calls, 10);

  // Date de collecte écrite dans le jeu ; matchs à venir comptés.
  const freshDataset = await readJson(fresh.path);
  assert.equal(freshDataset.collection.collectedAt, new Date(collectedAt).toISOString());
  assert.equal(freshDataset.collection.testEnd, '2026-10-14');
  assert.equal(fresh.testEnd, '2026-10-14');
  // Journées 0 à 5 jouées (dont celle du 14/10), 8 restantes non jouées, par ligue.
  assert.deepEqual(freshDataset.collection.statuses, { FT: 240, NS: 320 });

  // Runner : historique épinglé (apprentissage) + jeu neuf (période test), sur une ligue.
  const historyPlan = {
    schemaVersion: 1,
    seasons: [2024, 2025],
    leagues: [39],
    developmentStart: '2025-01-01',
    testStart: '2025-07-01',
    testEnd: '2026-07-01',
    bootstrapReplicates: 200,
    seed: 167,
  };
  const smallBudget = join(root, 'small-budget.json');
  await initializeBudget({ budgetFile: smallBudget, used: 0, reason: 'Test isolé' });
  const history = await collect({
    out: join(root, 'history'),
    budgetFile: smallBudget,
    plan: historyPlan,
    ...options,
  });
  const freshPlan = {
    ...plan2026,
    leagues: [39],
    bootstrapReplicates: 200,
    history: { sha256: history.sha256, planHash: sha256(JSON.stringify(historyPlan)) },
  };
  const current = await collect({
    out: join(root, 'fresh'),
    budgetFile: smallBudget,
    plan: freshPlan,
    ...options,
  });
  const report = await writeReport(current.path, join(root, 'report'), { history: history.path });
  const full = await readJson(join(root, 'report', 'report.json'));
  assert.deepEqual(full.plan.seasons, [2024, 2025, 2026]);
  assert.equal(full.plan.testEnd, '2026-10-14');
  assert.equal(full.plan.history, undefined);
  assert.equal(full.sources.history.sha256, history.sha256);
  assert.equal(full.sources.current.sha256, current.sha256);
  assert.equal(full.coverage.input, 3 * 56, 'Chaque rencontre une seule fois');
  assert.equal(report.matches, 20, 'Cinq journées 2026 avant la date de collecte');
  assert.deepEqual(full.coverage.afterTestEnd, { count: 36, byStatus: { FT: 4, NS: 32 } });
  assert(full.test.forecasts.length > 0);
  assert(full.test.forecasts.every((r) => r.day >= '2026-07-01' && r.day < '2026-10-14'));
  assert(full.development.forecasts.every((r) => r.day >= '2025-07-01' && r.day < '2026-07-01'));
  const md = await readFile(join(root, 'report', 'rapport-backtest.md'), 'utf8');
  assert(md.includes('Période neuve (BIS-185)') && md.includes('ni évaluées ni apprises : 36'));

  // Mélanges incohérents refusés.
  await assert.rejects(writeReport(current.path, join(root, 'r1')), /--history/);
  await assert.rejects(
    writeReport(history.path, join(root, 'r2'), { history: history.path }),
    /--history/,
  );
  const bytes = await readFile(history.path, 'utf8');
  await writeFile(history.path, bytes + ' ');
  await assert.rejects(
    writeReport(current.path, join(root, 'r3'), { history: history.path }),
    /altéré/,
  );
  await writeFile(history.path, bytes);
  const otherBudget = join(root, 'other-budget.json');
  await initializeBudget({ budgetFile: otherBudget, used: 0, reason: 'Test isolé' });
  const other = await collect({
    out: join(root, 'other-history'),
    budgetFile: otherBudget,
    plan: { ...historyPlan, seed: 168 },
    ...options,
  });
  await assert.rejects(
    writeReport(current.path, join(root, 'r4'), { history: other.path }),
    /épinglé/,
  );
  const h = await readJson(history.path),
    c = await readJson(current.path);
  const mix = (edit) => {
    const input = { history: structuredClone(h), current: structuredClone(c) };
    edit(input);
    return () =>
      combineDatasets({ ...input, historySha256: history.sha256, currentSha256: current.sha256 });
  };
  const combined = mix(() => {})();
  assert.throws(
    mix((x) => (x.current.fixtures[0].fixture.id = h.fixtures[0].fixture.id)),
    /deux jeux/,
  );
  assert.throws(
    mix((x) => (x.current.plan.leagues = [39, 61])),
    /épinglé|Ligues/,
  );
  assert.throws(
    mix((x) => (x.current.collection.testEnd = '2026-10-15')),
    /Date de collecte/,
  );
  assert.throws(
    mix((x) => (x.current.collection.collectedAt = '2026-06-30T20:00:00Z')),
    /Date de collecte/,
  );
  assert.throws(
    mix((x) => {
      const f = x.history.fixtures.at(-1);
      f.fixture.date = '2026-07-02T14:00:00.000Z';
      f.fixture.timestamp = Date.parse(f.fixture.date) / 1000;
    }),
    /empiétant/,
  );
  assert.throws(
    mix((x) => (x.history.kind = 'demonstration')),
    /Jeu de résultats invalide|natures/,
  );

  // Anti-fuite : aucun résultat de la période neuve n'est appris avant sa journée.
  const base = runBacktest(combined);
  const testDays = [...new Set(base.test.forecasts.map((r) => r.day))];
  assert(testDays.length >= 3);
  const strip = (rows) => rows.map(({ won, ...r }) => r);
  const upTo = (r, day) => strip(r.test.forecasts.filter((x) => x.day <= day));
  for (const day of testDays.slice(0, 3)) {
    const mutated = structuredClone(combined);
    for (const f of mutated.fixtures)
      if (fixedDay(f.fixture.date) >= day && f.goals.home !== null) {
        f.goals.home = 9;
        f.goals.away = 0;
      }
    const changed = runBacktest(mutated);
    assert.deepEqual(upTo(changed, day), upTo(base, day), `Fuite détectée le ${day}`);
    assert.deepEqual(changed.dixonColes.chosen, base.dixonColes.chosen);
    assert.deepEqual(changed.dixonColes.developmentGrid, base.dixonColes.developmentGrid);
    assert.deepEqual(changed.development.forecasts, base.development.forecasts);
  }
  // Témoin : les résultats d'une journée neuve nourrissent bien les journées suivantes.
  const learned = structuredClone(combined);
  for (const f of learned.fixtures)
    if (fixedDay(f.fixture.date) === testDays[0]) f.goals = { home: 9, away: 0 };
  assert.notDeepEqual(
    strip(runBacktest(learned).test.forecasts.filter((x) => x.day === testDays[1])),
    strip(base.test.forecasts.filter((x) => x.day === testDays[1])),
  );
  // Rencontres postérieures à la collecte : ni évaluées ni apprises, même jouées.
  const late = structuredClone(combined);
  for (const f of late.fixtures)
    if (fixedDay(f.fixture.date) >= '2026-10-14') {
      f.fixture.status.short = 'FT';
      f.goals = { home: 5, away: 5 };
    }
  assert.deepEqual(strip(runBacktest(late).test.forecasts), strip(base.test.forecasts));
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log(
  'Passed: plan 2026 (10 couples), default plan hash unchanged, archived budget at --used 20 refuses an 11th call, collection date, pinned history, consistent mix, no leakage.',
);
