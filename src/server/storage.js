import { api } from './provider.js';

export function settledOutcome(selection, fixture) {
  if (
    fixture.fixture.status.short !== 'FT' ||
    !Number.isFinite(fixture.goals.home) ||
    !Number.isFinite(fixture.goals.away)
  )
    return null;
  const h = fixture.goals.home,
    a = fixture.goals.away,
    v = selection.selection;
  if (selection.market === 'Goals Over/Under') {
    const m = v.match(/^(Over|Under) (\d+\.5)$/);
    return m ? (m[1] === 'Over' ? h + a > Number(m[2]) : h + a < Number(m[2])) : null;
  }
  if (selection.market === 'Both Teams Score')
    return v === 'Yes' ? h > 0 && a > 0 : v === 'No' ? h === 0 || a === 0 : null;
  if (selection.market === 'Match Winner')
    return v === 'Home' ? h > a : v === 'Draw' ? h === a : v === 'Away' ? a > h : null;
  if (selection.market === 'Double Chance')
    return v === 'Home/Draw'
      ? h >= a
      : v === 'Draw/Away'
        ? a >= h
        : v === 'Home/Away'
          ? h !== a
          : null;
  return null;
}
async function observations(env) {
  if (!env.BUCKET) return [];
  const all = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const list = await env.BUCKET.list({ prefix: 'observations/' + date + '/', limit: 1000 });
    all.push(...list.objects);
  }
  all.sort((a, b) => new Date(a.uploaded) - new Date(b.uploaded));
  const out = [];
  for (const x of all.slice(-80)) {
    const obj = await env.BUCKET.get(x.key);
    if (obj) out.push({ key: x.key, data: await obj.json() });
  }
  return out;
}
export async function settle(env) {
  if (!env.BUCKET) return { available: false, error: 'Stockage du suivi non configuré.' };
  const records = await observations(env);
  let updated = 0,
    examined = 0;
  for (const { key, data: r } of records) {
    if (r.settled || !r.selections.length) continue;
    if (r.selections.some((x) => Date.parse(x.kickoff) + 3 * 3600000 > Date.now())) continue;
    if (examined >= 8) break;
    examined++;
    const outcomes = [];
    for (const x of r.selections) {
      const f = (await api(env, 'fixtures?id=' + x.matchId, 60000)).response[0];
      const outcome = f ? settledOutcome(x, f) : null;
      outcomes.push({
        matchId: x.matchId,
        market: x.market,
        selection: x.selection,
        won: outcome,
        score: f?.goals || null,
      });
    }
    r.outcomes = outcomes;
    r.settled = outcomes.every((x) => x.won !== null);
    r.settledAt = new Date().toISOString();
    await env.BUCKET.put(key, JSON.stringify(r));
    updated++;
  }
  return { available: true, updated, examined };
}
function wilson95(wins, n) {
  if (!n) return null;
  const z = 1.959963984540054,
    p = wins / n,
    denominator = 1 + z ** 2 / n,
    center = (p + z ** 2 / (2 * n)) / denominator,
    margin = (z * Math.sqrt((p * (1 - p) + z ** 2 / (4 * n)) / n)) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function bootstrapROI(matches) {
  if (!matches.size) return null;
  // Mulberry32, fixed seed 164 (BIS-164): restart on each call for reproducibility.
  let seed = 164;
  const random = () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const groups = [...matches.values()],
    samples = [];
  for (let i = 0; i < 1000; i++) {
    let profit = 0,
      selections = 0;
    for (let j = 0; j < groups.length; j++) {
      const group = groups[Math.floor(random() * groups.length)];
      profit += group.profit;
      selections += group.n;
    }
    samples.push(profit / selections);
  }
  samples.sort((a, b) => a - b);
  // Percentile interval with linear interpolation at 2.5% and 97.5%.
  const percentile = (p) => {
    const index = (samples.length - 1) * p,
      low = Math.floor(index);
    return samples[low] + (samples[Math.ceil(index)] - samples[low]) * (index - low);
  };
  return [percentile(0.025), percentile(0.975)];
}

export async function performance(env) {
  const rows = await observations(env);
  const settled = rows.map((x) => x.data).filter((x) => x.settled && x.selections.length);
  let unitProfit = 0,
    brier = 0,
    n = 0,
    wins = 0;
  const seen = new Set();
  const matches = new Map();
  const bounds = [0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1];
  const bins = bounds.slice(0, -1).map((low, i) => ({
    bin: `${low.toFixed(2)}-${bounds[i + 1].toFixed(2)}`,
    n: 0,
    predicted: 0,
    observed: 0,
  }));
  settled.sort((a, b) => Date.parse(a.generatedAt) - Date.parse(b.generatedAt));
  for (const r of settled)
    for (let i = 0; i < r.selections.length; i++) {
      const s = r.selections[i],
        o = r.outcomes[i];
      const eventKey = [s.matchId, s.market, s.selection, s.bookmaker].join('|');
      if (typeof o?.won !== 'boolean' || seen.has(eventKey)) continue;
      seen.add(eventKey);
      n++;
      wins += Number(o.won);
      const profit = o.won ? s.odd - 1 : -1;
      unitProfit += profit;
      const match = matches.get(s.matchId) || { n: 0, profit: 0 };
      match.n++;
      match.profit += profit;
      matches.set(s.matchId, match);
      if (Number.isFinite(s.probability)) brier += (s.probability - Number(o.won)) ** 2;
      // Only finite probabilities in [0.70, 1.00] enter calibration bins.
      const binIndex = bounds.findIndex(
        (low, i) =>
          i < bins.length &&
          Number.isFinite(s.probability) &&
          s.probability >= low &&
          (s.probability < bounds[i + 1] || (i === bins.length - 1 && s.probability === 1)),
      );
      if (binIndex >= 0) {
        const bin = bins[binIndex];
        bin.n++;
        bin.predicted += s.probability;
        bin.observed += Number(o.won);
      }
    }
  return {
    available: !!env.BUCKET,
    recordedCoupons: rows.length,
    settledCoupons: settled.length,
    settledSelections: n,
    winRate: n ? wins / n : null,
    simulatedROI: n ? unitProfit / n : null,
    brierScore: n ? brier / n : null,
    winRateCI: wilson95(wins, n),
    roiCI: bootstrapROI(matches),
    distinctMatches: matches.size,
    calibration: bins.map((bin) => ({
      ...bin,
      predicted: bin.n ? bin.predicted / bin.n : null,
      observed: bin.n ? bin.observed / bin.n : null,
    })),
    sampleWarning: matches.size < 100,
    sampleWarningText:
      matches.size < 100
        ? 'Moins de 100 matchs distincts réglés : échantillon limité, résultats exploratoires à interpréter avec prudence.'
        : null,
    modelValidated: false,
    scope:
      'Sept derniers jours, 80 coupons maximum ; événements dédoublonnés, première estimation conservée, une unité fictive par sélection. IC 95 % : Wilson par sélection pour le taux de réussite ; bootstrap par match pour le ROI (mulberry32, graine 164, 1000 rééchantillonnages, percentiles interpolés). Avertissement sous 100 matchs distincts réglés. Calibration : tranches [0,70 ; 0,75), puis pas de 0,05 ; dernière tranche [0,95 ; 1,00]. Probabilités inférieures à 0,70, supérieures à 1 ou absentes/non finies exclues de la calibration. Ce suivi prospectif exploratoire ne constitue pas un test historique indépendant ni une validation du modèle.',
  };
}
