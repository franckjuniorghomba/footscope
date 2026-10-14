import assert from 'node:assert/strict';
import { performance } from '../src/server/storage.js';

const now = Date.now();
let nextMatch = 1;
const selection = (probability = 0.9, bookmaker = 'Book', matchId = nextMatch++) => ({
  matchId,
  market: 'Match Winner',
  selection: 'Home',
  bookmaker,
  probability,
  odd: 1.2,
});
// wins: one boolean (or null when not yet settled) per selection.
const ticket = (selections, wins, extra = {}, age = 0) => ({
  id: `t${nextMatch}`,
  generatedAt: new Date(now - age).toISOString(),
  settled: wins.every((x) => x !== null),
  selections,
  outcomes: wins.map((won) => ({ won })),
  combinedProbability: null,
  ...extra,
});
const legs = (k, wins, probability = 0.9, extra) =>
  ticket(
    Array.from({ length: k }, () => selection(probability)),
    wins,
    extra,
  );
function environment(records) {
  const objects = records.map((data, i) => ({
    key: `observations/${data.generatedAt.slice(0, 10)}/${i}.json`,
    uploaded: new Date(Date.parse(data.generatedAt) + i),
    data,
  }));
  return {
    BUCKET: {
      list: async ({ prefix }) => ({ objects: objects.filter((x) => x.key.startsWith(prefix)) }),
      get: async (key) => ({ json: async () => objects.find((x) => x.key === key).data }),
    },
  };
}
const close = (actual, expected, tolerance = 1e-12) =>
  assert(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const noNaN = (value, path = 'result') => {
  if (typeof value === 'number') assert(Number.isFinite(value), `${path} = ${value}`);
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) noNaN(v, `${path}.${k}`);
};

// Empty: every rate is null, no NaN, warning on.
const empty = (await performance(environment([]))).tickets;
noNaN(empty);
assert.equal(empty.settled, 0);
assert.equal(empty.passRate, null);
assert.equal(empty.passRateCI, null);
assert.equal(empty.meanAnnouncedProbability, null);
assert.equal(empty.gap, null);
assert.deepEqual(Object.keys(empty.bySelections), ['1', '2', '3', '4']);
for (const b of Object.values(empty.bySelections))
  assert.deepEqual(b, {
    settled: 0,
    passed: 0,
    passRate: null,
    passRateCI: null,
    withProbability: 0,
    meanAnnouncedProbability: null,
    gap: null,
  });
assert.equal(empty.sampleWarning, true);
assert(empty.sampleWarningText.includes('30 tickets'));
assert.deepEqual(empty.items, []);

// Ten tickets on distinct matches, six passed (acceptance fixture).
// Legs 1,1,1 (2 passed) · 2,2,2 (2 passed) · 3,3 (1 passed) · 4,4 (1 passed).
const tenRecords = [
  legs(1, [true]),
  legs(1, [true]),
  legs(1, [false]),
  legs(2, [true, true]),
  legs(2, [true, true]),
  legs(2, [true, false]),
  legs(3, [true, true, true]),
  legs(3, [false, true, true]),
  legs(4, [true, true, true, true]),
  legs(4, [true, true, false, true]),
];
const full = await performance(environment(tenRecords));
const ten = full.tickets;
noNaN(ten);
assert.equal(ten.settled, 10);
assert.equal(ten.passed, 6);
assert.equal(ten.passRate, 0.6);
close(ten.passRateCI[0], 0.313, 0.0005);
close(ten.passRateCI[1], 0.832, 0.0005);
const announced = (3 * 0.9 + 3 * 0.9 ** 2 + 2 * 0.9 ** 3 + 2 * 0.9 ** 4) / 10;
close(ten.meanAnnouncedProbability, announced);
close(ten.gap, 0.6 - announced);
assert.equal(ten.withProbability, 10);
assert.equal(ten.sharedMatchTickets, 0);
assert.equal(ten.sampleWarning, true);
const expected = { 1: [3, 2, 0.9], 2: [3, 2, 0.81], 3: [2, 1, 0.729], 4: [2, 1, 0.6561] };
for (const [k, [n, passed, p]] of Object.entries(expected)) {
  const b = ten.bySelections[k];
  assert.equal(b.settled, n, `legs ${k}`);
  assert.equal(b.passed, passed, `legs ${k}`);
  close(b.passRate, passed / n);
  close(b.meanAnnouncedProbability, p);
  close(b.gap, passed / n - p);
  assert.equal(b.passRateCI.length, 2);
}
assert.equal(ten.items.length, 10);
assert.deepEqual(
  ten.items.map((t) => t.passed),
  [true, true, false, true, true, false, true, false, true, false],
);
assert.deepEqual(Object.keys(ten.items[0]).sort(), [
  'announcedProbability',
  'bookmaker',
  'generatedAt',
  'id',
  'modelVersion',
  'passed',
  'probabilitySource',
  'selections',
]);
assert(ten.items.every((t) => t.bookmaker === 'Book' && t.probabilitySource === 'selections'));
assert(
  ten.items.every((t) => t.modelVersion === null),
  'An absent model version is not invented',
);
assert(ten.scope.includes('produit des probabilités ponctuelles'));
assert.equal(full.modelValidated, false);
// Existing fields are kept; only the tickets block is added.
assert.deepEqual(Object.keys(full), [
  'available',
  'recordedCoupons',
  'settledCoupons',
  'settledSelections',
  'winRate',
  'simulatedROI',
  'brierScore',
  'winRateCI',
  'roiCI',
  'distinctMatches',
  'calibration',
  'sampleWarning',
  'sampleWarningText',
  'tickets',
  'modelValidated',
  'scope',
]);
assert.equal(full.settledSelections, 23);
assert.equal(full.distinctMatches, 23);
assert(full.scope.endsWith('ni une validation du modèle.'));

