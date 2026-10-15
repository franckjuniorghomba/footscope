import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
// BIS-220 : section « Coupons du jour », rendue avec des réponses simulées de la forme fixée.
const ui = await readFile('src/web/app.js', 'utf8');
const box = { innerHTML: '' };
const ctx = {
  $: (q) => (q === '#marketCoupons' ? box : null),
  kickoff: () => 'Sam. 17 oct. · 10h00',
};
runInNewContext(
  ui.slice(ui.indexOf('const esc ='), ui.indexOf('const tz =')) +
    ui.slice(
      ui.indexOf('const signedPercent') > 0 ? ui.indexOf('const signedPercent') : 0,
      ui.indexOf('function valueBadge('),
    ) +
    ui.slice(ui.indexOf('// BIS-220'), ui.indexOf('function eventHTML(')),
  ctx,
);
const sel = (over = {}) => ({
  matchId: 1,
  match: 'Lyon — Nice',
  kickoff: '2026-10-17T15:00:00Z',
  market: 'Double chance',
  selection: '1X',
  marketProbability: 0.78,
  modelProbability: 0.8,
  modelCheck: 'ok',
  odd: 1.3,
  minOdds: 1.2821,
  oddsAgeMinutes: 95,
  valueVsMarket: 0.012,
  ...over,
});
const coupon = (n, over = {}) => ({
  id: 'c' + n,
  size: n,
  confidence: 0.6,
  combinedOdds: 1.69,
  bookmaker: 'bet365',
  selections: Array.from({ length: n }, (_, i) => sel({ matchId: i })),
  ...over,
});
const render = (d) => (ctx.marketCouponsState('result', d), box.innerHTML);
let html = render({ marketCoupons: [coupon(1), coupon(2), coupon(3)] });
assert.equal((html.match(/class="mcoupon"/g) || []).length, 3);
assert.equal((html.match(/class="mcpick"/g) || []).length, 6);
assert(html.includes('Confiance = probabilité du marché sans marge, non garantie.'));
assert(html.includes('Triple · 3 événements') && html.includes('Simple · 1 événement<'));
assert(html.includes('60,0 %') && html.includes('1,69'));
assert(html.includes('1,29'), 'cote minimum arrondie vers le haut');
assert(html.includes('Modèle d’accord') && html.includes('il y a 1 h 35 min'));
assert(html.includes('Valeur face au marché +1,2 %'));
html = render({
  marketCoupons: [
    coupon(1, {
      selections: [sel({ modelCheck: 'non vérifié', valueVsMarket: null, minOdds: null })],
    }),
  ],
});
assert(html.includes('Non vérifié') && html.includes('Valeur face au marché : —'));
assert(html.includes('Ne joue pas sans cote minimum vérifiée'));
// Données invalides : écartées, jamais complétées.
html = render({
  marketCoupons: [
    coupon(2, { selections: [sel()] }),
    coupon(1, { confidence: 1.4 }),
    { size: 4 },
    null,
  ],
});
assert(html.includes('Aucun coupon aujourd’hui'));
assert(!html.includes('mcoupon'));
// Vide : motif principal ; absent : indisponible, sans coupon inventé.
assert(render({ marketCoupons: [] }).includes('entre 70 et 85'));
assert(
  render({ marketCoupons: [], verdict: 'api_paused', summary: 'Quota atteint.' }).includes(
    'Quota atteint.',
  ),
);
assert(render({ summary: 'Erreur réseau' }).includes('Coupons indisponibles'));
// Échappement HTML.
assert(
  !render({
    marketCoupons: [coupon(1, { selections: [sel({ match: '<img onerror=1>' })] })],
  }).includes('<img'),
);
ctx.marketCouponsState('loading');
assert(box.innerHTML.includes('en cours'));
console.log('market coupons UI ok');
