import assert from 'node:assert/strict';
import { performance } from '../src/server/storage.js';

const now = Date.now();
const selection = (matchId, probability = 0.7, odd = 2, bookmaker = 'Book') => ({
  matchId,
  market: 'Match Winner',
  selection: 'Home',
  bookmaker,
  probability,
  odd,
});
const record = (selections, wins, age = 0, settled = true) => ({
  generatedAt: new Date(now - age).toISOString(),
  settled,
  selections,
  outcomes: wins.map((won) => ({ won })),
});
function environment(records) {
  const objects = records.map((data, i) => ({
    key: `observations/${data.generatedAt.slice(0, 10)}/${i}.json`,
    uploaded: new Date(data.generatedAt),
    data,
  }));
  return {
    BUCKET: {
      list: async ({ prefix, limit }) => {
        assert.equal(limit, 1000);
        return { objects: objects.filter((x) => x.key.startsWith(prefix)) };
      },
      get: async (key) => ({ json: async () => objects.find((x) => x.key === key).data }),
    },
  };
}
const close = (actual, expected, tolerance = 1e-12) =>
  assert(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

const empty = await performance(environment([]));
assert.equal(empty.winRate, null);
assert.equal(empty.simulatedROI, null);
assert.equal(empty.winRateCI, null);
assert.equal(empty.roiCI, null);
assert.equal(empty.distinctMatches, 0);
assert.equal(empty.sampleWarning, true);
assert(empty.sampleWarningText.includes('100 matchs distincts'));
assert(empty.calibration.every((x) => x.n === 0 && x.predicted === null && x.observed === null));
assert.equal((await performance({})).available, false);

const ten = environment([
  record(
    Array.from({ length: 10 }, (_, i) => selection(i)),
    Array.from({ length: 10 }, (_, i) => i < 7),
  ),
]);
const stats = await performance(ten);
assert.equal(stats.settledSelections, 10);
assert.equal(stats.distinctMatches, 10);
assert.equal(stats.winRate, 0.7);
assert.equal(stats.simulatedROI, 0.4);
close(stats.brierScore, 0.21);
close(stats.winRateCI[0], 0.397, 0.001);
close(stats.winRateCI[1], 0.892, 0.001);
assert.equal(stats.sampleWarning, true);
assert.equal(stats.modelValidated, false);
assert.deepEqual(await performance(ten), stats, 'Bootstrap must restart its fixed seed each call');

// Three winning events on one match and one loss on another: cluster draws
// have ROI -1 (two losing matches), 0.5 (one of each), or 1 (two winning matches).
// The ROI is selection-weighted, not the mean of the two match averages (0).
const clustered = await performance(
  environment([
    record(
      [
        selection(1, 0.7, 2, 'A'),
        selection(1, 0.7, 2, 'B'),
        selection(1, 0.7, 2, 'C'),
        selection(2),
      ],
      [true, true, true, false],
      1000,
    ),
    record([selection(1, 0.99, 99, 'A')], [false]),
  ]),
);
assert.equal(clustered.settledSelections, 4, 'Repeated events retain the first estimate');
assert.equal(clustered.distinctMatches, 2);
assert.equal(clustered.simulatedROI, 0.5);
assert.deepEqual(clustered.roiCI, [-1, 1], 'Whole matches must be resampled together');
assert.equal(clustered.calibration[0].n, 4);
assert.equal(clustered.calibration[5].n, 0);

// Exact lower boundaries belong to the next bin; 1.00 belongs to the last.
const probabilities = [0.69, 0.7, 0.74, 0.75, 0.8, 0.85, 0.9, 0.95, 1, null, 1.01];
const calibrated = await performance(
  environment([
    record(
      probabilities.map((p, i) => selection(i, p)),
      probabilities.map((_, i) => i % 2 === 0),
    ),
  ]),
);
assert.deepEqual(
  calibrated.calibration.map(({ bin, n }) => ({ bin, n })),
  [
    { bin: '0.70-0.75', n: 2 },
    { bin: '0.75-0.80', n: 1 },
    { bin: '0.80-0.85', n: 1 },
    { bin: '0.85-0.90', n: 1 },
    { bin: '0.90-0.95', n: 1 },
    { bin: '0.95-1.00', n: 2 },
  ],
);
close(calibrated.calibration[0].predicted, 0.72);
assert.equal(calibrated.calibration[0].observed, 0.5);
close(calibrated.calibration[5].predicted, 0.975);
assert.equal(calibrated.calibration[5].observed, 0.5);
assert(calibrated.scope.includes('inférieures à 0,70'));

for (const count of [99, 100]) {
  // Four selections per coupon, within the unchanged 80-coupon window.
  const records = [];
  for (let i = 0; i < count; i += 4) {
    const selections = Array.from({ length: Math.min(4, count - i) }, (_, j) => selection(i + j));
    records.push(
      record(
        selections,
        selections.map(() => true),
        i * 1000,
      ),
    );
  }
  const result = await performance(environment(records));
  assert.equal(result.distinctMatches, count);
  assert.equal(result.sampleWarning, count < 100);
  assert.equal(result.sampleWarningText === null, count >= 100);
  assert.deepEqual(result.roiCI, [1, 1]);
  close(result.winRateCI[1], 1);
}
const repeatedMatch = await performance(
  environment([
    record(
      Array.from({ length: 100 }, (_, i) => selection(1, 0.7, 2, `Book ${i}`)),
      Array(100).fill(false),
    ),
  ]),
);
assert.equal(repeatedMatch.settledSelections, 100);
assert.equal(repeatedMatch.distinctMatches, 1);
assert.equal(repeatedMatch.sampleWarning, true);
assert.deepEqual(repeatedMatch.roiCI, [-1, -1]);
close(repeatedMatch.winRateCI[0], 0);

const excluded = await performance(
  environment([
    record([selection(1)], [true], 8 * 86400000),
    record([selection(2)], [true], 0, false),
    record([selection(3)], [null]),
  ]),
);
assert.equal(excluded.recordedCoupons, 2);
assert.equal(excluded.settledSelections, 0);
const capped = await performance(
  environment(Array.from({ length: 81 }, (_, i) => record([selection(i)], [true], i * 1000))),
);
assert.equal(capped.recordedCoupons, 80);
assert.equal(capped.distinctMatches, 80);

console.log('Example performance JSON:', JSON.stringify(stats));
console.log(
  'Passed: Wilson 7/10 and empty/extreme samples, deterministic match bootstrap, deduplication, calibration boundaries, distinct-match warning, seven-day and 80-coupon scope.',
);
