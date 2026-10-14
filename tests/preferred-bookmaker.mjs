import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  NO_CANDIDATE_REASON,
  PREFERRED_BOOKMAKER,
  PREFERRED_TOLERANCE,
  selectCoupon,
  selectCouponDetailed,
} from '../src/server/coupon.js';
import { POLICY } from '../src/server/policy.js';

const now = Date.parse('2030-01-01T12:00:00Z');
const timestamp = (offset = 0) => new Date(now + offset).toISOString();
// BIS-176 : base 0,95 (et non 0,8) pour que les tickets de quatre respectent le seuil de
// probabilité combinée (0,8⁴ ≈ 0,41 < 0,5) même avec un écart de 80 % côté bet365.
const event = (matchId, bookmaker, prudentProbability = 0.95) => ({
  matchId,
  bookmaker,
  prudentProbability,
  prudentEdge: 0.1,
  status: 'simulation_eligible',
  kickoff: timestamp(7200000),
  updated: timestamp(),
  modelValidated: false,
  realMoneyEligible: false,
});
const reportsFor = (ratio, count = 4, name = PREFERRED_BOOKMAKER) =>
  Array.from({ length: 4 }, (_, i) => ({
    matchId: i + 1,
    retrievedAt: timestamp(),
    events: [
      event(i + 1, 'Other'),
      ...(i < count ? [event(i + 1, name, 0.95 * ratio ** 0.25)] : []),
    ],
  }));
function verifyWrapper(reports) {
  const snapshot = structuredClone(reports);
  const detailed = selectCouponDetailed(reports, now);
  assert.deepEqual(selectCoupon(reports, now), detailed.selections);
  assert.deepEqual(reports, snapshot, 'Le sélecteur ne modifie pas les rapports');
  assert(detailed.selections.length <= 4);
  assert.equal(new Set(detailed.selections.map((e) => e.matchId)).size, detailed.selections.length);
  assert(new Set(detailed.selections.map((e) => e.bookmaker.trim().toLowerCase())).size <= 1);
  for (const e of detailed.selections) {
    assert.equal(e.modelValidated, false);
    assert.equal(e.realMoneyEligible, false);
  }
  return detailed;
}
assert.equal(PREFERRED_BOOKMAKER, 'Bet365');
assert.equal(PREFERRED_TOLERANCE, 0.9);
for (const [ratio, used] of [
  [0.95, true],
  [0.8, false],
  [0.9, true],
  [0.899, false],
  [1, true],
  [1.05, true],
]) {
  const result = verifyWrapper(reportsFor(ratio));
  assert.equal(result.selections.length, 4);
  assert.equal(result.bookmaker, used ? PREFERRED_BOOKMAKER : 'Other');
  assert.equal(result.preferredBookmakerUsed, used);
  assert.equal(result.preferredBookmakerUnavailable, !used);
  assert(Math.abs(result.scoreGap - Math.max(0, 1 - ratio)) < 1e-12);
}
const shorter = verifyWrapper(reportsFor(1.2, 3));
assert.equal(shorter.bookmaker, 'Other');
assert.equal(shorter.preferredBookmakerUnavailable, true);
assert.equal(shorter.scoreGap, null);

for (const name of ['Bet365', 'bet365', '  Bet365  ']) {
  const result = verifyWrapper(reportsFor(0.95, 4, name));
  assert.equal(result.bookmaker, PREFERRED_BOOKMAKER);
  assert.equal(result.preferredBookmakerUsed, true);
}
for (const name of ['notbet365', 'Bet365x']) {
  const result = verifyWrapper(reportsFor(0.95, 4, name));
  assert.equal(result.bookmaker, 'Other');
  assert.equal(result.preferredBookmakerUsed, false);
  assert.equal(result.preferredBookmakerUnavailable, true);
  assert.equal(result.scoreGap, null);
}
const mixed = reportsFor(0.95);
mixed[1].events[1].bookmaker = 'bet365';
mixed[2].events[1].bookmaker = ' Bet365 ';
assert.equal(verifyWrapper(mixed).selections.length, 4);
assert.equal(verifyWrapper(mixed).preferredBookmakerUsed, true);

const empty = {
  selections: [],
  bookmaker: null,
  preferredBookmakerUsed: false,
  preferredBookmakerUnavailable: true,
  scoreGap: null,
  ticketProbability: null,
  ticketProbabilityExploratory: null,
  minTicketProbability: POLICY.minTicketProbability,
  noTicketReason: NO_CANDIDATE_REASON,
  modelValidated: false,
  realMoneyEligible: false,
};
assert.deepEqual(verifyWrapper([]), empty);
for (const mutate of [
  (r) => {
    r.events.forEach((e) => {
      e.status = 'reject';
    });
  },
  (r) => {
    r.events.forEach((e) => {
      e.kickoff = timestamp();
    });
  },
  (r) => {
    r.events.forEach((e) => {
      e.updated = timestamp(-POLICY.maxOddsAgeMs - 1);
    });
  },
  (r) => {
    r.events.forEach((e) => {
      e.updated = timestamp(300001);
    });
  },
  (r) => {
    r.events.forEach((e) => {
      e.updated = 'invalid';
    });
  },
  (r) => {
    r.retrievedAt = timestamp(-15 * 60000 - 1);
  },
]) {
  const reports = reportsFor(0.95);
  reports.forEach(mutate);
  assert.deepEqual(verifyWrapper(reports), empty, 'Aucun contournement des refus existants');
}
const rejectedPreferred = reportsFor(0.95);
rejectedPreferred.forEach((r) => {
  r.events[1].status = 'reject';
});
assert.equal(verifyWrapper(rejectedPreferred).bookmaker, 'Other');
assert.equal(verifyWrapper(rejectedPreferred).preferredBookmakerUnavailable, true);