// A ticket with one selection not yet settled is not counted, whatever its flag says.
const pending = (
  await performance(
    environment([
      legs(2, [true, null]),
      { ...legs(3, [true, true, null]), settled: true },
      { ...legs(2, [true, true]), outcomes: [{ won: true }] },
      legs(1, [true]),
    ]),
  )
).tickets;
assert.equal(pending.settled, 1);
assert.equal(pending.bySelections[2].settled, 0);
assert.equal(pending.bySelections[3].settled, 0);
assert.equal(pending.passRate, 1);

// Recorded combined probability wins; invalid ones fall back; missing selection
// probability leaves the ticket unpriced but still counted in the pass rate.
const priced = (
  await performance(
    environment([
      legs(2, [true, true], 0.8, { combinedProbability: 0.5, modelVersion: 'v-test' }),
      legs(2, [false, true], 0.8, { combinedProbability: 1.5 }),
      ticket([selection(0.8), selection(null)], [true, true]),
    ]),
  )
).tickets;
noNaN(priced);
assert.equal(priced.settled, 3);
assert.equal(priced.withProbability, 2);
assert.deepEqual(
  priced.items.map((t) => [t.announcedProbability, t.probabilitySource]),
  [
    [0.5, 'recorded'],
    [0.8 * 0.8, 'selections'],
    [null, null],
  ],
);
assert.equal(priced.items[0].modelVersion, 'v-test');
close(priced.meanAnnouncedProbability, (0.5 + 0.64) / 2);
close(priced.gap, 0.5 - (0.5 + 0.64) / 2, 1e-12);
close(priced.passRate, 2 / 3);

// Identical tickets counted once; a ticket reusing a match is flagged; mixed books → null.
const shared = selection();
const repeated = (
  await performance(
    environment([
      ticket([shared], [true], {}, 2000),
      ticket([shared], [true], {}, 1000),
      ticket([shared, selection(0.9, 'Other')], [true, false]),
    ]),
  )
).tickets;
assert.equal(repeated.settled, 2);
assert.equal(repeated.sharedMatchTickets, 1);
assert.equal(repeated.items[1].bookmaker, null);

// Warning threshold: 29 tickets warn, 30 do not.
for (const count of [29, 30]) {
  const t = (
    await performance(
      environment(Array.from({ length: count }, (_, i) => ticket([selection()], [true], {}, i))),
    )
  ).tickets;
  assert.equal(t.settled, count);
  assert.equal(t.sampleWarning, count < 30);
  assert.equal(t.sampleWarningText === null, count >= 30);
}

console.log('Example tickets JSON:', JSON.stringify({ ...ten, items: ten.items.slice(0, 2) }));
console.log(
  'Passed: tickets 6/10 Wilson [0.313; 0.832], announced/observed gap, 1–4 leg breakdown, pending tickets excluded, empty without NaN, recorded vs computed probability, deduplication, 30-ticket warning.',
);
