// Modèle Dixon-Coles réservé au banc (BIS-183) : aucun import depuis la production,
// aucune écriture, aucun réseau. Il n'alimente ni la politique ni les coupons réels.
import { dayStart, fixedDay } from './data.mjs';

export const DIXON_COLES_VERSION = 'dixon-coles-v1';

// Grille FIXE, écrite dans le rapport. ξ par jour (demi-vie ln 2 / ξ) ; ridge = précision
// du prior gaussien centré sur la moyenne de la ligue pour chaque attaque et défense.
export const DIXON_COLES_GRID = Object.freeze({
  xi: Object.freeze([0, 0.001, 0.002, 0.004]),
  ridge: Object.freeze([1, 4, 16]),
});
// Règle de choix, évaluée sur la saison de développement uniquement.
export const SELECTION_RULE = Object.freeze({
  markets: Object.freeze(['Match Winner', 'Goals Over/Under', 'Both Teams Score']),
  minTeamMatches: 8,
  criterion:
    'moyenne, sur 1X2, Plus/moins 2,5 et « les deux marquent », du Brier moyen par événement ; égalité : premier point de la grille',
});
// Une équipe sous ce nombre de matchs de ligue antérieurs est dominée par le rétrécissement.
export const LOW_HISTORY_MATCHES = 19;
// |ρ| borné par ρ = 0,2 × tanh(z) : τ reste positif pour λ, μ < 5 et λμ < 5, et un petit
// échantillon ne pousse pas ρ au bord du domaine. Borne structurelle fixe, non ajustée.
export const RHO_BOUND = 0.2;
const MAX_ITERATIONS = 500;
const HISTORY = 8;

// Probabilités jointes des scores. La correction ρ ne touche que 0-0, 1-0, 0-1 et 1-1 ;
// elle conserve la masse totale. La troncature garde une queue de Poisson < 1e-15 par côté.
export function scoreMatrix(homeGoals, awayGoals, rho) {
  const side = (lambda) => {
    const p = [Math.exp(-lambda)];
    let cdf = p[0];
    while (1 - cdf > 1e-15 && p.length < 60) {
      p.push((p.at(-1) * lambda) / p.length);
      cdf += p.at(-1);
    }
    return p;
  };
  const h = side(homeGoals),
    a = side(awayGoals);
  const matrix = h.map((ph) => a.map((pa) => ph * pa));
  matrix[0][0] *= 1 - homeGoals * awayGoals * rho;
  matrix[0][1] *= 1 + homeGoals * rho;
  matrix[1][0] *= 1 + awayGoals * rho;
  matrix[1][1] *= 1 - rho;
  return matrix;
}

const wins = {
  'Match Winner': { Home: (i, j) => i > j, Draw: (i, j) => i === j, Away: (i, j) => i < j },
  'Goals Over/Under': { 'Over 2.5': (i, j) => i + j > 2.5, 'Under 2.5': (i, j) => i + j < 2.5 },
  'Both Teams Score': { Yes: (i, j) => i > 0 && j > 0, No: (i, j) => i === 0 || j === 0 },
  'Double Chance': {
    'Home/Draw': (i, j) => i >= j,
    'Draw/Away': (i, j) => j >= i,
    'Home/Away': (i, j) => i !== j,
  },
};

export function matrixProbability(matrix, market, selection) {
  const test = wins[market]?.[selection];
  if (!test) throw Error('Marché non pris en charge par le banc Dixon-Coles.');
  let p = 0;
  for (let i = 0; i < matrix.length; i++)
    for (let j = 0; j < matrix[i].length; j++) if (test(i, j)) p += matrix[i][j];
  return Math.min(1, Math.max(0, p));
}

