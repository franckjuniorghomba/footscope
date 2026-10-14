import assert from 'node:assert/strict';
import {
  BELOW_THRESHOLD_REASON,
  NO_CANDIDATE_REASON,
  PREFERRED_BOOKMAKER,
  PREFERRED_TOLERANCE,
  selectCoupon,
  selectCouponDetailed,
} from '../src/server/coupon.js';
import { POLICY } from '../src/server/policy.js';

const now = Date.parse('2030-01-01T12:00:00Z');
const timestamp = (offset = 0) => new Date(now + offset).toISOString();
const close = (a, b) => Math.abs(a - b) < 1e-12;
const event = (matchId, bookmaker, prudentProbability, extra = {}) => ({
  matchId,
  bookmaker,
  prudentProbability,
  probability: Math.min(1, prudentProbability + 0.05),
  prudentEdge: 0.1,
  odd: 1.5,
  status: 'simulation_eligible',
  kickoff: timestamp(7200000),
  updated: timestamp(),
  modelValidated: false,
  realMoneyEligible: false,
  ...extra,
});
const report = (matchId, events) => ({ matchId, retrievedAt: timestamp(), events });
const single = (book, probabilities, first = 1) =>
  probabilities.map((p, i) => report(first + i, [event(first + i, book, p)]));
const product = (xs, field = 'prudentProbability') => xs.reduce((p, e) => p * e[field], 1);

function check(reports) {
  const snapshot = structuredClone(reports);
  const result = selectCouponDetailed(reports, now);
  assert.deepEqual(selectCoupon(reports, now), result.selections, 'selectCoupon reste un tableau');
  assert.deepEqual(reports, snapshot, 'Le sélecteur ne modifie pas les rapports');
  const { selections } = result;
  assert(selections.length <= POLICY.maxSelections, 'Quatre sélections au plus');
  assert.equal(new Set(selections.map((e) => e.matchId)).size, selections.length, 'Un par match');
  assert(
    new Set(selections.map((e) => e.bookmaker.trim().toLowerCase())).size <= 1,
    'Un seul bookmaker',
  );
  assert.equal(result.modelValidated, false);
  assert.equal(result.realMoneyEligible, false);
  assert.equal(result.minTicketProbability, POLICY.minTicketProbability);
  if (selections.length) {
    assert(close(result.ticketProbability, product(selections)));
    assert(result.ticketProbability >= POLICY.minTicketProbability, 'Jamais sous le seuil');
    assert.equal(result.noTicketReason, null);
  } else {
    assert.equal(result.ticketProbability, null);
    assert.equal(result.ticketProbabilityExploratory, null);
    assert.equal(typeof result.noTicketReason, 'string');
  }
  for (const e of selections) {
    assert.equal(e.modelValidated, false);
    assert.equal(e.realMoneyEligible, false);
  }
  return result;
}

assert.equal(POLICY.minTicketProbability, 0.5);
assert.equal(POLICY.maxSelections, 4);

// Critère 1 : 0,90 puis 0,72 (0,648) ; un troisième donnerait 0,467 < 0,5.
const strong = check(single('Book', [0.72, 0.9, 0.72, 0.72, 0.72]));
assert.deepEqual(
  strong.selections.map((e) => e.prudentProbability),
  [0.9, 0.72],
);
assert(close(strong.ticketProbability, 0.648));
assert(0.648 * 0.72 < POLICY.minTicketProbability);
// Ancienne règle : quatre à 0,72 (0,27) l'emportaient sur un ticket plus court.
const legacy = check([...single('A', [0.72, 0.72, 0.72, 0.72]), ...single('B', [0.9], 5)]);
assert.equal(legacy.bookmaker, 'A');
assert.equal(legacy.selections.length, 2, 'Jamais les quatre à 0,72');
assert(close(legacy.ticketProbability, 0.72 * 0.72));

// Critère 2 : quatre à 0,85 donnent 0,522, au-dessus du seuil.
const four = check(single('Book', [0.85, 0.85, 0.85, 0.85, 0.85]));
assert.equal(four.selections.length, 4, 'La limite de quatre reste appliquée');
assert(close(four.ticketProbability, 0.85 ** 4));
assert(close(four.ticketProbabilityExploratory, 0.9 ** 4));

// Critère 4 : aucune sélection seule ≥ 0,5 → tableau vide et motif.
const weak = check(single('Book', [0.49, 0.3, 0.45]));
assert.deepEqual(weak.selections, []);
assert.deepEqual(selectCoupon(single('Book', [0.49]), now), []);
assert.equal(weak.noTicketReason, BELOW_THRESHOLD_REASON);
assert.match(BELOW_THRESHOLD_REASON, /50 %/);
assert.equal(weak.bookmaker, null);
assert.equal(check([]).noTicketReason, NO_CANDIDATE_REASON);
// Bornes exactes du seuil.
assert.equal(check(single('Book', [0.5])).selections.length, 1);
assert.equal(check(single('Book', [0.4999999])).selections.length, 0);
assert.equal(check(single('Book', [1, 0.5, 0.99])).selections.length, 2);
// Produit combiné exactement au seuil : 1 × 0,8 × 0,625 = 0,5, accepté.
const exact = check(single('Book', [1, 0.8, 0.625]));
assert.equal(exact.selections.length, 3);
assert.equal(exact.ticketProbability, 0.5);

