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
export async function performance(env) {
  const rows = await observations(env);
  const settled = rows.map((x) => x.data).filter((x) => x.settled && x.selections.length);
  let unitProfit = 0,
    brier = 0,
    n = 0,
    wins = 0;
  const seen = new Set();
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
      unitProfit += o.won ? s.odd - 1 : -1;
      if (Number.isFinite(s.probability)) brier += (s.probability - Number(o.won)) ** 2;
    }
  return {
    available: !!env.BUCKET,
    recordedCoupons: rows.length,
    settledCoupons: settled.length,
    settledSelections: n,
    winRate: n ? wins / n : null,
    simulatedROI: n ? unitProfit / n : null,
    brierScore: n ? brier / n : null,
    modelValidated: false,
    scope:
      'Sept derniers jours, 80 coupons maximum ; événements dédoublonnés, première estimation conservée, une unité fictive par sélection. Ce suivi prospectif ne constitue pas un test historique indépendant.',
  };
}