// Moins log-vraisemblance pondérée + ridge, et gradient projeté sur Σattaques = Σdéfenses = 0.
// Paramètres : [intercept, terrain, z, attaques…, défenses…] avec ρ = RHO_BOUND × tanh(z) ;
// une défense positive concède plus.
function objective(x, data, n, ridge, g) {
  g.fill(0);
  let f = 0;
  for (let k = 0; k < data.count; k++) {
    const i = data.home[k],
      j = data.away[k],
      x0 = data.homeGoals[k],
      y0 = data.awayGoals[k],
      w = data.weight[k];
    const eh = x[0] + x[1] + x[3 + i] + x[3 + n + j],
      ea = x[0] + x[3 + j] + x[3 + n + i];
    const lh = Math.exp(eh),
      la = Math.exp(ea),
      rho = RHO_BOUND * Math.tanh(x[2]);
    let tau = 1,
      dh = 0,
      da = 0,
      dr = 0;
    if (x0 === 0 && y0 === 0) {
      tau = 1 - lh * la * rho;
      dh = da = -(lh * la * rho) / tau;
      dr = -(lh * la) / tau;
    } else if (x0 === 0 && y0 === 1) {
      tau = 1 + lh * rho;
      dh = (lh * rho) / tau;
      dr = lh / tau;
    } else if (x0 === 1 && y0 === 0) {
      tau = 1 + la * rho;
      da = (la * rho) / tau;
      dr = la / tau;
    } else if (x0 === 1 && y0 === 1) {
      tau = 1 - rho;
      dr = -1 / tau;
    }
    if (!(tau > 1e-12)) return Infinity;
    f -= w * (Math.log(tau) + x0 * eh - lh + y0 * ea - la);
    const gh = -w * (x0 - lh + dh),
      ga = -w * (y0 - la + da);
    g[0] += gh + ga;
    g[1] += gh;
    g[2] -= w * dr * RHO_BOUND * (1 - Math.tanh(x[2]) ** 2);
    g[3 + i] += gh;
    g[3 + n + j] += gh;
    g[3 + j] += ga;
    g[3 + n + i] += ga;
  }
  for (let t = 0; t < 2 * n; t++) {
    f += 0.5 * ridge * x[3 + t] ** 2;
    g[3 + t] += ridge * x[3 + t];
  }
  for (const offset of [3, 3 + n]) {
    let mean = 0;
    for (let t = 0; t < n; t++) mean += g[offset + t] / n;
    for (let t = 0; t < n; t++) g[offset + t] -= mean;
  }
  return f;
}

const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

// L-BFGS déterministe avec recherche linéaire d'Armijo. Les directions restent dans le
// sous-espace Σ = 0 car elles combinent des gradients projetés.
export function fitLeague(data, n, ridge, start) {
  const p = 3 + 2 * n,
    x = Float64Array.from(start),
    g = new Float64Array(p),
    trial = new Float64Array(p),
    gTrial = new Float64Array(p);
  let f = objective(x, data, n, ridge, g);
  const total = data.weight.subarray(0, data.count).reduce((s, w) => s + w, 0);
  const tolerance = 1e-6 * (1 + total);
  const memory = [];
  if (!Number.isFinite(f)) return { x, converged: false, iterations: 0 };
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (g.reduce((m, v) => Math.max(m, Math.abs(v)), 0) < tolerance)
      return { x, converged: true, iterations: iteration };
    const d = Float64Array.from(g, (v) => -v);
    const alphas = [];
    for (let m = memory.length - 1; m >= 0; m--) {
      const { s, y, r } = memory[m],
        a = r * dot(s, d);
      alphas.push(a);
      for (let t = 0; t < p; t++) d[t] -= a * y[t];
    }
    const last = memory.at(-1);
    const scale = last ? dot(last.s, last.y) / dot(last.y, last.y) : 1 / (1 + total);
    for (let t = 0; t < p; t++) d[t] *= scale;
    for (let m = 0; m < memory.length; m++) {
      const { s, y, r } = memory[m],
        b = r * dot(y, d),
        a = alphas[memory.length - 1 - m];
      for (let t = 0; t < p; t++) d[t] += s[t] * (a - b);
    }
    let slope = dot(g, d);
    if (!(slope < 0)) {
      for (let t = 0; t < p; t++) d[t] = -g[t] / (1 + total);
      slope = dot(g, d);
      memory.length = 0;
    }
    let step = 1,
      fTrial = Infinity;
    for (let k = 0; k < 60; k++) {
      for (let t = 0; t < p; t++) trial[t] = x[t] + step * d[t];
      fTrial = objective(trial, data, n, ridge, gTrial);
      if (fTrial <= f + 1e-4 * step * slope) break;
      step /= 2;
    }
    if (!(fTrial <= f + 1e-4 * step * slope)) return { x, converged: false, iterations: iteration };
    const s = Float64Array.from(trial, (v, t) => v - x[t]),
      y = Float64Array.from(gTrial, (v, t) => v - g[t]),
      sy = dot(s, y);
    if (sy > 1e-12) {
      memory.push({ s, y, r: 1 / sy });
      if (memory.length > 10) memory.shift();
    }
    x.set(trial);
    g.set(gTrial);
    f = fTrial;
  }
  return { x, converged: false, iterations: MAX_ITERATIONS };
}

