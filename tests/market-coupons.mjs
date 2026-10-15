import assert from 'node:assert/strict';
import { buildMarketCoupons } from '../src/server/market-coupons.js';
import { marketReport, MARKET_COUPON_NOW as now } from './fixtures/market-coupons.mjs';
import { buildLlmInput } from '../src/server/llm.js';
import { assessMatch } from '../src/server/statistics.js';
import { compactReport } from '../src/server/coupon.js';
const compose = (reports) => buildMarketCoupons(reports, now);
const one = (p, options) => compose([marketReport(1, p, options)]);
for (const p of [0.7, 0.85]) assert.equal(one(p).length, 1, `borne ${p}`);
for (const p of [0.6999, 0.8501, 0.9, 0.9001, 0.95]) assert.equal(one(p).length, 0);
const poisson = (p) => {
  const lambda = -Math.log(1 - Math.sqrt(p));
  return { homeGoals: lambda, awayGoals: lambda };
};
assert.equal(one(0.75, { model: poisson(0.78) })[0].selections[0].modelCheck, 'ok');
assert.equal(one(0.75, { model: poisson(0.78001) }).length, 0);
assert.equal(one(0.75)[0].selections[0].modelProbability, null);
assert.equal(one(0.75)[0].selections[0].modelCheck, 'non vérifié');
const reports = Array.from({ length: 8 }, (_, i) => marketReport(i + 1));
const original = structuredClone(reports),
  coupons = compose(reports);
assert.deepEqual(reports, original);
assert.deepEqual(
  coupons.map((c) => c.size),
  [1, 2, 3],
);
assert.equal(new Set(coupons.flatMap((c) => c.selections.map((s) => s.matchId))).size, 6);
assert.deepEqual(compose([...reports].reverse()), coupons);
for (const c of coupons) {
  assert.equal(c.bookmaker, 'bet365');
  for (const selection of c.selections)
    assert.equal(selection.fairOdds, 1 / selection.marketProbability);
  assert.equal(
    c.confidence,
    c.selections.reduce((p, s) => p * s.marketProbability, 1),
  );
  assert.equal(
    c.combinedOdds,
    c.selections.reduce((p, s) => p * s.odd, 1),
  );
  assert.equal(c.confidence >= 0.5, true);
}
assert.deepEqual(
  compose(Array.from({ length: 6 }, (_, i) => marketReport(i + 1, 0.7))).map((c) => c.size),
  [1],
);
assert.equal(compose([marketReport(1), marketReport(1)]).length, 1);
const mutate = (fn, p = 0.82) => {
  const r = marketReport(1, p);
  fn(r);
  return compose([r]);
};
for (const minutes of [1440, 1441, -6])
  assert.equal(
    mutate((r) => {
      r.marketCouponQuotes[0].update = new Date(now - minutes * 60000).toISOString();
    }).length,
    0,
  );
// Cote jouable ancienne, repère Pinnacle récent ; badge de valeur indisponible.
const older = marketReport(1);
older.marketCouponQuotes.unshift({
  ...structuredClone(older.marketCouponQuotes[0]),
  update: new Date(now - 1439 * 60000).toISOString(),
  bookmakers: [older.marketCouponQuotes[0].bookmakers.shift()],
});
assert.equal(compose([older])[0].selections[0].oddsAgeMinutes, 1439);
assert.equal(compose([older])[0].selections[0].valueVsMarket, null);
older.marketCouponQuotes[0].update = new Date(now - 1440 * 60000).toISOString();
assert.equal(compose([older]).length, 0, '24 heures exclues même avec Pinnacle frais');
// Repère ancien avec cote bet365 fraîche : admission <24 h, badge ≤30 min.
for (const minutes of [30, 31, 1439, 1440, -5, -6]) {
  const r = marketReport(1);
  r.marketCouponQuotes.push({
    ...structuredClone(r.marketCouponQuotes[0]),
    update: new Date(now - minutes * 60000).toISOString(),
    bookmakers: [r.marketCouponQuotes[0].bookmakers.pop()],
  });
  const result = compose([r]);
  assert.equal(result.length, minutes < 1440 && minutes >= -5 ? 1 : 0, `repère ${minutes} min`);
  if (result.length) {
    assert.equal(result[0].selections[0].oddsAgeMinutes, 0);
    assert.equal(result[0].selections[0].valueVsMarket === null, minutes > 30);
  }
}
assert.equal(
  mutate((r) => (r.marketCouponQuotes[0].update = new Date(now - 31 * 60000).toISOString())).length,
  1,
  'cote et repère à 31 min admis',
);
// Repli : tous les repères utilisés doivent rester <24 h ; badge ≤30 min.
for (const minutes of [31, 1439, 1440]) {
  const r = marketReport(1);
  const reference = r.marketCouponQuotes[0].bookmakers.pop();
  reference.name = 'Other';
  r.marketCouponQuotes.push({
    fixture: { id: 1 },
    update: new Date(now - minutes * 60000).toISOString(),
    bookmakers: [reference],
  });
  const result = compose([r]);
  assert.equal(result.length, minutes < 1440 ? 1 : 0, `repli ${minutes} min`);
  if (result.length) assert.equal(result[0].selections[0].valueVsMarket, null);
}
const sharpPriority = marketReport(1);
sharpPriority.marketCouponQuotes[0].bookmakers.push({
  name: 'Other',
  bets: sharpPriority.marketCouponQuotes[0].bookmakers[0].bets,
});
sharpPriority.marketCouponQuotes[0].bookmakers[1].bets = [];
assert.equal(compose([sharpPriority]).length, 0, 'Pinnacle présent mais incomplet : aucun repli');

