import assert from 'node:assert/strict';
import { marketReference } from '../src/server/market.js';
import { assessMatch } from '../src/server/statistics.js';
import { selectCouponDetailed } from '../src/server/coupon.js';
import { buildLlmInput, llmExplanation } from '../src/server/llm.js';
import { POLICY } from '../src/server/policy.js';
const now = Date.parse('2026-10-14T12:00:00Z');
const records = () => [
  {
    update: new Date(now).toISOString(),
    bookmakers: [
      {
        name: 'Book A',
        bets: [
          {
            name: 'Match Winner',
            values: [
              { value: 'Home', odd: '2.00' },
              { value: 'Draw', odd: '3.50' },
              { value: 'Away', odd: '4.00' },
            ],
          },
        ],
      },
    ],
  },
];
const values = (r) => r[0].bookmakers[0].bets[0].values;
const original = records(),
  snapshot = structuredClone(original);
const [reference] = marketReference(original, now);
assert.deepEqual(original, snapshot);
assert.equal(reference.bookmaker, 'Book A');
assert.equal(reference.updated, original[0].update);
assert.deepEqual(reference.odds, { Home: 2, Draw: 3.5, Away: 4 });
const close = (a, b) => assert(Math.abs(a - b) <= 1e-9, `${a} ≈ ${b} à 1e-9 près`);
close(
  Object.values(reference.probabilities).reduce((a, b) => a + b),
  1,
);
close(reference.probabilities.Home, 14 / 29);
close(reference.probabilities.Draw, 8 / 29);
close(reference.probabilities.Away, 7 / 29);
close(reference.overround, 1 / 28);
assert.match(reference.explanation, /sans effet sur les décisions/);
for (const invalid of [null, {}, '2', false]) assert.deepEqual(marketReference(invalid, now), []);
assert.deepEqual(marketReference(original, NaN), []);
for (const odd of [null, true, {}, [], '', ' ', '2,00', '0x2', '2junk', 1, 0, -1, Infinity, NaN]) {
  const r = records();
  values(r)[1].odd = odd;
  assert.deepEqual(marketReference(r, now), []);
}
for (const mutate of [
  (r) => values(r).pop(),
  (r) => values(r).push({ value: 'Away', odd: 4 }),
  (r) => (values(r)[1].value = 'Home'),
  (r) => (values(r)[1].value = 'Other'),
  (r) => (values(r)[1] = null),
  (r) => (r[0].update = 'invalid'),
  (r) => (r[0].update = null),
  (r) => (r[0].update = new Date(now - POLICY.maxOddsAgeMs - 1).toISOString()),
  (r) => (r[0].update = new Date(now + 300001).toISOString()),
  (r) => (r[0].bookmakers[0].name = ''),
  (r) => (r[0].bookmakers[0].bets[0].values = null),
  (r) => (r[0].bookmakers[0].bets[0].name = 'Double Chance'),
]) {
  const r = records();
  mutate(r);
  assert.deepEqual(marketReference(r, now), []);
}
for (const age of [POLICY.maxOddsAgeMs, -300000]) {
  const r = records();
  r[0].update = new Date(now - age).toISOString();
  assert.equal(marketReference(r, now).length, 1);
}
const split = records();
split.push(structuredClone(split[0]));
values(split).pop();
split[1].bookmakers[0].bets[0].values.splice(0, 2);
split[1].update = new Date(now - 1000).toISOString();
assert.deepEqual(marketReference(split, now), []);
split[0].bookmakers.push(split[1].bookmakers[0]);
assert.deepEqual(marketReference([split[0]], now), []);
const books = records();
books[0].bookmakers.push(structuredClone(books[0].bookmakers[0]));
books[0].bookmakers[1].name = 'Book B';
books[0].bookmakers[1].bets[0].values[0].odd = 3;
const refs = marketReference(books, now);
assert.equal(refs.length, 2);
assert.notEqual(refs[0].probabilities.Home, refs[1].probabilities.Home);
let requests = 0;
globalThis.fetch = async () => {
  requests++;
  throw new Error('Requête inattendue');
};
const game = (id, home, away, at) => ({
  fixture: { id, timestamp: at / 1000, date: new Date(at).toISOString(), status: { short: 'FT' } },
  teams: { home: { id: home, name: 'Home' }, away: { id: away, name: 'Away' } },
  league: { name: 'Fixture', country: 'Test' },
  goals: { home: 2, away: 1 },
});
const fixture = game(99, 1, 2, now + 7200000);
fixture.fixture.status.short = 'NS';
const data = {
  fixture,
  odds: original,
  home: Array.from({ length: 10 }, (_, i) => game(i, 1, 3, now - (i + 1) * 86400000)),
  away: Array.from({ length: 10 }, (_, i) => game(20 + i, 2, 4, now - (i + 1) * 86400000)),
  errors: {},
  injuries: [],
  lineups: [],
  retrievedAt: new Date(now).toISOString(),
};
const report = assessMatch(data, now);
assert.deepEqual(report.market, [reference]);
assert.equal(requests, 0);
const { market, ...decisions } = report;
assert.equal(report.modelValidated, false);
assert(report.events.every((e) => e.realMoneyEligible === false));
assert.deepEqual(selectCouponDetailed([report], now), selectCouponDetailed([decisions], now));
const result = {
  selections: [],
  reviews: [report],
  reports: [report],
  market,
  status: 'simulation',
};
const input = buildLlmInput(result);
assert.deepEqual(
  input,
  buildLlmInput({ ...result, market: [{ sentinel: 'excluded' }], reviews: [decisions] }),
);
assert(!JSON.stringify(input).includes('proportional'));
globalThis.fetch = async (_url, options) => {
  requests++;
  const sent = JSON.parse(options.body);
  assert.deepEqual(JSON.parse(sent.input.split('\n').slice(1).join('\n')), input);
  return Response.json({ output: [] });
};
await llmExplanation({ OPENAI_API_KEY: 'fixture-key', LLM_MODEL: 'fixture-model' }, result);
assert.equal(requests, 1);
console.log(
  'Passed: 1X2 somme à 1e-9, marge 3.571428571 %, refus, fraîcheur, isolation relevés/bookmakers, zéro requête ajoutée, ticket et projection LLM inchangés.',
);