// Prévisionniste incrémental : apprend une journée seulement après toutes ses prédictions.
// Chaque ligue est réajustée au plus une fois par journée, à chaud depuis son dernier ajustement.
// Sans paramètres choisis en développement, aucune prédiction : chaque rencontre est exclue.
export function createDixonColes(chosen) {
  const { xi, ridge } = chosen || {};
  const leagues = new Map();
  const stats = {
    fits: 0,
    iterations: 0,
    maxIterations: 0,
    nonConverged: 0,
    predictions: 0,
    lowHistoryPredictions: 0,
    rhoAtBound: 0,
  };
  const league = (id) => {
    if (!leagues.has(id)) {
      const capacity = 4096;
      leagues.set(id, {
        teams: new Map(),
        lastDay: '',
        data: {
          count: 0,
          home: new Int32Array(capacity),
          away: new Int32Array(capacity),
          homeGoals: new Int32Array(capacity),
          awayGoals: new Int32Array(capacity),
          weight: new Float64Array(capacity),
        },
        times: [],
        warm: null,
        fitDay: null,
        fit: null,
      });
    }
    return leagues.get(id);
  };
  const team = (L, id) => {
    if (!L.teams.has(id)) L.teams.set(id, { index: L.teams.size, matches: 0 });
    return L.teams.get(id);
  };

  function refit(L, now) {
    const n = L.teams.size,
      data = L.data;
    for (let k = 0; k < data.count; k++)
      data.weight[k] = Math.exp((-xi * (now - L.times[k])) / 86400000);
    const start = new Float64Array(3 + 2 * n);
    if (L.warm) {
      const m = (L.warm.length - 3) / 2;
      start.set(L.warm.subarray(0, 3));
      // Un z saturé (début de ligue, peu de matchs) annulerait le gradient de ρ : on le recadre.
      start[2] = Math.max(-1, Math.min(1, start[2]));
      start.set(L.warm.subarray(3, 3 + m), 3);
      start.set(L.warm.subarray(3 + m), 3 + n);
      // Nouvelles équipes à la moyenne de la ligue, puis recentrage à prédictions inchangées.
      for (const offset of [3, 3 + n]) {
        let mean = 0;
        for (let t = 0; t < n; t++) mean += start[offset + t] / n;
        for (let t = 0; t < n; t++) start[offset + t] -= mean;
        start[0] += mean;
      }
    } else {
      let goals = 0;
      for (let k = 0; k < data.count; k++) goals += data.homeGoals[k] + data.awayGoals[k];
      start[0] = Math.log(Math.max(0.1, goals / (2 * data.count)));
      start[1] = 0.2;
    }
    const fit = fitLeague(data, n, ridge, start);
    stats.fits++;
    stats.iterations += fit.iterations;
    stats.maxIterations = Math.max(stats.maxIterations, fit.iterations);
    if (!fit.converged) stats.nonConverged++;
    else L.warm = fit.x;
    if (Math.abs(Math.tanh(fit.x[2])) > 0.99) stats.rhoAtBound++;
    return fit;
  }

  return {
    stats,
    // Retourne soit les taux et la matrice, soit { reason } compté comme exclusion.
    predict(f, day) {
      if (!chosen) return { reason: 'dixon_coles_no_development_selection' };
      const L = league(f.league.id);
      if (L.lastDay >= day) throw Error('Fuite : historique du jour même ou postérieur.');
      const home = L.teams.get(f.teams.home.id),
        away = L.teams.get(f.teams.away.id);
      if (!home || !away) return { reason: 'dixon_coles_unknown_team' };
      if (L.fitDay !== day) {
        L.fit = refit(L, dayStart(day));
        L.fitDay = day;
      }
      if (!L.fit.converged) return { reason: 'dixon_coles_non_convergence' };
      const x = L.fit.x,
        n = L.teams.size;
      const homeGoals = Math.exp(x[0] + x[1] + x[3 + home.index] + x[3 + n + away.index]),
        awayGoals = Math.exp(x[0] + x[3 + away.index] + x[3 + n + home.index]);
      const rho = RHO_BOUND * Math.tanh(x[2]);
      const matrix = scoreMatrix(homeGoals, awayGoals, rho);
      if (matrix[0][0] < 0 || matrix[0][1] < 0 || matrix[1][0] < 0 || matrix[1][1] < 0)
        return { reason: 'dixon_coles_invalid_probability' };
      stats.predictions++;
      if (Math.min(home.matches, away.matches) < LOW_HISTORY_MATCHES) stats.lowHistoryPredictions++;
      return {
        homeGoals,
        awayGoals,
        rho,
        probability: (market, selection) => matrixProbability(matrix, market, selection),
      };
    },
    learn(f) {
      if (f.fixture.status.short !== 'FT') return;
      const L = league(f.league.id),
        day = fixedDay(f.fixture.date);
      if (day < L.lastDay) throw Error('Apprentissage hors ordre chronologique.');
      L.lastDay = day;
      const home = team(L, f.teams.home.id),
        away = team(L, f.teams.away.id),
        data = L.data;
      if (data.count === data.home.length)
        for (const key of ['home', 'away', 'homeGoals', 'awayGoals', 'weight']) {
          const bigger = new data[key].constructor(2 * data[key].length);
          bigger.set(data[key]);
          data[key] = bigger;
        }
      data.home[data.count] = home.index;
      data.away[data.count] = away.index;
      data.homeGoals[data.count] = f.goals.home;
      data.awayGoals[data.count] = f.goals.away;
      data.count++;
      L.times.push(f.fixture.timestamp * 1000);
      home.matches++;
      away.matches++;
    },
  };
}