assert.equal(mutate((r) => (r.marketCouponQuotes[0].fixture.id = 99)).length, 0);
assert.equal(mutate((r) => (r.kickoff = new Date(now).toISOString())).length, 0);
assert.equal(
  mutate((r) => (r.marketCouponQuotes[0].bookmakers[0].bets[0].values[0].odd = 'Infinity')).length,
  0,
);
assert.equal(mutate((r) => r.marketCouponQuotes[0].bookmakers[1].bets[0].values.pop()).length, 0);
assert.equal(mutate((r) => r.marketCouponQuotes[0].bookmakers.pop()).length, 0);
const fallback = marketReport(1);
fallback.marketCouponQuotes[0].bookmakers[1].name = 'Other';
assert.equal(compose([fallback]).length, 1);
fallback.marketCouponQuotes[0].bookmakers.push(
  structuredClone(fallback.marketCouponQuotes[0].bookmakers[1]),
);
assert.equal(compose([fallback]).length, 1, 'bookmaker dédoublonné');
fallback.marketCouponQuotes[0].bookmakers[1].bets = [];
assert.equal(compose([fallback]).length, 0, 'deux bookmakers complets requis');
// 1X2 et double chance : somme du 1X2, jamais normalisation des trois doubles chances.
const dc = marketReport(1);
for (const book of dc.marketCouponQuotes[0].bookmakers)
  book.bets = [
    {
      name: 'Match Winner',
      values: [
        { value: 'Home', odd: 2 },
        { value: 'Draw', odd: 1 / 0.3 },
        { value: 'Away', odd: 5 },
      ],
    },
    { name: 'Double Chance', values: [{ value: 'Home/Draw', odd: 1.3 }] },
  ];
assert.equal(compose([dc])[0].selections[0].marketProbability, 0.8);
assert.equal(compose([dc])[0].selections[0].minOdds, 1.25);
assert.equal(compose([dc])[0].selections[0].fairOdds, 1.25);
for (const minutes of [31, 1439, 1440]) {
  const r = structuredClone(dc);
  r.marketCouponQuotes[0].update = new Date(now - minutes * 60000).toISOString();
  const result = compose([r]);
  assert.equal(result.length, minutes < 1440 ? 1 : 0, `double chance ${minutes} min`);
  if (result.length) assert.equal(result[0].selections[0].fairOdds, 1.25);
}
for (const market of ['Match Winner', 'Goals Over/Under']) {
  const r = marketReport(1);
  for (const book of r.marketCouponQuotes[0].bookmakers)
    book.bets =
      market === 'Match Winner'
        ? [
            {
              name: market,
              values: [
                { value: 'Home', odd: 1 / 0.8 },
                { value: 'Draw', odd: 10 },
                { value: 'Away', odd: 10 },
              ],
            },
          ]
        : [
            {
              name: market,
              values: [
                { value: 'Under 2.5', odd: 1 / 0.8 },
                { value: 'Over 2.5', odd: 5 },
              ],
            },
          ];
  assert.equal(compose([r])[0].selections[0].market, market);
  for (const minutes of [31, 1439, 1440]) {
    r.marketCouponQuotes[0].update = new Date(now - minutes * 60000).toISOString();
    assert.equal(compose([r]).length, minutes < 1440 ? 1 : 0, `${market} ${minutes} min`);
  }
}
assert.equal(
  mutate((r) => {
    for (const book of r.marketCouponQuotes[0].bookmakers) book.bets[0].name = 'Corners';
  }).length,
  0,
);
assert.equal(mutate((r) => r.marketCouponQuotes[0].bookmakers[1].bets.push(null)).length, 0);
assert.equal(
  mutate((r) => r.marketCouponQuotes[0].bookmakers[1].bets[0].values.push(null)).length,
  0,
);
assert.deepEqual(compose(null), []);
const sentinel = 'BIS220_SENTINEL';
assert(
  !JSON.stringify(
    buildLlmInput({ marketCoupons: [{ id: sentinel }], marketCouponQuotes: sentinel }),
  ).includes(sentinel),
);
// Le rapport compact conserve les cotes malgré un ticket vide, sans toucher ses événements.
const r = marketReport(1);
assert.deepEqual(compactReport(r).events, []);
assert.deepEqual(compose([compactReport(r)]), compose([r]));
const fixture = {
  fixture: { id: 1, timestamp: (now + 7200000) / 1000, date: r.kickoff, status: { short: 'NS' } },
  teams: { home: { id: 1, name: 'A' }, away: { id: 2, name: 'B' } },
  league: { country: 'France', name: 'A' },
};
const assessed = assessMatch(
  { fixture, odds: r.marketCouponQuotes, retrievedAt: r.retrievedAt },
  now,
);
assert.equal(assessed.model, null);
assert.equal(compose([compactReport(assessed)]).length, 1);
console.log('Exemple marketCoupons fixture :', JSON.stringify(coupons));
console.log(
  'Passed: bornes, Poisson +3 points, fraîcheur, références complètes/dédoublonnées, quatre marchés, tailles/produits, aucun match réutilisé, sentinelle LLM.',
);
