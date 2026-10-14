// BIS-184 : deux sélections de tickets sur les mêmes journées, banc uniquement.
// (A) actuelle : Poisson, probabilité prudente ; (B) Dixon-Coles moins une marge m.
// Mêmes autres règles : fraîcheur, seuil de jambe, produit ≥ 0,5, un pari par match,
// quatre sélections au plus, via le même sélecteur de production.
import { selectCouponDetailed } from '../../src/server/coupon.js';
import { POLICY } from '../../src/server/policy.js';
import { dayStart } from './data.mjs';

export const SIZES = [1, 2, 3, 4];
export const LOW_SAMPLE = 30;
export const RELIABLE_GAP = 0.05;

// Règle de la marge, écrite avant tout calcul et avant toute lecture de 2026/27.
export const MARGIN_GRID = Object.freeze(Array.from({ length: 21 }, (_, i) => i / 100));
export const MARGIN_RULE = Object.freeze({
  period: 'saison de développement 2024/25 (2024-07-01 → 2025-06-30, GMT−5)',
  grid: '0 à 0,20 par pas de 0,01',
  condition:
    'tickets B composés avec m : annoncé moyen ≤ passage observé, au total et pour chaque taille comptant au moins 30 tickets',
  choice:
    'plus petit m de la grille qui remplit la condition ; à défaut, m = 0,20 (plafond, signalé)',
  minSizeTickets: LOW_SAMPLE,
});

export const selectionA = Object.freeze({
  name: 'A',
  label: 'actuelle : Poisson, probabilité prudente',
  candidate: (r) => r.recentHistory && r.probability >= POLICY.minProbability,
  announced: (r) => r.prudentProbability,
});
export function selectionB(margin) {
  if (!MARGIN_GRID.includes(margin)) throw Error('Marge hors de la grille figée.');
  return Object.freeze({
    name: 'B',
    label: `Dixon-Coles − ${margin}`,
    margin,
    candidate: (r) => r.recentHistory && r.dixonColesProbability >= POLICY.minProbability,
    announced: (r) => Math.max(0, r.dixonColesProbability - margin),
  });
}

const product = (xs) => xs.reduce((p, x) => p * x, 1);

// Un ticket au plus par journée, composé par selectCouponDetailed comme dans engine.mjs.
export function composeTickets(forecasts, selection) {
  const byDay = new Map();
  for (const r of forecasts) {
    if (!byDay.has(r.day)) byDay.set(r.day, new Map());
    const matches = byDay.get(r.day);
    if (!matches.has(r.matchId)) matches.set(r.matchId, []);
    matches.get(r.matchId).push(r);
  }
  const tickets = [];
  for (const [day, matches] of byDay) {
    const now = dayStart(day),
      at = new Date(now).toISOString();
    const reports = [...matches.values()].map((rows) => ({
      retrievedAt: at,
      events: rows.filter(selection.candidate).map((r) => ({
        ...r,
        prudentProbability: selection.announced(r),
        status: 'simulation_eligible',
        bookmaker: 'offline-unpriced',
        prudentEdge: 0,
        updated: at,
      })),
    }));
    const coupon = selectCouponDetailed(reports, now);
    if (!coupon.selections.length) continue;
    const legs = coupon.selections.map((e) =>
      matches.get(e.matchId).find((r) => r.market === e.market && r.selection === e.selection),
    );
    tickets.push({
      day,
      size: legs.length,
      won: Number(legs.every((r) => r.won === 1)),
      announced: coupon.ticketProbability,
      dixonColes: product(legs.map((r) => r.dixonColesProbability)),
      poissonPrudent: product(legs.map((r) => r.prudentProbability)),
      legs: legs.map(({ matchId, leagueId, market, selection, won }) => ({
        matchId,
        leagueId,
        market,
        selection,
        won,
      })),
    });
  }
  return tickets;
}

// Bootstrap de (observé − annoncé) par ticket ; un ticket par journée, donc grappes = journées.
function gapInterval(tickets, replicates, seed) {
  if (tickets.length < 2 || replicates < 1) return null;
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const n = tickets.length,
    xs = [];
  for (let b = 0; b < replicates; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const t = tickets[Math.floor(random() * n)];
      s += t.won - t.announced;
    }
    xs.push(s / n);
  }
  xs.sort((a, b) => a - b);
  const q = (p) => {
    const i = (xs.length - 1) * p,
      lo = Math.floor(i),
      hi = Math.ceil(i);
    return xs[lo] + (xs[hi] - xs[lo]) * (i - lo);
  };
  return [q(0.025), q(0.975)];
}

