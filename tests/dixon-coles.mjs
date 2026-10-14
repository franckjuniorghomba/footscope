import assert from 'node:assert/strict';
import { readJson, fixedDay } from '../scripts/backtest/data.mjs';
import { EVENTS, runBacktest } from '../scripts/backtest/engine.mjs';
import {
  DIXON_COLES_GRID,
  RHO_BOUND,
  createDixonColes,
  fitLeague,
  matrixProbability,
  scoreMatrix,
  selectDixonColes,
  verdict,
} from '../scripts/backtest/dixon-coles.mjs';
import { eventProbability } from '../src/server/statistics.js';

// Justesse : masse totale 1 à 1e-9, ρ appliqué seulement à 0-0, 1-0, 0-1, 1-1.
for (const [lh, la] of [
  [0.3, 0.2],
  [1.4, 1.1],
  [2.9, 0.6],
  [4.5, 3.8],
])
  for (const rho of [-RHO_BOUND, -0.08, 0, 0.05, RHO_BOUND]) {
    const m = scoreMatrix(lh, la, rho),
      base = scoreMatrix(lh, la, 0);
    assert(Math.abs(m.flat().reduce((s, p) => s + p, 0) - 1) < 1e-9, `masse ${lh} ${la} ${rho}`);
    for (let i = 0; i < m.length; i++)
      for (let j = 0; j < m[i].length; j++)
        if (i > 1 || j > 1) assert.equal(m[i][j], base[i][j], `score ${i}-${j} intact`);
    assert.equal(m[0][0], base[0][0] * (1 - lh * la * rho));
    assert.equal(m[0][1], base[0][1] * (1 + lh * rho));
    assert.equal(m[1][0], base[1][0] * (1 + la * rho));
    assert.equal(m[1][1], base[1][1] * (1 - rho));
    if (rho) assert.notEqual(m[1][1], base[1][1]);
  }
// ρ = 0 : mêmes probabilités de marché que le Poisson indépendant de production.
for (const [market, selection] of EVENTS)
  assert(
    Math.abs(
      matrixProbability(scoreMatrix(1.7, 0.9, 0), market, selection) -
        eventProbability(market, selection, 1.7, 0.9),
    ) < 1e-12,
  );
assert.throws(() => matrixProbability(scoreMatrix(1, 1, 0), 'Corners', 'Over 9.5'));

// Ajustement : retrouve des paramètres simulés et respecte Σattaques = Σdéfenses = 0.
let seed = 183;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const poisson = (lambda) => {
  let k = 0,
    p = Math.exp(-lambda),
    u = random(),
    cdf = p;
  while (u > cdf) {
    k++;
    p *= lambda / k;
    cdf += p;
  }
  return k;
};
const n = 6,
  attack = [0.3, 0.1, 0, -0.05, -0.15, -0.2],
  defense = [-0.25, -0.1, 0, 0.05, 0.1, 0.2],
  rounds = 40;
const size = n * (n - 1) * rounds;
const data = {
  count: 0,
  home: new Int32Array(size),
  away: new Int32Array(size),
  homeGoals: new Int32Array(size),
  awayGoals: new Int32Array(size),
  weight: new Float64Array(size).fill(1),
};
for (let r = 0; r < rounds; r++)
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const k = data.count++;
      data.home[k] = i;
      data.away[k] = j;
      data.homeGoals[k] = poisson(Math.exp(0.1 + 0.25 + attack[i] + defense[j]));
      data.awayGoals[k] = poisson(Math.exp(0.1 + attack[j] + defense[i]));
    }
const start = new Float64Array(3 + 2 * n);
const fit = fitLeague(data, n, 1, start);
assert(fit.converged, 'Ajustement convergé');
const sum = (from) => fit.x.subarray(from, from + n).reduce((s, v) => s + v, 0);
assert(Math.abs(sum(3)) < 1e-9 && Math.abs(sum(3 + n)) < 1e-9, 'Contraintes Σ = 0');
assert(Math.abs(fit.x[1] - 0.25) < 0.08, `Avantage du terrain ${fit.x[1]}`);
for (let t = 0; t < n; t++) assert(Math.abs(fit.x[3 + t] - attack[t]) < 0.12, `attaque ${t}`);
assert(
  fitLeague(data, n, 1, fit.x).iterations <= 1,
  'Départ à chaud depuis l’optimum : arrêt immédiat',
);

