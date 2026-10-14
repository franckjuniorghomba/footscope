import { assessMatch, eventProbability } from '../../src/server/statistics.js';
import { selectCouponDetailed } from '../../src/server/coupon.js';
import { POLICY, MODEL_VERSION } from '../../src/server/policy.js';
import { settledOutcome } from '../../src/server/storage.js';
import { defaultPlan, dayStart, fixedDay, validateDataset, validatePlan } from './data.mjs';
import { bootstrapDays, scores, scoreIntervals, ticketSummary } from './metrics.mjs';
import {
  DIXON_COLES_GRID,
  DIXON_COLES_VERSION,
  LOW_HISTORY_MATCHES,
  RHO_BOUND,
  SELECTION_RULE,
  createDixonColes,
  selectDixonColes,
} from './dixon-coles.mjs';

export const EVENTS = [
  ['Match Winner', 'Home'],
  ['Match Winner', 'Draw'],
  ['Match Winner', 'Away'],
  ['Goals Over/Under', 'Over 2.5'],
  ['Goals Over/Under', 'Under 2.5'],
  ['Both Teams Score', 'Yes'],
  ['Both Teams Score', 'No'],
  ['Double Chance', 'Home/Draw'],
  ['Double Chance', 'Draw/Away'],
  ['Double Chance', 'Home/Away'],
];

// Même enveloppe que poisson-sensitivity-v1 ; la parité est vérifiée contre assessMatch.
// Aucun prix factice n'est nécessaire pour extraire les probabilités du modèle.
export function forecast(model, market, selection) {
  const probability = eventProbability(market, selection, model.homeGoals, model.awayGoals);
  let prudentProbability = probability;
  for (const h of [0.75, 1, 1.25])
    for (const a of [0.75, 1, 1.25]) {
      prudentProbability = Math.min(
        prudentProbability,
        eventProbability(market, selection, model.homeGoals * h, model.awayGoals * a),
      );
    }
  return { probability, prudentProbability: Math.max(0, prudentProbability - 0.05) };
}

const product = (rows, key) => rows.reduce((p, r) => p * r[key], 1);
const teamKey = (f, side) => `${f.league.id}:${f.teams[side].id}`;