const groupByDay = (fixtures) => {
  const batches = new Map();
  for (const f of fixtures) {
    const day = fixedDay(f.fixture.date);
    if (!batches.has(day)) batches.set(day, []);
    batches.get(day).push(f);
  }
  return batches;
};

// Choix de (ξ, ridge) : seules les journées antérieures à testStart sont transmises,
// la saison test n'est donc jamais lue à cette étape. Entrée : rencontres triées.
export function selectDixonColes(fixtures, plan) {
  const past = fixtures.filter((f) => fixedDay(f.fixture.date) < plan.testStart);
  const batches = groupByDay(past);
  const grid = [];
  for (const xi of DIXON_COLES_GRID.xi)
    for (const ridge of DIXON_COLES_GRID.ridge) {
      const model = createDixonColes({ xi, ridge });
      const counts = new Map(),
        sums = Object.fromEntries(SELECTION_RULE.markets.map((m) => [m, { brier: 0, n: 0 }]));
      let failures = 0;
      for (const [day, matches] of batches) {
        const now = dayStart(day);
        if (day >= plan.developmentStart)
          for (const f of matches) {
            if (f.fixture.status.short !== 'FT' || f.fixture.timestamp * 1000 <= now) continue;
            const key = (side) => `${f.league.id}:${f.teams[side].id}`;
            if (Math.min(counts.get(key('home')) || 0, counts.get(key('away')) || 0) < HISTORY)
              continue;
            const prediction = model.predict(f, day);
            if (prediction.reason) {
              failures++;
              continue;
            }
            for (const market of SELECTION_RULE.markets)
              for (const selection of Object.keys(wins[market])) {
                const won = Number(wins[market][selection](f.goals.home, f.goals.away));
                sums[market].brier += (prediction.probability(market, selection) - won) ** 2;
                sums[market].n++;
              }
          }
        for (const f of matches) {
          model.learn(f);
          if (f.fixture.status.short === 'FT')
            for (const side of ['home', 'away']) {
              const key = `${f.league.id}:${f.teams[side].id}`;
              counts.set(key, (counts.get(key) || 0) + 1);
            }
        }
      }
      const perMarket = Object.fromEntries(
        Object.entries(sums).map(([m, s]) => [m, s.n ? s.brier / s.n : null]),
      );
      const values = Object.values(perMarket);
      grid.push({
        xi,
        ridge,
        halfLifeDays: xi ? Math.log(2) / xi : null,
        score: values.every(Number.isFinite)
          ? values.reduce((s, v) => s + v, 0) / values.length
          : null,
        perMarket,
        events: Object.values(sums).reduce((s, x) => s + x.n, 0),
        failures,
        fits: model.stats.fits,
        nonConverged: model.stats.nonConverged,
      });
    }
  // Un point avec un échec d'ajustement n'est retenu que si tous en ont.
  const valid = grid.filter((r) => Number.isFinite(r.score));
  const clean = valid.filter((r) => r.failures === 0);
  const pool = clean.length ? clean : valid;
  if (!pool.length) return { chosen: null, grid };
  const best = pool.reduce((b, r) => (r.score < b.score ? r : b));
  return { chosen: { xi: best.xi, ridge: best.ridge }, grid };
}

// Verdict mécanique sur la différence appariée de Brier Dixon-Coles − Poisson.
export function verdict(difference) {
  const ci = difference?.interval95;
  if (!ci || !Number.isFinite(difference.estimate)) return 'indistinct';
  if (difference.estimate < 0 && ci[1] < 0) return 'meilleur';
  if (difference.estimate > 0 && ci[0] > 0) return 'pire';
  return 'indistinct';
}