// Anti-fuite du prévisionniste : prédire après avoir appris la journée est refusé.
const demo = await readJson('tests/fixtures/backtest-demo.json');
const sorted = [...demo.fixtures].sort((a, b) => a.fixture.timestamp - b.fixture.timestamp);
const model = createDixonColes({ xi: 0, ridge: 4 });
for (const f of sorted.slice(0, 20)) model.learn(f);
const nextDay = fixedDay(sorted[20].fixture.date),
  learnedDay = fixedDay(sorted[19].fixture.date);
assert.throws(() => model.predict(sorted[19], learnedDay), /Fuite/);
const prediction = model.predict(sorted[20], nextDay);
assert(Number.isFinite(prediction.homeGoals) && Math.abs(prediction.rho) <= RHO_BOUND);
const stranger = structuredClone(sorted[20]);
stranger.teams.home.id = 999999;
assert.equal(model.predict(stranger, nextDay).reason, 'dixon_coles_unknown_team');
assert.equal(
  createDixonColes(null).predict(sorted[20], nextDay).reason,
  'dixon_coles_no_development_selection',
);

// Choix de (ξ, ridge) : grille complète, et la saison test n'influence pas le choix.
const report = runBacktest(demo);
assert.equal(
  report.dixonColes.developmentGrid.length,
  DIXON_COLES_GRID.xi.length * DIXON_COLES_GRID.ridge.length,
);
assert(report.dixonColes.chosen);
const futureChanged = structuredClone(demo);
for (const f of futureChanged.fixtures)
  if (fixedDay(f.fixture.date) >= demo.plan.testStart) {
    f.goals.home = 7;
    f.goals.away = 0;
  }
const changed = runBacktest(futureChanged);
assert.deepEqual(changed.dixonColes.developmentGrid, report.dixonColes.developmentGrid);
assert.deepEqual(changed.dixonColes.chosen, report.dixonColes.chosen);
assert.deepEqual(
  selectDixonColes(sorted, demo.plan),
  selectDixonColes(
    sorted.filter((f) => fixedDay(f.fixture.date) < demo.plan.testStart),
    demo.plan,
  ),
  'Le choix ne reçoit aucune rencontre de test',
);
// Même ensemble d'événements pour tous les modèles, colonne Dixon-Coles toujours définie.
for (const phase of [report.development, report.test])
  for (const row of phase.forecasts)
    assert(row.dixonColesProbability >= 0 && row.dixonColesProbability <= 1);
for (const ticket of report.test.ticketRecords)
  assert.equal(
    ticket.dixonColesProbability,
    ticket.selections.reduce((p, r) => p * r.dixonColesProbability, 1),
  );
for (const group of Object.values(report.test.allEvents)) {
  assert.equal(group.dixonColes.count, group.poisson.count);
  assert(Number.isFinite(group.dixonColes.ece));
  assert(group.intervals.dixonColesBrierDifference.interval95);
}
assert.equal(report.modelValidated, false);
assert.equal(report.realMoneyEligible, false);
// Aucune prédiction possible sans saison de développement : exclusions comptées, pas de silence.
const noDevelopment = structuredClone(demo);
noDevelopment.fixtures = noDevelopment.fixtures.filter(
  (f) => fixedDay(f.fixture.date) >= demo.plan.testStart,
);
const blind = runBacktest(noDevelopment);
assert.equal(blind.dixonColes.chosen, null);
assert.equal(blind.test.forecasts.length, 0);

// Verdict mécanique.
assert.equal(verdict({ estimate: -0.01, interval95: [-0.02, -0.001] }), 'meilleur');
assert.equal(verdict({ estimate: 0.01, interval95: [0.001, 0.02] }), 'pire');
assert.equal(verdict({ estimate: -0.01, interval95: [-0.02, 0.00001] }), 'indistinct');
assert.equal(verdict({ estimate: null, interval95: null }), 'indistinct');

console.log(
  'Passed: Dixon-Coles score mass, ρ on four scores only, Poisson parity at ρ=0, constrained fit, no leakage, development-only selection, mechanical verdict.',
);
