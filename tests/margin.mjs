import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixedDay, readJson } from '../scripts/backtest/data.mjs';
import { runBacktest } from '../scripts/backtest/engine.mjs';
import {
  MARGIN_GRID,
  chooseMargin,
  composeTickets,
  legErrors,
  selectionA,
  selectionB,
  summarizeTickets,
  verdict,
  wilson,
} from '../scripts/backtest/selection.mjs';
import { compare, conclusion, freezeMargin, writeOnce } from '../scripts/backtest/margin.mjs';
import { seasonFixtures } from './fixtures/backtest-synthetic.mjs';
import { POLICY } from '../src/server/policy.js';

const demo = await readJson('tests/fixtures/backtest-demo.json');
const base = runBacktest(demo);

// Parité : A recomposée = ticket du moteur ; un écart lève une erreur.
const result = compare(base.test, 0.05, { replicates: 200, seed: 1 });
assert.equal(result.A.tickets, base.test.tickets.count);
assert.equal(result.A.noTicketDays, base.test.noTicketDays);
const broken = structuredClone(base.test);
broken.ticketRecords.pop();
assert.throws(() => compare(broken, 0.05, { replicates: 200, seed: 1 }), /moteur/);
assert(base.test.forecasts.every((r) => typeof r.recentHistory === 'boolean' && r.kickoff));

// Règles de B : mêmes contraintes que A, probabilité Dixon-Coles moins m.
const product = (xs) => xs.reduce((p, x) => p * x, 1);
for (const m of [0, 0.03, 0.1]) {
  const tickets = composeTickets(base.test.forecasts, selectionB(m));
  const days = new Set(tickets.map((t) => t.day));
  assert.equal(days.size, tickets.length, 'Un ticket par journée');
  for (const t of tickets) {
    assert(t.size >= 1 && t.size <= POLICY.maxSelections);
    assert.equal(new Set(t.legs.map((l) => l.matchId)).size, t.size, 'Un pari par match');
    const rows = t.legs.map((l) =>
      base.test.forecasts.find(
        (r) =>
          r.day === t.day &&
          r.matchId === l.matchId &&
          r.market === l.market &&
          r.selection === l.selection,
      ),
    );
    assert(rows.every((r) => r.recentHistory && r.dixonColesProbability >= POLICY.minProbability));
    const announced = product(rows.map((r) => r.dixonColesProbability - m));
    assert(Math.abs(t.announced - announced) < 1e-12);
    assert(t.announced >= POLICY.minTicketProbability);
    assert.equal(t.won, Number(rows.every((r) => r.won === 1)));
  }
}
assert.throws(() => selectionB(0.015), /grille/);
assert.throws(() => selectionB(0.25), /grille/);

// Anti-fuite : changer les résultats à partir d'une journée ne change ni les tickets
// antérieurs ni les jambes de cette journée, pour A comme pour B.
const testDays = [...new Set(base.test.forecasts.map((r) => r.day))];
assert(testDays.length >= 3);
const legs = (tickets, day) =>
  JSON.stringify(
    tickets
      .filter((t) => t.day <= day)
      .map((t) => [t.day, t.announced, t.legs.map(({ won, ...l }) => l)]),
  );
for (const day of testDays.slice(0, 3)) {
  const mutated = structuredClone(demo);
  for (const f of mutated.fixtures)
    if (fixedDay(f.fixture.date) >= day && f.goals.home !== null) f.goals = { home: 9, away: 0 };
  const changed = runBacktest(mutated);
  for (const selection of [selectionA, selectionB(0.05)])
    assert.equal(
      legs(composeTickets(changed.test.forecasts, selection), day),
      legs(composeTickets(base.test.forecasts, selection), day),
      `Fuite détectée le ${day}`,
    );
}

