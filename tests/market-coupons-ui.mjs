import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Six événements distincts répartis sans recouvrement entre les coupons.
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

const probabilities = [0.82, 0.82, 0.82];
const fairOdds = probabilities.map((p) => 1 / p);
const selections = Array.from({ length: 6 }, (_, index) => ({
  matchId: index + 1,
  match: `Club ${index + 1} — Visiteur ${index + 1}`,
  kickoff: `2030-01-0${index + 1}T14:00:00.000Z`,
  market: 'Both Teams Score',
  selection: 'Yes',
  marketProbability: probabilities[index % probabilities.length],
  modelProbability: null,
  modelCheck: 'non vérifié',
  odd: fairOdds[index % fairOdds.length],
  fairOdds: fairOdds[index % fairOdds.length],
  minOdds: Math.ceil(fairOdds[index % fairOdds.length] * 100) / 100,
  oddsAgeMinutes: 0,
  valueVsMarket: -0.001,
}));
const makeCoupon = (size) => {
  const starts = { 1: 0, 2: 1, 3: 3 };
  const picks = selections.slice(starts[size], starts[size] + size);
  return {
    id: `fixture-${size}`,
    size,
    confidence: picks.reduce((product, x) => product * x.marketProbability, 1),
    combinedOdds: picks.reduce((product, x) => product * x.odd, 1),
    bookmaker: 'bet365',
    selections: picks,
  };
};
const render = (d) => (ctx.marketCouponsState('result', d), box.innerHTML);

const validCoupons = [makeCoupon(1), makeCoupon(2), makeCoupon(3)];
for (const coupon of validCoupons) {
  const ids = coupon.selections.map((selection) => selection.matchId);
  assert.equal(new Set(ids).size, ids.length, 'aucun match répété dans un coupon');
  assert(coupon.confidence >= 0.5, 'confiance conforme au minimum');
  assert.equal(
    coupon.confidence,
    coupon.selections.reduce((product, selection) => product * selection.marketProbability, 1),
  );
  assert.equal(
    coupon.combinedOdds,
    coupon.selections.reduce((product, selection) => product * selection.odd, 1),
  );
}
assert(validCoupons[2].confidence >= 0.5, 'le triple reste au-dessus de 50 %');
assert.equal(
  new Set(validCoupons.flatMap((coupon) => coupon.selections.map((selection) => selection.matchId)))
    .size,
  6,
  'les six événements sont propres à leurs coupons et aucun ne se répète entre eux',
);

let html = render({ marketCoupons: validCoupons });
assert.equal((html.match(/class="mcoupon"/g) || []).length, 3);
assert.equal((html.match(/class="mcpick"/g) || []).length, 6);
assert(html.includes('Cote juste du marché'));
assert(html.includes('Joue seulement si la cote actuelle est ≥'));
assert(!html.includes('Cote minimum') && !html.includes('minOdds'));
assert(html.includes('Cote bet365'));
assert(html.includes('Sous la cote juste'), 'la cote bet365 brute est légèrement sous 1 / p');
assert(html.includes('Non vérifié'));

html = render({ marketCoupons: [makeCoupon(1)] });
assert(html.includes('1,22'), 'cote juste affichée avec deux décimales');
assert(html.includes('Club 1 — Visiteur 1'));

// Le minimum est arrondi vers le haut ; fairOdds serveur prime sur 1/p.
const edge = makeCoupon(1);
edge.selections = [
  {
    ...selections[0],
    marketProbability: 0.78,
    fairOdds: 1.281,
    odd: 1.281,
    valueVsMarket: 0,
  },
];
edge.confidence = 0.78;
edge.combinedOdds = 1.281;
html = render({ marketCoupons: [edge] });
assert(html.includes('Cote juste du marché</dt><dd>1,28'));
assert(html.includes('cote actuelle est ≥ 1.29'), 'seuil arrondi au centième supérieur');
assert(html.includes('À la cote juste'), 'égalité serveur dans la tolérance affichée correctement');
assert(!html.includes('−0,0 %'));

edge.selections[0].fairOdds = 1.3;
html = render({ marketCoupons: [edge] });
assert(html.includes('Cote juste du marché</dt><dd>1,30'));
assert(html.includes('cote actuelle est ≥ 1.30'));

// Une comparaison serveur explicitement indisponible garde son tiret et sa raison.
edge.selections[0].valueVsMarket = null;
edge.selections[0].valueReason = 'Repère trop ancien.';
html = render({ marketCoupons: [edge] });
assert(html.includes('Valeur face au marché : —'));
assert(html.includes('Repère trop ancien.'));
assert(!html.includes('Valeur face au marché +'));

// Les contrats incomplets ou trompeurs sont écartés, avec erreur visible si tout est mal formé.
for (const invalid of [
  { ...makeCoupon(1), bookmaker: 'pinnacle' },
  {
    ...makeCoupon(2),
    selections: [selections[0], { ...selections[1], matchId: selections[0].matchId }],
  },
  { ...makeCoupon(1), selections: [{ ...selections[0], matchId: null }] },
  { ...makeCoupon(1), selections: [{ ...selections[0], kickoff: 'invalid' }] },
  { ...makeCoupon(1), selections: [{ ...selections[0], modelCheck: 'missing' }] },
]) {
  html = render({ marketCoupons: [invalid] });
  assert(html.includes('Données de coupons invalides'));
  assert(!html.includes('class="mcoupon"'));
}

html = render({ marketCoupons: [makeCoupon(1), { size: 9 }] });
assert(html.includes('class="mcoupon"'), 'un coupon valide reste affiché');
assert(render({ marketCoupons: [] }).includes('Aucun coupon aujourd’hui'));
assert(render({ summary: 'Erreur réseau' }).includes('Coupons indisponibles'));
assert(
  render({ marketCoupons: [], verdict: 'api_paused', summary: 'Quota atteint.' }).includes(
    'Quota atteint.',
  ),
);
assert(!render({ marketCoupons: [makeCoupon(1)] }).includes('<img'));
html = render({ marketCoupons: [makeCoupon(1)] });
assert(!html.includes('<img'), 'les textes sont échappés');
ctx.marketCouponsState('loading');
assert(box.innerHTML.includes('en cours'));
ctx.marketCouponsState('idle');
assert(box.innerHTML.includes('après l’analyse'));
console.log('market coupons UI ok');