export function wilson(wins, n) {
  if (!n) return null;
  const z = 1.959963984540054,
    p = wins / n,
    d = 1 + (z * z) / n,
    c = (p + (z * z) / (2 * n)) / d,
    h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

// Verdict mécanique : « annoncé fiable » si l'IC de (observé − annoncé) contient 0
// et que l'écart absolu est < 5 points ; sinon « optimiste » (observé < annoncé) ou « pessimiste ».
export function verdict(row) {
  if (!row.count) return 'non défini';
  if (!row.gapInterval95) return 'non défini (effectif < 2)';
  const [lo, hi] = row.gapInterval95;
  if (lo <= 0 && hi >= 0 && Math.abs(row.gap) < RELIABLE_GAP) return 'annoncé fiable';
  return row.gap < 0 ? 'optimiste' : 'pessimiste';
}

export function summarizeTickets(tickets, { days, replicates = 2000, seed = 184 } = {}) {
  const summarize = (xs) => {
    const n = xs.length,
      wins = xs.reduce((s, t) => s + t.won, 0);
    const mean = (f) => (n ? xs.reduce((s, t) => s + f(t), 0) / n : null);
    const row = {
      count: n,
      lowSample: n > 0 && n < LOW_SAMPLE,
      observed: n ? wins / n : null,
      observedInterval95: wilson(wins, n),
      announced: mean((t) => t.announced),
      gap: mean((t) => t.won - t.announced),
      gapInterval95: gapInterval(xs, replicates, seed),
      brier: mean((t) => (t.announced - t.won) ** 2),
      dixonColesRaw: mean((t) => t.dixonColes),
    };
    row.verdict = verdict(row);
    return row;
  };
  return {
    days,
    tickets: tickets.length,
    noTicketDays: Number.isInteger(days) ? days - tickets.length : null,
    bySize: Object.fromEntries(
      SIZES.map((k) => [k, summarize(tickets.filter((t) => t.size === k))]),
    ),
    total: summarize(tickets),
  };
}

// Erreurs de Dixon-Coles (annoncé − observé) sur les jambes candidates, toutes tailles.
export function legErrors(forecasts) {
  const rows = forecasts.filter(selectionB(0).candidate);
  const bins = [
    [0.7, 0.8],
    [0.8, 0.9],
    [0.9, 1.0001],
  ].map(([lo, hi]) => {
    const xs = rows.filter((r) => r.dixonColesProbability >= lo && r.dixonColesProbability < hi);
    const n = xs.length;
    return {
      lower: lo,
      upper: Math.min(1, hi),
      count: n,
      announced: n ? xs.reduce((s, r) => s + r.dixonColesProbability, 0) / n : null,
      observed: n ? xs.reduce((s, r) => s + r.won, 0) / n : null,
    };
  });
  for (const b of bins) b.error = b.count ? b.announced - b.observed : null;
  const n = rows.length;
  const announced = n ? rows.reduce((s, r) => s + r.dixonColesProbability, 0) / n : null,
    observed = n ? rows.reduce((s, r) => s + r.won, 0) / n : null;
  return { count: n, announced, observed, error: n ? announced - observed : null, bins };
}

// Applique MARGIN_RULE aux seules prévisions de la période de développement.
export function chooseMargin(devForecasts) {
  const search = MARGIN_GRID.map((m) => {
    const tickets = composeTickets(devForecasts, selectionB(m));
    const s = summarizeTickets(tickets, { replicates: 0 });
    const checked = [
      s.total,
      ...SIZES.map((k) => s.bySize[k]).filter((r) => r.count >= LOW_SAMPLE),
    ];
    return {
      margin: m,
      tickets: s.tickets,
      bySize: Object.fromEntries(SIZES.map((k) => [k, s.bySize[k].count])),
      announced: s.total.announced,
      observed: s.total.observed,
      sizeChecks: SIZES.filter((k) => s.bySize[k].count >= LOW_SAMPLE).map((k) => ({
        size: k,
        announced: s.bySize[k].announced,
        observed: s.bySize[k].observed,
      })),
      satisfied: s.tickets > 0 && checked.every((r) => r.announced <= r.observed),
    };
  });
  const hit = search.find((r) => r.satisfied);
  return { margin: hit ? hit.margin : MARGIN_GRID.at(-1), ceiling: !hit, search };
}