// Égalités : à probabilité et marge égales, l'ordre d'entrée décide (tri stable).
const ties = single('Book', [0.85, 0.85, 0.85, 0.85, 0.85]);
const shuffled = [ties[4], ties[1], ties[2], ties[0], ties[3]];
assert.deepEqual(
  check(shuffled).selections.map((e) => e.matchId),
  [5, 2, 3, 1],
);
assert.deepEqual(
  check(shuffled).selections.map((e) => e.matchId),
  [5, 2, 3, 1],
  'Même entrée, même ticket',
);
// À probabilité égale, la meilleure marge prudente passe devant, puis l'ordre d'entrée.
ties[3].events[0].prudentEdge = 0.2;
assert.deepEqual(
  check(ties).selections.map((e) => e.matchId),
  [4, 1, 2, 3],
);
// Deux bookmakers à égalité parfaite : le premier rencontré l'emporte (hors bet365).
const level = [report(1, [event(1, 'A', 0.8), event(1, 'B', 0.8)])];
assert.equal(check(level).bookmaker, 'A');

// Critère 5 : deux bookmakers au-dessus du seuil, bet365 préféré selon la tolérance existante.
const duel = (bet365, other) => [
  ...bet365.map((p, i) => report(i + 1, [event(i + 1, PREFERRED_BOOKMAKER, p)])),
  ...other.map((p, i) => report(i + 11, [event(i + 11, 'Other', p)])),
];
const within = check(duel([0.82, 0.82], [0.85, 0.85]));
assert.equal(within.bookmaker, PREFERRED_BOOKMAKER);
assert.equal(within.preferredBookmakerUsed, true);
assert(within.scoreGap < 1 - PREFERRED_TOLERANCE);
const beyond = check(duel([0.75, 0.75], [0.9, 0.9]));
assert.equal(beyond.bookmaker, 'Other', 'Écart de 30 % : hors tolérance');
assert.equal(beyond.preferredBookmakerUsed, false);
assert(close(beyond.scoreGap, 1 - (0.75 * 0.75) / (0.9 * 0.9)));
// bet365 n'a qu'un ticket plus court sous le seuil : le ticket plus long est retenu.
const shorter = check(duel([0.99, 0.5], [0.8, 0.8]));
assert.equal(shorter.bookmaker, 'Other');
assert.equal(shorter.scoreGap, null);
// bet365 seul sous le seuil : jamais retenu malgré sa priorité.
const below = check(duel([0.45], [0.55]));
assert.equal(below.bookmaker, 'Other');
assert.equal(below.preferredBookmakerUsed, false);
assert.equal(check(duel([0.45], [])).noTicketReason, BELOW_THRESHOLD_REASON);

// Probabilité exploratoire : produit des probabilités du modèle, null si l'une manque.
const missing = single('Book', [0.9, 0.9]);
missing[1].events[0].probability = null;
assert.equal(check(missing).ticketProbabilityExploratory, null);

// Entrées invalides ignorées, jamais converties en sélection.
for (const p of [Number.NaN, -0.2, 0, 1.2, '0.9', null, undefined, Infinity]) {
  const bad = single('Book', [0.9]);
  bad.push(report(2, [event(2, 'Book', p)]));
  const result = check(bad);
  assert.deepEqual(
    result.selections.map((e) => e.matchId),
    [1],
    'Probabilité invalide : ' + String(p),
  );
}
// Un même match dans deux rapports ne donne qu'une sélection, la meilleure.
const twice = [report(1, [event(1, 'Book', 0.8)]), report(1, [event(1, 'Book', 0.9)])];
assert.deepEqual(
  check(twice).selections.map((e) => e.prudentProbability),
  [0.9],
);

// Critère 3 : propriétés sur des univers aléatoires, contrôlées par force brute.
let seed = 176;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const subsets = (xs, max) => {
  const out = [[]];
  for (const x of xs) for (const s of out.slice()) if (s.length < max) out.push([...s, x]);
  return out;
};
const names = [PREFERRED_BOOKMAKER, 'A', 'B'];
for (let round = 0; round < 300; round++) {
  const reports = Array.from({ length: 1 + Math.floor(random() * 7) }, (_, i) =>
    report(
      i + 1,
      names
        .filter(() => random() < 0.7)
        .flatMap((book) =>
          Array.from({ length: 1 + Math.floor(random() * 2) }, () =>
            event(i + 1, book, Math.round((0.3 + random() * 0.7) * 1000) / 1000),
          ),
        ),
    ),
  );
  const result = check(reports);
  // Meilleure taille réalisable, tous bookmakers confondus, sur une sélection par match.
  let bestSize = 0;
  let bestProbability = 0;
  for (const book of names) {
    const perMatch = reports
      .map((r) => r.events.filter((e) => e.bookmaker === book))
      .filter((xs) => xs.length)
      .map((xs) => xs.reduce((a, b) => (b.prudentProbability > a.prudentProbability ? b : a)));
    for (const s of subsets(perMatch, POLICY.maxSelections)) {
      const p = product(s);
      if (s.length && p >= POLICY.minTicketProbability)
        if (s.length > bestSize || (s.length === bestSize && p > bestProbability)) {
          bestSize = s.length;
          bestProbability = p;
        }
    }
  }
  assert.equal(result.selections.length, bestSize, 'Le plus grand ticket qui respecte le seuil');
  if (bestSize) {
    if (result.preferredBookmakerUsed)
      assert(result.ticketProbability + 1e-12 >= bestProbability * PREFERRED_TOLERANCE);
    else assert(close(result.ticketProbability, bestProbability), 'Puis la plus probable');
  } else {
    assert.equal(
      result.noTicketReason,
      reports.some((r) => r.events.length) ? BELOW_THRESHOLD_REASON : NO_CANDIDATE_REASON,
    );
  }
}

console.log(
  'Passed: ticket probability 0.9/0.72 greedy (0.648), four at 0.85 (0.522), no ticket below 0.5 with reason, threshold bounds, bet365 tolerance above threshold only, exploratory product, exact 0.5 product, stable ties, invalid inputs, duplicate match, 300 brute-force universes.',
);