export function runBacktest(dataset, plan = dataset.plan || defaultPlan) {
  validateDataset(dataset);
  validatePlan(plan);
  if (
    dataset.fixtures.some(
      (f) => !plan.leagues.includes(f.league.id) || !plan.seasons.includes(f.league.season),
    )
  )
    throw Error('Le jeu contient des rencontres hors du périmètre figé.');
  const fixtures = [...dataset.fixtures].sort(
    (a, b) => a.fixture.timestamp - b.fixture.timestamp || a.fixture.id - b.fixture.id,
  );
  const batches = new Map(),
    afterTestEnd = { count: 0, byStatus: {} };
  for (const f of fixtures) {
    const day = fixedDay(f.fixture.date);
    // Ni évaluées ni apprises : matchs à venir d'une saison en cours, ou postérieurs au plan.
    if (day >= plan.testEnd) {
      afterTestEnd.count++;
      const status = f.fixture.status.short;
      afterTestEnd.byStatus[status] = (afterTestEnd.byStatus[status] || 0) + 1;
      continue;
    }
    if (!batches.has(day)) batches.set(day, []);
    batches.get(day).push(f);
  }
  const histories = new Map(),
    naiveCounts = new Map();
  // BIS-183 : (ξ, ridge) figés sur la saison de développement avant toute lecture du test.
  const dixonColesSelection = selectDixonColes(fixtures, plan);
  const dixonColes = createDixonColes(dixonColesSelection.chosen);
  const phases = { development: [], test: [] };
  const coverage = {
    input: fixtures.length,
    completed: fixtures.filter((f) => f.fixture.status.short === 'FT').length,
    byLeagueSeason: {},
    exclusions: {},
    afterTestEnd,
  };
  for (const f of fixtures) {
    const key = `${f.league.id}-${f.league.season}`;
    coverage.byLeagueSeason[key] = (coverage.byLeagueSeason[key] || 0) + 1;
  }
  const missingPairs = plan.leagues
    .flatMap((l) => plan.seasons.map((s) => `${l}-${s}`))
    .filter((k) => !coverage.byLeagueSeason[k]);
  if (dataset.kind === 'historical' && missingPairs.length)
    throw Error('Jeu historique incomplet : ligue/saison manquante.');

  for (const [day, matches] of batches) {
    const now = dayStart(day);
    const phase =
      day >= plan.testStart ? 'test' : day >= plan.developmentStart ? 'development' : null;
    const rows = [],
      reports = [];
    const exclude = (reason) => {
      const k = `${phase}:${reason}`;
      coverage.exclusions[k] = (coverage.exclusions[k] || 0) + 1;
    };
    if (phase)
      for (const f of matches) {
        if (f.fixture.status.short !== 'FT') {
          exclude('non_final');
          continue;
        }
        if (f.fixture.timestamp * 1000 <= now) {
          exclude('kickoff_at_snapshot');
          continue;
        }
        const h = histories.get(teamKey(f, 'home')) || [],
          a = histories.get(teamKey(f, 'away')) || [];
        // Le résultat cible et son statut rétrospectif ne sont jamais transmis au modèle.
        const target = {
          ...f,
          goals: { home: null, away: null },
          fixture: { ...f.fixture, status: { short: 'NS' } },
        };
        const assessment = assessMatch(
          {
            fixture: target,
            home: h,
            away: a,
            odds: [],
            errors: { odds: true, injuries: true, lineups: true },
            retrievedAt: new Date(now).toISOString(),
          },
          now,
        );
        if (!assessment.model) {
          exclude('insufficient_history');
          continue;
        }
        // Mêmes événements pour tous les modèles : un échec Dixon-Coles exclut la rencontre.
        const dc = dixonColes.predict(f, day);
        if (dc.reason) {
          exclude(dc.reason);
          continue;
        }
        const recent = [h, a].every(
          (xs) => now - xs.at(-1).fixture.timestamp * 1000 <= POLICY.maxRecentAgeDays * 86400000,
        );
        if (!recent) exclude('stale_history_for_ticket');
        const counts = naiveCounts.get(f.league.id);
        const eligible = [];
        for (const [market, selection] of EVENTS) {
          const event = { market, selection };
          const { probability, prudentProbability } = forecast(assessment.model, market, selection);
          // Fréquences de ligue avec Laplace : 3 catégories 1X2, 2 catégories binaires.
          let naiveProbability;
          if (market === 'Match Winner')
            naiveProbability = (counts.winner[selection] + 1) / (counts.n + 3);
          if (market === 'Double Chance') {
            const omitted = { 'Home/Draw': 'Away', 'Draw/Away': 'Home', 'Home/Away': 'Draw' }[
              selection
            ];
            naiveProbability = 1 - (counts.winner[omitted] + 1) / (counts.n + 3);
          }
          if (market === 'Goals Over/Under')
            naiveProbability =
              ((selection === 'Over 2.5' ? counts.over : counts.n - counts.over) + 1) /
              (counts.n + 2);
          if (market === 'Both Teams Score')
            naiveProbability =
              ((selection === 'Yes' ? counts.btts : counts.n - counts.btts) + 1) / (counts.n + 2);
          const row = {
            day,
            matchId: f.fixture.id,
            leagueId: f.league.id,
            market,
            selection,
            probability,
            prudentProbability,
            naiveProbability,
            dixonColesProbability: dc.probability(market, selection),
            won: Number(settledOutcome(event, f)),
            researchCandidate: recent && probability >= POLICY.minProbability,
            modelValidated: false,
            realMoneyEligible: false,
          };
          rows.push(row);
          if (row.researchCandidate) eligible.push(row);
        }
        // Adaptation TRANSITOIRE à l'interface du sélecteur, sans cotation ni admission de production.
        // updated/retrievedAt désignent le calcul, bookmaker un groupe de recherche unique,
        // prudentEdge=0 départage sans avantage de prix. Aucun de ces champs ne sort du banc.
        reports.push({
          retrievedAt: new Date(now).toISOString(),
          events: eligible.map((r) => ({
            ...r,
            status: 'simulation_eligible',
            bookmaker: 'offline-unpriced',
            prudentEdge: 0,
            updated: new Date(now).toISOString(),
            kickoff: f.fixture.date,
          })),
        });
      }
    if (phase) {
      const coupon = selectCouponDetailed(reports, now);
      const selections = coupon.selections.map((e) =>
        rows.find(
          (r) => r.matchId === e.matchId && r.market === e.market && r.selection === e.selection,
        ),
      );
      const ticket = selections.length
        ? {
            day,
            mode: 'conditional_probability_only',
            selections,
            won: Number(selections.every((r) => r.won === 1)),
            probability: coupon.ticketProbabilityExploratory,
            prudentProbability: coupon.ticketProbability,
            naiveProbability: product(selections, 'naiveProbability'),
            dixonColesProbability: product(selections, 'dixonColesProbability'),
            modelValidated: false,
            realMoneyEligible: false,
          }
        : null;
      phases[phase].push({
        day,
        matches: matches.length,
        rows,
        ticket,
        noTicketReason: ticket ? null : coupon.noTicketReason,
      });
    }
    // Apprentissage seulement après TOUTES les prédictions de la journée GMT−5.
    for (const f of matches) dixonColes.learn(f);
    for (const f of matches)
      if (f.fixture.status.short === 'FT') {
        for (const side of ['home', 'away']) {
          const key = teamKey(f, side),
            xs = histories.get(key) || [];
          xs.push(f);
          histories.set(key, xs.slice(-10));
        }
        const c = naiveCounts.get(f.league.id) || {
          n: 0,
          winner: { Home: 0, Draw: 0, Away: 0 },
          over: 0,
          btts: 0,
        };
        c.n++;
        c.winner[
          f.goals.home > f.goals.away ? 'Home' : f.goals.home < f.goals.away ? 'Away' : 'Draw'
        ]++;
        c.over += Number(f.goals.home + f.goals.away > 2.5);
        c.btts += Number(f.goals.home > 0 && f.goals.away > 0);
        naiveCounts.set(f.league.id, c);
      }
  }
  const summarizePhase = (days) => {
    const rows = days.flatMap((d) => d.rows),
      tickets = days.flatMap((d) => (d.ticket ? [d.ticket] : []));
    const selected = tickets.flatMap((t) => t.selections);
    const groupMetrics = (xs, scope) =>
      Object.fromEntries(
        [...new Set(EVENTS.map(([m]) => m))].map((m) => {
          const group = xs.filter((r) => r.market === m);
          return [
            m,
            {
              poisson: scores(group, 'probability'),
              prudent: scores(group, 'prudentProbability'),
              naive: scores(group, 'naiveProbability'),
              dixonColes: scores(group, 'dixonColesProbability'),
              intervals: scoreIntervals(days, m, scope, plan.bootstrapReplicates, plan.seed),
            },
          ];
        }),
      );
    const intervals = bootstrapDays(
      days,
      (draw) => {
        const ts = draw.flatMap((d) => (d.ticket ? [d.ticket] : [])),
          stats = ticketSummary(ts);
        return {
          passRate: stats.passRate,
          announced: stats.announced,
          exploratory: stats.exploratory,
          naive: stats.naive,
          dixonColes: stats.dixonColes,
          gap: stats.gap,
          naiveGap: stats.naiveGap,
          dixonColesGap: stats.dixonColesGap,
          brierDifference: ts.length ? stats.poissonScores.brier - stats.naiveScores.brier : null,
          dixonColesBrierDifference: ts.length
            ? stats.dixonColesScores.brier - stats.poissonScores.brier
            : null,
        };
      },
      plan.bootstrapReplicates,
      plan.seed,
    );
    return {
      days: days.length,
      matches: days.reduce((s, d) => s + d.matches, 0),
      noTicketDays: days.length - tickets.length,
      allEvents: groupMetrics(rows, 'all'),
      selectedEvents: groupMetrics(selected, 'selected'),
      tickets: { ...ticketSummary(tickets), intervals, conditional: true },
      forecasts: rows,
      ticketRecords: tickets,
    };
  };
  return {
    schemaVersion: 1,
    kind: dataset.kind,
    modelVersion: MODEL_VERSION,
    plan,
    coverage,
    dixonColes: {
      version: DIXON_COLES_VERSION,
      grid: DIXON_COLES_GRID,
      selectionRule: SELECTION_RULE,
      lowHistoryMatches: LOW_HISTORY_MATCHES,
      rhoBound: RHO_BOUND,
      chosen: dixonColesSelection.chosen,
      developmentGrid: dixonColesSelection.grid,
      stats: dixonColes.stats,
    },
    modelValidated: false,
    realMoneyEligible: false,
    deferred: {
      marketComparison: 'Aucune source de cotes autorisée.',
      yield: 'Aucune cote historique : rendement non calculable.',
    },
    limitations: [
      'Tickets conditionnels aux probabilités : edge, disponibilité du marché, fraîcheur des cotes, absences et compositions non vérifiables.',
      'Le groupe offline-unpriced est un adaptateur de recherche, pas un bookmaker réel.',
      'Enveloppe prudente de sensibilité non calibrée ; produits des probabilités supposant l’indépendance des jambes.',
      'Historique limité aux ligues et saisons collectées ; exclusion des statuts autres que FT, sans prolongation ni tirs au but.',
      'Photographie à 00:00 GMT−5 ; aucun résultat de la journée ne nourrit ses prédictions ; corrections rétrospectives non datées.',
      'Le modèle naïf prédit les mêmes événements et les mêmes jambes ; son taux observé est celui de ces mêmes tickets.',
      'Dixon-Coles évalué sur les jambes choisies par le sélecteur Poisson ; il ne compose pas ses propres tickets.',
      'Petit effectif ou une seule journée : IC absent ou peu informatif ; les données synthétiques ne valident aucun modèle.',
    ],
    development: summarizePhase(phases.development),
    test: summarizePhase(phases.test),
  };
}