// Même scénario A/B que tests/full-universe.mjs : résultat de main, sans bet365.
const legacy = [
  ...[0.9, 0.8, 0.8, 0.8].map((p, i) => ({
    retrievedAt: timestamp(),
    events: [event(i + 1, 'A', p)],
  })),
  ...[0.86, 0.86, 0.86, 0.86].map((p, i) => ({
    retrievedAt: timestamp(),
    events: [event(i + 5, 'B', p)],
  })),
];
const unchanged = verifyWrapper(legacy);
assert.deepEqual(
  unchanged.selections,
  legacy.slice(4).map((r) => r.events[0]),
);
assert.equal(unchanged.bookmaker, 'B');
assert.equal(unchanged.scoreGap, null);
const tie = [{ retrievedAt: timestamp(), events: [event(1, 'Z'), event(1, 'A')] }];
assert.deepEqual(verifyWrapper(tie).selections, [tie[0].events[0]]);
const many = reportsFor(0.95);
many.push({ retrievedAt: timestamp(), events: [event(5, 'Bet365', 0.7), event(5, 'Other', 0.7)] });
many[0].events.push(event(1, 'Bet365', 0.5));
assert.equal(verifyWrapper(many).selections.length, 4);

// app.js est servi comme script classique : sa fonction globale est son export navigateur.
// Exécuter le véritable client prouve la présélection et la conservation du choix manuel.
const nodes = new Map();
const node = (key) => {
  if (!nodes.has(key))
    nodes.set(key, {
      value: key === '#stake' ? '10' : key === '#calcOdds' ? '1.8' : key === '#calcP' ? '60' : '',
      classList: { add() {}, remove() {}, toggle() {} },
      dataset: {},
      scrollIntoView() {},
    });
  return nodes.get(key);
};
let books = [
  { name: 'First', bets: [] },
  { name: 'Second', bets: [] },
  { name: 'Bet365', bets: [] },
];
const context = vm.createContext({
  document: { querySelector: node, querySelectorAll: () => [] },
  localStorage: { getItem: () => null },
  setTimeout() {},
  setInterval() {},
  clearInterval() {},
  fetch: async (path) => ({
    ok: true,
    text: async () =>
      JSON.stringify(
        path.startsWith('/api/match?')
          ? {
              fixture: {
                fixture: {
                  id: Number(new URL(path, 'https://site').searchParams.get('id')),
                  date: timestamp(7200000),
                  timestamp: (now + 7200000) / 1000,
                  status: { short: 'NS' },
                },
                league: { name: 'League' },
                teams: { home: { id: 1, name: 'Home' }, away: { id: 2, name: 'Away' } },
              },
              home: [],
              away: [],
              errors: {},
              injuries: [],
              lineups: [],
              retrievedAt: timestamp(),
              odds: [{ update: timestamp(), bookmakers: books }],
            }
          : {
              configured: false,
              response: [],
              paging: { total: 1 },
              subscription: {},
              requests: {},
            },
      ),
  }),
});
vm.runInContext(await readFile('src/web/app.js', 'utf8'), context);
await new Promise((resolve) => setImmediate(resolve));
const preferredBookIndex = context.preferredBookIndex;
assert.equal(typeof preferredBookIndex, 'function');
assert.equal(preferredBookIndex(books), 2);
assert.equal(preferredBookIndex([{ name: 'First' }]), 0);
assert.equal(preferredBookIndex([{ name: 'Other' }, { name: ' bet365 ' }]), 1);
assert.equal(preferredBookIndex([]), 0);
for (const name of ['notbet365', 'Bet365x']) {
  assert.equal(preferredBookIndex([{ name: 'Other' }, { name }]), 0);
  assert.equal(preferredBookIndex([{ name }, { name: 'Bet365' }]), 1);
}
assert.equal(preferredBookIndex([{}, { name: 'Bet365' }]), 1);
await vm.runInContext('detail(7)', context);
assert.equal(node('#book').value, '2');
assert.match(node('#book').innerHTML, /option value="2">Bet365/);
node('#book').value = '1';
node('#book').onchange();
vm.runInContext('renderMarkets()', context);
assert.equal(node('#book').value, '1');
await vm.runInContext('detail(7)', context);
assert.equal(node('#book').value, '1');
books = [books[1], books[2], books[0]];
await vm.runInContext('detail(7)', context);
assert.equal(node('#book').value, '0', 'Le choix suit le bookmaker quand les index changent');
await vm.runInContext('detail(8)', context);
assert.equal(node('#book').value, '1', 'Un autre match reçoit son propre défaut');
books = [{ name: 'First', bets: [] }];
await vm.runInContext('detail(7)', context);
assert.equal(node('#book').value, '0');
books = [];
await vm.runInContext('detail(9)', context);
assert.match(node('#marketTable').innerHTML, /Aucune cote retournée/);
books = [{ bets: [] }, { name: 'Bet365', bets: [] }];
await vm.runInContext('detail(10)', context);
assert.doesNotMatch(node('#details').innerHTML, /id="detailError"/);
assert.match(node('#details').innerHTML, /id="marketTable"/);
assert.equal(node('#book').value, '1', 'Bet365 reste présélectionné malgré le nom absent');
node('#book').value = '0';
assert.doesNotThrow(() => node('#book').onchange());
await vm.runInContext('detail(10)', context);
assert.doesNotMatch(node('#details').innerHTML, /id="detailError"/);
assert.equal(node('#book').value, '0', 'Le choix manuel sans nom survit au nouveau rendu');
console.log(
  'Passed: preferred bookmaker 95%/80%/90% boundary, size, refusals, empty contract, casing, legacy fixtures, wrapper, exact names, nameless bookmaker and manual selector preservation.',
);