// Résumés par taille : « non défini » si l'effectif est nul, IC absent sous deux tickets.
const t = (size, won, announced, day) => ({ size, won, announced, day, dixonColes: announced });
const summary = summarizeTickets([t(1, 1, 0.8, 'a'), t(1, 0, 0.7, 'b'), t(2, 1, 0.6, 'c')], {
  days: 5,
  replicates: 200,
});
assert.equal(summary.noTicketDays, 2);
assert.equal(summary.bySize[3].verdict, 'non défini');
assert.equal(summary.bySize[3].announced, null);
assert.equal(summary.bySize[2].verdict, 'non défini (effectif < 2)');
assert(summary.bySize[1].lowSample);
assert(Math.abs(summary.bySize[1].brier - (0.04 + 0.49) / 2) < 1e-12);
assert(conclusion({ A: summary, B: summary }).split('\n').length === 5);
// Verdict mécanique.
assert.equal(verdict({ count: 50, gap: 0.02, gapInterval95: [-0.05, 0.08] }), 'annoncé fiable');
assert.equal(verdict({ count: 50, gap: -0.06, gapInterval95: [-0.15, 0.02] }), 'optimiste');
assert.equal(verdict({ count: 50, gap: 0.04, gapInterval95: [0.01, 0.07] }), 'pessimiste');
assert.equal(verdict({ count: 50, gap: -0.04, gapInterval95: [-0.07, -0.01] }), 'optimiste');
const w = wilson(7, 10);
assert(w[0] < 0.7 && w[1] > 0.7 && w[0] > 0 && w[1] < 1);
assert.equal(wilson(0, 0), null);

// Règle de m : plus petit point de la grille satisfaisant la condition, ou plafond.
const choice = chooseMargin(base.development.forecasts);
assert(MARGIN_GRID.includes(choice.margin));
const first = choice.search.findIndex((r) => r.satisfied);
if (first >= 0) assert.equal(choice.margin, MARGIN_GRID[first]);
else assert(choice.ceiling && choice.margin === 0.2);
assert(legErrors(base.development.forecasts).bins.length === 3);

// Gel sur un historique synthétique : seule la saison de développement 2024/25 fixe m,
// et ξ/ridge sont choisis sans rencontre postérieure à 2026-07-01.
const collectedAt = Date.parse('2026-07-01T00:00:00Z');
const teams = Array.from({ length: 12 }, (_, i) => 3900 + i);
const history = {
  schemaVersion: 1,
  kind: 'historical',
  source: 'API-Football',
  plan: {
    schemaVersion: 1,
    seasons: [2023, 2024, 2025],
    leagues: [39],
    developmentStart: '2024-07-01',
    testStart: '2025-07-01',
    testEnd: '2026-07-01',
    bootstrapReplicates: 100,
    seed: 1,
  },
  fixtures: [2023, 2024, 2025].flatMap((s) =>
    seasonFixtures(39, s, collectedAt, { teams, spacingDays: 7 }),
  ),
};
const plan2026 = {
  developmentStart: '2025-07-01',
  testStart: '2026-07-01',
  history: { sha256: 'a'.repeat(64), planHash: 'b'.repeat(64) },
};
const frozen = freezeMargin(history, plan2026);
assert(MARGIN_GRID.includes(frozen.params.margin));
assert.equal(frozen.params.modelValidated, false);
assert.equal(frozen.params.realMoneyEligible, false);
assert(frozen.report.dixonColes.frozen);
assert(
  frozen.report.development.forecasts.every((r) => r.day >= '2024-07-01' && r.day < '2025-07-01'),
);
// Changer les résultats de 2025/26 ne change pas les erreurs mesurées sur 2024/25 à ξ/ridge figés.
const later = structuredClone(history);
for (const f of later.fixtures) if (fixedDay(f.fixture.date) >= '2025-07-01') f.goals.home = 7;
const sameModel = runBacktest(later, later.plan, { dixonColesChosen: frozen.params.dixonColes });
assert.deepEqual(chooseMargin(sameModel.development.forecasts), {
  margin: frozen.params.margin,
  ceiling: frozen.params.ceiling,
  search: frozen.params.development.search,
});

// Lecture unique : un second témoin au même endroit est refusé.
const root = await mkdtemp(join(tmpdir(), 'footscope-bis184-'));
try {
  await writeOnce(join(root, 'lecture.json'), { ok: true });
  await assert.rejects(writeOnce(join(root, 'lecture.json'), { ok: true }), /EEXIST/);
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log(
  'Passed: BIS-184 selection A parity, B rules, no leakage, size summaries, margin rule, single read.',
);
