import { POLICY, MODEL_VERSION } from './policy.js';

export function distribution(lambda) {
  const p = [Math.exp(-lambda)];
  for (let i = 1; i < 30; i++) p.push((p[i - 1] * lambda) / i);
  return p;
}
function createEventProbability(getDistribution) {
  return function eventProbability(market, selection, lh, la) {
    const h = getDistribution(lh),
      a = getDistribution(la);
    let prob = 0;
    const total = selection.match(/^(Over|Under) (\d+\.5)$/); // half-goal lines only: no refunds
    if (!(
      (market === 'Goals Over/Under' && total) ||
      (market === 'Both Teams Score' && ['Yes', 'No'].includes(selection)) ||
      (market === 'Match Winner' && ['Home', 'Draw', 'Away'].includes(selection)) ||
      (market === 'Double Chance' && ['Home/Draw', 'Draw/Away', 'Home/Away'].includes(selection))
    ))
      return null;
    for (let i = 0; i < h.length; i++)
      for (let j = 0; j < a.length; j++) {
        let wins = false;
        if (market === 'Goals Over/Under')
          wins = total[1] === 'Over' ? i + j > Number(total[2]) : i + j < Number(total[2]);
        if (market === 'Both Teams Score')
          wins = selection === 'Yes' ? i > 0 && j > 0 : i === 0 || j === 0;
        if (market === 'Match Winner')
          wins = selection === 'Home' ? i > j : selection === 'Away' ? i < j : i === j;
        if (market === 'Double Chance')
          wins = selection === 'Home/Draw' ? i >= j : selection === 'Draw/Away' ? j >= i : i !== j;
        if (wins) prob += h[i] * a[j];
      }
    return Math.min(1, prob);
  };
}
export const eventProbability = createEventProbability(distribution);

function teamHistory(list, id, cutoff) {
  return (list || [])
    .filter(
      (f) =>
        f.fixture?.status?.short === 'FT' &&
        f.fixture.timestamp * 1000 < cutoff &&
        Number.isFinite(f.goals?.home) &&
        Number.isFinite(f.goals?.away) &&
        [f.teams.home.id, f.teams.away.id].includes(id),
    )
    .sort((a, b) => b.fixture.timestamp - a.fixture.timestamp)
    .slice(0, 10)
    .map((f) => ({
      gf: f.teams.home.id === id ? f.goals.home : f.goals.away,
      ga: f.teams.home.id === id ? f.goals.away : f.goals.home,
      at: f.fixture.timestamp * 1000,
      home: f.teams.home.id === id,
    }));
}
export function assessMatch(d, now = Date.now()) {
  const f = d.fixture,
    cutoff = Math.min(now, f.fixture.timestamp * 1000),
    h = teamHistory(d.home, f.teams.home.id, cutoff),
    a = teamHistory(d.away, f.teams.away.id, cutoff);
  const mean = (x, k) => x.reduce((s, v) => s + v[k], 0) / x.length;
  const enough = h.length >= POLICY.minHistory && a.length >= POLICY.minHistory;
  const lh = enough ? (mean(h, 'gf') + mean(a, 'ga')) / 2 : null,
    la = enough ? (mean(a, 'gf') + mean(h, 'ga')) / 2 : null;
  const model = enough
    ? { homeGoals: lh, awayGoals: la, homeSample: h.length, awaySample: a.length }
    : null;
  const common = [];
  if (f.fixture.status.short !== 'NS' || f.fixture.timestamp * 1000 <= now)
    common.push('Match commencé ou non programmé.');
  if (!enough) common.push('Au moins huit résultats antérieurs par équipe requis.');
  if (enough && [h, a].some((x) => now - x[0].at > POLICY.maxRecentAgeDays * 86400000))
    common.push('Dernier match terminé trop ancien.');
  for (const k of ['home', 'away', 'odds', 'injuries', 'lineups'])
    if (d.errors?.[k]) common.push('Source indisponible : ' + k + '.');
  const lineupsConfirmed = (d.lineups || []).filter((x) => x.startXI?.length === 11).length >= 2;
  if (f.fixture.timestamp * 1000 - now < 90 * 60000 && !lineupsConfirmed)
    common.push('Compositions non confirmées à moins de 90 minutes du match.');
  // These caches belong to this assessment only; lambdas vary across sensitivity scenarios.
  const distributions = new Map(),
    probabilities = new Map();
  const probability = createEventProbability((lambda) => {
    if (!distributions.has(lambda)) distributions.set(lambda, distribution(lambda));
    return distributions.get(lambda);
  });
  const events = [];
  for (const record of d.odds || [])
    for (const book of record.bookmakers || [])
      for (const market of book.bets || [])
        for (const v of market.values || []) {
          const odd = Number(v.odd);
          if (!Number.isFinite(odd) || odd <= 1) continue;
          const key = JSON.stringify([market.name, v.value]);
          if (!probabilities.has(key)) {
            const p = enough ? probability(market.name, v.value, lh, la) : null;
            // Sensitivity envelope, NOT a calibrated confidence interval.
            let prudent = null;
            if (p !== null) {
              prudent = p;
              for (const sh of [0.75, 1, 1.25])
                for (const sa of [0.75, 1, 1.25])
                  prudent = Math.min(prudent, probability(market.name, v.value, lh * sh, la * sa));
              prudent = Math.max(0, prudent - 0.05);
            }
            probabilities.set(key, { p, prudent });
          }
          const { p, prudent } = probabilities.get(key);
          const reasons = [...common],
            age = now - Date.parse(record.update);
          if (!Number.isFinite(age) || age < -300000 || age > POLICY.maxOddsAgeMs)
            reasons.push('Cote absente, future ou âgée de plus de 30 minutes.');
          if (p === null) reasons.push('Marché non modélisé : aucune validation automatique.');
          const edge = prudent === null ? null : prudent * odd - 1;
          if (p !== null && p < POLICY.minProbability)
            reasons.push('Probabilité exploratoire inférieure à 70 %.');
          if (edge !== null && edge < POLICY.minPrudentEdge)
            reasons.push('Avantage prudent inférieur à 2 %.');
          const insufficient = !enough || p === null || common.some((x) => /Source|ancien/.test(x));
          events.push({
            matchId: f.fixture.id,
            match: f.teams.home.name + ' — ' + f.teams.away.name,
            market: market.name,
            selection: v.value,
            odd,
            bookmaker: book.name,
            updated: record.update,
            kickoff: f.fixture.date,
            probability: p,
            prudentProbability: prudent,
            breakEven: 1 / odd,
            edge: p === null ? null : p * odd - 1,
            prudentEdge: edge,
            minOdds: prudent > 0 ? 1.02 / prudent : null,
            status: reasons.length
              ? insufficient
                ? 'insufficient'
                : 'reject'
              : 'simulation_eligible',
            reasons,
            realMoneyEligible: false,
          });
        }
  return {
    matchId: f.fixture.id,
    match: f.teams.home.name + ' — ' + f.teams.away.name,
    country: f.league.country,
    league: f.league.name,
    kickoff: f.fixture.date,
    model,
    lineupsConfirmed,
    absences: (d.injuries || []).map((x) => ({ player: x.player?.name, reason: x.player?.reason })),
    missing: Object.keys(d.errors || {}),
    events,
    common,
    retrievedAt: d.retrievedAt,
    modelVersion: MODEL_VERSION,
    modelValidated: false,
  };
}
