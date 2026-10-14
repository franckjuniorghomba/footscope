const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const clamp = (p) => Math.max(1e-12, Math.min(1 - 1e-12, p));

export function scores(rows, field) {
  const bins = Array.from({ length: 10 }, (_, i) => ({
    lower: i / 10,
    upper: (i + 1) / 10,
    count: 0,
    predictions: 0,
    wins: 0,
  }));
  for (const r of rows) {
    const b = bins[Math.min(9, Math.floor(r[field] * 10))];
    b.count++;
    b.predictions += r[field];
    b.wins += r.won;
  }
  return {
    count: rows.length,
    matches: new Set(rows.map((r) => r.matchId)).size,
    brier: mean(rows.map((r) => (r[field] - r.won) ** 2)),
    logLoss: mean(
      rows.map(
        (r) => -(r.won * Math.log(clamp(r[field])) + (1 - r.won) * Math.log(1 - clamp(r[field]))),
      ),
    ),
    calibration: bins.map((b) => ({
      lower: b.lower,
      upper: b.upper,
      count: b.count,
      predicted: b.count ? b.predictions / b.count : null,
      observed: b.count ? b.wins / b.count : null,
    })),
  };
}

export function ticketSummary(rows) {
  return {
    count: rows.length,
    days: new Set(rows.map((r) => r.day)).size,
    passRate: mean(rows.map((r) => r.won)),
    announced: mean(rows.map((r) => r.prudentProbability)),
    exploratory: mean(rows.map((r) => r.probability)),
    naive: mean(rows.map((r) => r.naiveProbability)),
    gap: mean(rows.map((r) => r.won - r.prudentProbability)),
    naiveGap: mean(rows.map((r) => r.won - r.naiveProbability)),
    bySize: Object.fromEntries(
      [1, 2, 3, 4].map((k) => [k, rows.filter((r) => r.selections.length === k).length]),
    ),
    poissonScores: scores(rows, 'probability'),
    prudentScores: scores(rows, 'prudentProbability'),
    naiveScores: scores(rows, 'naiveProbability'),
  };
}

// Le même tirage de journées conserve tous leurs événements, même les journées sans ticket.
// Les IC des différences sont appariés : mêmes événements, mêmes jambes et mêmes tirages.
export function bootstrapDays(days, summarize, replicates, seed) {
  const estimate = summarize(days);
  const values = Object.fromEntries(Object.keys(estimate).map((k) => [k, []]));
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  if (days.length >= 2) {
    for (let b = 0; b < replicates; b++) {
      const draw = Array.from(
        { length: days.length },
        () => days[Math.floor(random() * days.length)],
      );
      const stats = summarize(draw);
      for (const [k, v] of Object.entries(stats)) if (Number.isFinite(v)) values[k].push(v);
    }
  }
  return Object.fromEntries(
    Object.entries(estimate).map(([k, v]) => {
      const xs = values[k].sort((a, b) => a - b);
      const quantile = (p) => {
        const i = (xs.length - 1) * p,
          lo = Math.floor(i),
          hi = Math.ceil(i);
        return xs[lo] + (xs[hi] - xs[lo]) * (i - lo);
      };
      return [
        k,
        {
          estimate: v,
          interval95: xs.length ? [quantile(0.025), quantile(0.975)] : null,
          validReplicates: xs.length,
          days: days.length,
        },
      ];
    }),
  );
}

export function scoreIntervals(days, market, scope, replicates, seed) {
  // Pré-agréger les sommes par journée pour ne pas recopier le corpus à chaque tirage.
  const aggregates = days.map((d) => {
    const rows = (scope === 'selected' ? d.ticket?.selections || [] : d.rows).filter(
      (r) => r.market === market,
    );
    const result = { count: rows.length };
    for (const field of ['probability', 'prudentProbability', 'naiveProbability']) {
      const s = scores(rows, field);
      result[field] = {
        brier: (s.brier || 0) * rows.length,
        logLoss: (s.logLoss || 0) * rows.length,
      };
    }
    return result;
  });
  return bootstrapDays(
    aggregates,
    (draw) => {
      const n = draw.reduce((s, d) => s + d.count, 0),
        result = {};
      for (const [label, field] of [
        ['poisson', 'probability'],
        ['prudent', 'prudentProbability'],
        ['naive', 'naiveProbability'],
      ]) {
        for (const metric of ['brier', 'logLoss'])
          result[`${label}_${metric}`] = n
            ? draw.reduce((s, d) => s + d[field][metric], 0) / n
            : null;
      }
      result.brierDifference = n ? result.poisson_brier - result.naive_brier : null;
      result.logLossDifference = n ? result.poisson_logLoss - result.naive_logLoss : null;
      return result;
    },
    replicates,
    seed,
  );
}
