// BIS-200 : valeur face au marché (cote bet365 contre cote juste Pinnacle), descriptive.
// Réseau simulé : aucun secret, aucun appel payant.
import assert from 'node:assert/strict';
import {
  marketValue,
  marketValueSummary,
  sharpReference,
  MARKET_VALUE_REASONS,
} from '../src/server/market.js';
import { assessMatch } from '../src/server/statistics.js';
import { selectCouponDetailed } from '../src/server/coupon.js';
import { buildLlmInput } from '../src/server/llm.js';
import { finishEvidence } from '../src/server/jobs.js';
import { assistant } from '../src/server/assistant.js';
import { POLICY } from '../src/server/policy.js';

const now = Date.parse('2030-01-01T12:00:00Z');
const at = (offset = 0) => new Date(now + offset).toISOString();
const close = (a, b, eps = 1e-9) => assert(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const SENTINEL = 'SENTINELLE-BIS-200';

const pinnacle = (extra = {}) => ({
  bookmaker: 'Pinnacle',
  matchId: 7,
  updated: at(-60000),
  bets: [
    {
      name: 'Match Winner',
      values: [
        { value: 'Home', odd: '2.00' },
        { value: 'Draw', odd: '3.50' },
        { value: 'Away', odd: '4.00' },
      ],
    },
    {
      name: 'Goals Over/Under',
      values: [
        { value: 'Over 1.5', odd: '1.30' },
        { value: 'Over 2.5', odd: '1.90' },
        { value: 'Under 2.5', odd: '1.95' },
      ],
    },
    {
      name: 'Both Teams Score',
      values: [
        { value: 'Yes', odd: '1.80' },
        { value: 'No', odd: '2.05' },
      ],
    },
  ],
  ...extra,
});
const bet = (market, selection, odd, extra = {}) => ({
  matchId: 7,
  market,
  selection,
  odd,
  bookmaker: 'Bet365',
  updated: at(-120000),
  ...extra,
});

// Critère : bet365 2,10 contre Pinnacle 2,00 / 3,50 / 4,00 → cote juste 29/14, +1,38 %.
const home = marketValue(bet('Match Winner', 'Home', 2.1), pinnacle(), now);
close(home.fairOdd, 29 / 14);
close(home.fairProbability, 14 / 29);
close(home.marketValue, 2.1 / (29 / 14) - 1);
assert.equal((home.marketValue * 100).toFixed(2), '1.38');
assert.equal(home.hasValue, true);
assert.equal(home.reason, null);
const below = marketValue(bet('Match Winner', 'Away', 4.0), pinnacle(), now);
close(below.fairOdd, 29 / 7);
assert(below.marketValue < 0 && below.hasValue === false);
// Cote égale à la cote juste : pas de valeur (pas d'arrondi favorable).
assert.equal(marketValue(bet('Match Winner', 'Home', 29 / 14), pinnacle(), now).hasValue, false);

// Deux issues : somme à 1e-9 près, chaque côté normalisé avec son partenaire de ligne.
const over = marketValue(bet('Goals Over/Under', 'Over 2.5', 2.0), pinnacle(), now);
const under = marketValue(bet('Goals Over/Under', 'Under 2.5', 2.0), pinnacle(), now);
close(over.fairProbability + under.fairProbability, 1);
close(over.fairProbability, 1 / 1.9 / (1 / 1.9 + 1 / 1.95));
close(over.marketValue, 2.0 * over.fairProbability - 1);
const yes = marketValue(bet('Both Teams Score', 'Yes', 1.9), pinnacle(), now);
const no = marketValue(bet('Both Teams Score', 'No', 1.9), pinnacle(), now);
close(yes.fairProbability + no.fairProbability, 1);
close(yes.fairProbability, 1 / 1.8 / (1 / 1.8 + 1 / 2.05));
// Over 1.5 sans Under 1.5 : marché incomplet, jamais complété par une autre ligne.
assert.equal(
  marketValue(bet('Goals Over/Under', 'Over 1.5', 1.4), pinnacle(), now).reasonCode,
  'INCOMPLETE_MARKET',
);

// Double chance : somme de deux issues 1X2 justes, jamais normalisée directement.
for (const [selection, p] of [
  ['Home/Draw', 22 / 29],
  ['Draw/Away', 15 / 29],
  ['Home/Away', 21 / 29],
]) {
  const dc = marketValue(bet('Double Chance', selection, 1.4), pinnacle(), now);
  close(dc.fairProbability, p);
  close(dc.fairOdd, 1 / p);
  close(dc.marketValue, 1.4 * p - 1);
}
// Une cote Pinnacle de double chance présente ne change rien au calcul.
const withDc = pinnacle();
withDc.bets.push({ name: 'Double Chance', values: [{ value: 'Home/Draw', odd: '1.01' }] });
close(marketValue(bet('Double Chance', 'Home/Draw', 1.4), withDc, now).fairProbability, 22 / 29);

// Refus : null avec sa raison, sans valeur ni cote juste.
const refused = (event, reference, code) => {
  const r = marketValue(event, reference, now);
  assert.equal(r.reasonCode, code, code);
  assert.equal(r.reason, MARKET_VALUE_REASONS[code]);
  assert.equal(r.marketValue, null);
  assert.equal(r.fairOdd, null);
  assert.equal(r.hasValue, null);
};
const mw = bet('Match Winner', 'Home', 2.1);
refused(mw, null, 'NO_REFERENCE');
refused(mw, undefined, 'NO_REFERENCE');
refused(mw, pinnacle({ updated: at(-POLICY.maxOddsAgeMs - 1) }), 'STALE_REFERENCE');
refused(mw, pinnacle({ updated: at(300001) }), 'STALE_REFERENCE');
refused(mw, pinnacle({ updated: 'invalid' }), 'STALE_REFERENCE');
refused({ ...mw, updated: at(-POLICY.maxOddsAgeMs - 1) }, pinnacle(), 'STALE_QUOTE');
refused({ ...mw, updated: undefined }, pinnacle(), 'STALE_QUOTE');
refused(mw, pinnacle({ matchId: 8 }), 'OTHER_MATCH');
refused({ ...mw, bookmaker: 'Unibet' }, pinnacle(), 'NOT_BET365');
refused({ ...mw, bookmaker: 'Pinnacle' }, pinnacle(), 'NOT_BET365');
refused({ ...mw, odd: '2.10' }, pinnacle(), 'NOT_BET365');
refused(bet('Corners', 'Over 9.5', 1.9), pinnacle(), 'UNSUPPORTED');
refused(bet('Match Winner', 'Other', 1.9), pinnacle(), 'UNSUPPORTED');
refused({ missing: true, matchId: 7, odd: 99, bookmaker: 'Bet365' }, pinnacle(), 'EVENT_MISSING');
for (const mutate of [
  (r) => r.bets[0].values.pop(),
  (r) => (r.bets[0].values[1].odd = '0,9'),
  (r) => (r.bets[0].values[1].odd = 1),
  (r) => r.bets[0].values.push({ value: 'Away', odd: '4' }),
  (r) => r.bets.push(structuredClone(r.bets[0])),
  (r) => r.bets.splice(0, 1),
]) {
  const reference = pinnacle();
  mutate(reference);
  refused(mw, reference, 'INCOMPLETE_MARKET');
  refused(bet('Double Chance', 'Home/Draw', 1.4), reference, 'INCOMPLETE_MARKET');
}
for (const mutate of [
  (r) => r.bets[2].values.pop(),
  (r) => r.bets[2].values.push({ value: 'Yes', odd: '1.7' }),
  (r) => (r.bets[2].values[0].odd = null),
]) {
  const reference = pinnacle();
  mutate(reference);
  refused(bet('Both Teams Score', 'Yes', 1.9), reference, 'INCOMPLETE_MARKET');
}
// Bornes de fraîcheur identiques aux événements : 30 minutes, futur toléré 5 minutes.
for (const offset of [-POLICY.maxOddsAgeMs, 300000])
  assert.equal(marketValue(mw, pinnacle({ updated: at(offset) }), now).reasonCode, null);

// Relevé Pinnacle extrait des cotes du match, sans muter l'entrée.
const records = [
  {
    fixture: { id: 7 },
    update: at(-60000),
    bookmakers: [{ name: 'Pinnacle', bets: pinnacle().bets }],
  },
  {
    fixture: { id: 7 },
    update: at(-120000),
    bookmakers: [
      {
        name: 'Bet365',
        bets: [
          {
            name: 'Match Winner',
            values: [
              { value: 'Home', odd: '2.10' },
              { value: 'Draw', odd: '3.40' },
              { value: 'Away', odd: '3.80' },
            ],
          },
        ],
      },
    ],
  },
];
const snapshot = structuredClone(records);
assert.deepEqual(sharpReference(records, 7), pinnacle());
assert.deepEqual(records, snapshot);
assert.equal(sharpReference(records.slice(1), 7), null);
assert.equal(sharpReference(null, 7), null);
const older = structuredClone(records[0]);
older.update = at(-600000);
older.bookmakers[0].bets[0].values[0].odd = '9';
assert.deepEqual(sharpReference([older, records[0]], 7), pinnacle());
// Un relevé d'un autre match n'est jamais préféré à celui du bon match.
const other = structuredClone(records[0]);
other.fixture.id = 8;
other.update = at();
assert.equal(sharpReference([other, records[0]], 7).matchId, 7);
assert.equal(sharpReference([other], 7).matchId, 8);

// Rapport réel : mêmes verdicts et même ticket avec ou sans le repère Pinnacle.
const game = (id, h, a, t) => ({
  fixture: { id, timestamp: t / 1000, date: new Date(t).toISOString(), status: { short: 'FT' } },
  teams: { home: { id: h, name: 'Home' }, away: { id: a, name: 'Away' } },
  league: { name: 'Ligue', country: 'Test' },
  goals: { home: 2, away: 1 },
});
const fixture = game(7, 1, 2, now + 7200000);
fixture.fixture.status.short = 'NS';
const data = (odds) => ({
  fixture,
  odds,
  home: Array.from({ length: 10 }, (_, i) => game(i + 10, 1, 3, now - (i + 1) * 86400000)),
  away: Array.from({ length: 10 }, (_, i) => game(i + 30, 2, 4, now - (i + 1) * 86400000)),
  errors: {},
  injuries: [],
  lineups: [],
  retrievedAt: at(),
});
const report = assessMatch(data(records), now);
assert.deepEqual(report.sharpReference, pinnacle());
assert.equal(assessMatch(data(records.slice(1)), now).sharpReference, null);
const { sharpReference: _sharp, ...withoutSharp } = report;
assert.deepEqual(selectCouponDetailed([report], now), selectCouponDetailed([withoutSharp], now));
assert.equal(report.modelValidated, false);
assert(report.events.every((e) => e.realMoneyEligible === false));

// Synthèse du ticket : oui seulement si toutes les sélections ont une valeur calculée > 0.
const reports = [{ matchId: 7, sharpReference: pinnacle() }];
const yesTicket = marketValueSummary(reports, { selection: [mw] }, now);
assert.equal(yesTicket.allSelectionsHaveValue, true);
assert.equal(yesTicket.checks[0].role, 'selection');
const noTicket = marketValueSummary(
  [...reports, { matchId: 8, sharpReference: null }],
  { selection: [mw, { ...mw, matchId: 8 }] },
  now,
);
assert.equal(noTicket.allSelectionsHaveValue, false, 'Un repère absent ne vaut pas « oui »');
assert.equal(noTicket.checks[1].reasonCode, 'NO_REFERENCE');
assert.equal(marketValueSummary(reports, { selection: [] }, now).allSelectionsHaveValue, null);
assert.equal(
  marketValueSummary(reports, { review: [{ missing: true, matchId: 7 }] }, now)
    .allSelectionsHaveValue,
  false,
);

// Intégration : route de proposition avec bet365 et Pinnacle du même match.
Date.now = () => now;
const db = new Map();
const bucket = {
  get: async (k) => (db.has(k) ? { json: async () => JSON.parse(db.get(k)) } : null),
  put: async (k, v) => {
    db.set(k, v);
    return {};
  },
};
let llmInputs = [];
globalThis.fetch = async (url, options) => {
  assert.equal(url, 'https://api.openai.com/v1/responses', 'Seul le LLM simulé est appelé');
  const body = JSON.parse(options.body);
  llmInputs.push(body.input);
  const text = JSON.stringify({ summary: 'Simulé', reasons: [], risks: [] });
  return Response.json({ output: [{ content: [{ type: 'output_text', text }] }] });
};
const env = { BUCKET: bucket, OPENAI_API_KEY: 'mock-key', LLM_MODEL: 'mock-model' };
const event = (matchId, extra = {}) => ({
  matchId,
  match: 'Club ' + matchId + ' — Visiteur ' + matchId,
  bookmaker: 'Bet365',
  market: 'Match Winner',
  selection: 'Home',
  odd: 2.1,
  probability: 0.9,
  prudentProbability: 0.85,
  prudentEdge: 0.1,
  status: 'simulation_eligible',
  kickoff: at(7200000),
  updated: at(-120000),
  reasons: [],
  realMoneyEligible: false,
  ...extra,
});
const proposalReport = (matchId, events, sharp) => ({
  matchId,
  match: 'Club ' + matchId + ' — Visiteur ' + matchId,
  country: 'France',
  league: 'Ligue A',
  kickoff: at(7200000),
  retrievedAt: at(),
  common: [],
  events,
  modelValidated: false,
  ...(sharp === undefined ? {} : { sharpReference: sharp }),
});
let jobs = 0;
async function propose(list) {
  db.clear();
  llmInputs = [];
  const id = '00000000-0000-4000-8000-' + String(++jobs).padStart(12, '0');
  db.set(
    'jobs/' + id + '/manifest.json',
    JSON.stringify({
      id,
      owner: 'private-site',
      createdAt: at(),
      scope: { date: '2030-01-01', country: '', league: '', search: '' },
      fixtures: list.map((r) => ({ fixture: { id: r.matchId } })),
      quoteDays: [],
      quoteTotals: {},
      quoteCompleted: [],
      finalChecked: Object.fromEntries(list.map((r) => [r.matchId, now])),
    }),
  );
  for (const r of list) {
    const snapshotId = String(r.matchId).padStart(64, '0');
    const prefix = 'jobs/' + id + '/evidence/';
    db.set(prefix + 'original/' + r.matchId + '.json', JSON.stringify({ snapshotId }));
    db.set(
      prefix + 'snapshots/' + snapshotId + '.json',
      JSON.stringify({
        report: r,
        policy: POLICY,
        evaluatedAt: at(),
        sources: {},
        screeningReasons: [],
        quoteSummary: [],
      }),
    );
    db.set(
      'jobs/' + id + '/reports/' + r.matchId + '.json',
      JSON.stringify({ ...r, evidenceSnapshotId: snapshotId }),
    );
  }
  const req = new Request('https://site/api/assistant/propose', {
    method: 'POST',
    body: JSON.stringify({ jobId: id }),
  });
  const response = await finishEvidence(
    req,
    env,
    await assistant(req, env, '/api/assistant/propose'),
  );
  assert.equal(response.status, 200);
  return response.json();
}
// La sentinelle est cachée dans le repère : elle ne doit jamais atteindre le LLM.
const sharpWithSentinel = (matchId) => {
  const ref = pinnacle({ matchId, note: SENTINEL });
  ref.bets.push({ name: SENTINEL, values: [{ value: SENTINEL, odd: '2' }] });
  return ref;
};
const universe = (sharp) => [
  proposalReport(7, [event(7)], sharp(7)),
  proposalReport(8, [event(8, { odd: 1.9, prudentProbability: 0.8 })], sharp(8)),
  // Candidat écarté par le seuil de 0,5 : sa valeur est calculée, rôle « excluded ».
  proposalReport(9, [event(9, { prudentProbability: 0.3 })], sharp(9)),
];
const withValue = await propose(universe(sharpWithSentinel));
const llmWith = llmInputs.slice();
// Le dossier de preuves archive la même entrée LLM : sans la sentinelle non plus.
const archived = [...db.values()]
  .map((v) => JSON.parse(v))
  .filter((v) => v?.llm && Object.hasOwn(v.llm, 'input'));
assert.equal(archived.length, 1);
assert(archived[0].llm.input && !JSON.stringify(archived[0].llm.input).includes(SENTINEL));
const without = await propose(universe(() => undefined));
const llmWithout = llmInputs.slice();

assert.equal(withValue.selections.length, 2);
const strip = ({ market, generatedAt, evidence, jobId, ...rest }) => rest;
assert.deepEqual(strip(withValue), strip(without), 'Ticket, verdicts et seuils identiques');
assert.equal(withValue.modelValidated, false);
assert.equal(withValue.realMoneyEligible, false);
assert.deepEqual(withValue.policy, POLICY);
assert.equal(llmWith.length, 1);
const parsed = (inputs) =>
  inputs.map((x) => {
    const { jobId, generatedAt, ...rest } = JSON.parse(x.slice(x.indexOf('\n') + 1));
    return rest;
  });
assert.equal(llmWithout.length, 1);
assert.deepEqual(
  parsed(llmWith),
  parsed(llmWithout),
  'Entrée LLM identique avec ou sans valeur de marché',
);
assert(!llmWith[0].includes(SENTINEL), 'La sentinelle n’atteint pas le LLM');
assert(!llmWith[0].includes('marketValue') && !llmWith[0].includes('Pinnacle'));
assert(!JSON.stringify(buildLlmInput(withValue)).includes(SENTINEL));
assert.deepEqual(
  withValue.market.checks.map((c) => [c.role, c.matchId, c.reasonCode]),
  [
    ['selection', 7, null],
    ['selection', 8, null],
    ['excluded', 9, null],
  ],
);
close(withValue.market.checks[0].fairOdd, 29 / 14);
assert(withValue.market.checks[1].marketValue < 0, '1,90 sous la cote juste 2,0714');
assert.equal(withValue.market.allSelectionsHaveValue, false);
assert.equal(without.market.allSelectionsHaveValue, false);
assert(without.market.checks.every((c) => c.reasonCode === 'NO_REFERENCE'));
// Repère d'un autre match rangé dans le rapport : refusé, jamais comparé.
const swapped = await propose(universe((id) => pinnacle({ matchId: id === 7 ? 8 : id })));
assert.equal(swapped.market.checks[0].reasonCode, 'OTHER_MATCH');

// Examen d'un coupon : seuls les événements du rapport signé sont comparés ; une
// sélection inconnue (cote et bookmaker inventés par le client) reste null.
const enc = (x) => new TextEncoder().encode(x);
const sealKey = await crypto.subtle.deriveKey(
  {
    name: 'HKDF',
    hash: 'SHA-256',
    salt: enc('footscope/seal/salt/v1'),
    info: enc('footscope-seal-v1'),
  },
  await crypto.subtle.importKey('raw', enc('mock-football-key'), 'HKDF', false, ['deriveKey']),
  { name: 'HMAC', hash: 'SHA-256', length: 256 },
  false,
  ['sign'],
);
const seal = async (r) => {
  const payload = JSON.stringify({ report: r, expires: now + 600000 });
  const mac = await crypto.subtle.sign('HMAC', sealKey, enc(payload));
  return { payload, signature: Buffer.from(mac).toString('hex') };
};
const reviewEnv = { ...env, API_FOOTBALL_KEY: 'mock-football-key' };
const review = async (selections) => {
  llmInputs = [];
  const r = await assistant(
    new Request('https://site/api/assistant/review', {
      method: 'POST',
      body: JSON.stringify({
        tokens: [
          await seal(proposalReport(7, [event(7)], sharpWithSentinel(7))),
          await seal(proposalReport(8, [event(8, { odd: 1.9 })], sharpWithSentinel(8))),
        ],
        selections,
      }),
    }),
    reviewEnv,
    '/api/assistant/review',
  );
  assert.equal(r.status, 200);
  return r.json();
};
const reviewed = await review([
  { matchId: 7, market: 'Match Winner', selection: 'Home', bookmaker: 'Bet365', odd: 50 },
  { matchId: 8, market: 'Match Winner', selection: 'Draw', bookmaker: 'Bet365', odd: 50 },
]);
assert.deepEqual(
  reviewed.market.checks.map((c) => [c.role, c.matchId, c.reasonCode, c.odd]),
  [
    ['review', 7, null, 2.1],
    ['review', 8, 'EVENT_MISSING', null],
  ],
);
assert.equal(reviewed.market.allSelectionsHaveValue, false);
assert.equal(reviewed.verdict, 'insufficient');
assert(!llmInputs.join('').includes(SENTINEL));
const reviewedOk = await review([
  { matchId: 7, market: 'Match Winner', selection: 'Home', bookmaker: 'Bet365' },
]);
assert.equal(reviewedOk.market.allSelectionsHaveValue, true);
assert.equal(reviewedOk.verdict, 'simulation_eligible');

// Égalité exacte des deux cotes : « À la cote juste », jamais une valeur positive.
const equal = marketValue(bet('Match Winner', 'Home', 29 / 14), pinnacle(), now);
assert.equal(equal.hasValue, false);
assert.equal(equal.atFairOdd, true);
assert.equal(home.atFairOdd, false);
assert.equal(below.atFairOdd, false);

// Revue PR #20 — tous les candidats sont comparés, pas seulement les cinq transmis au LLM.
const manyUniverse = (sharp) => [
  ...universe(sharp),
  ...Array.from({ length: 6 }, (_, i) =>
    proposalReport(
      10 + i,
      [event(10 + i, { prudentProbability: 0.3 - i * 0.01 })],
      // Le dernier candidat n'a aucun repère Pinnacle.
      i === 5 ? undefined : sharp(10 + i),
    ),
  ),
];
const many = await propose(manyUniverse(sharpWithSentinel));
const llmMany = llmInputs.slice();
const manyWithout = await propose(manyUniverse(() => undefined));
const llmManyWithout = llmInputs.slice();
assert.equal(many.excludedCandidatesCount, 7);
assert.equal(many.excludedCandidates.length, 5, 'Entrée LLM toujours bornée à cinq candidats');
const excludedChecks = many.market.checks.filter((c) => c.role === 'excluded');
assert.equal(excludedChecks.length, 7, 'Chaque candidat a sa comparaison');
assert.deepEqual(
  excludedChecks.map((c) => c.index),
  [0, 1, 2, 3, 4, 5, 6],
);
assert.deepEqual(
  excludedChecks.map((c) => c.matchId).sort((a, b) => a - b),
  [9, 10, 11, 12, 13, 14, 15],
);
assert.equal(excludedChecks.find((c) => c.matchId === 15).reasonCode, 'NO_REFERENCE');
assert.equal(excludedChecks.find((c) => c.matchId === 14).reasonCode, null);
assert.equal(excludedChecks.find((c) => c.matchId === 14).match, 'Club 14 — Visiteur 14');
assert.deepEqual(strip(many), strip(manyWithout), 'Décisions identiques avec 7 candidats');
assert.deepEqual(parsed(llmMany), parsed(llmManyWithout), 'Entrée LLM inchangée');
assert(!llmMany[0].includes(SENTINEL) && !llmMany[0].includes('marketValue'));
assert(!llmMany[0].includes('Club 15'), 'Le sixième candidat n’atteint pas le LLM');

// Rendu de l'interface (src/web/app.js) sur les réponses réelles de la route.
const { readFile } = await import('node:fs/promises');
const { runInNewContext } = await import('node:vm');
const ui = await readFile(new URL('../src/web/app.js', import.meta.url), 'utf8');
const box = { classList: { remove() {} }, innerHTML: '' };
const ctx = {
  $: (q) => (q === '#assistantResult' ? box : null),
  kickoff: () => '',
  crest: () => '',
};
runInNewContext(
  ui.slice(ui.indexOf('const esc ='), ui.indexOf('const tz =')) +
    ui.slice(ui.indexOf('function verdictLabel('), ui.indexOf('let assistantBusy')),
  ctx,
);
const render = (d) => {
  ctx.showAssistant(d);
  return box.innerHTML;
};
const count = (html, re) => (html.match(re) || []).length;
// Avec ticket : 2 sélections (badge dans le ticket et dans le détail) et 7 candidats.
let html = render(many);
assert.equal(count(html, /class="valuebadge"/g), 2 + 2 + 7);
assert(html.includes('Candidats écartés (7)'));
for (const id of [9, 10, 11, 12, 13, 14, 15]) assert(html.includes('Club ' + id + ' — '), id);
assert(html.includes('Pas de repère Pinnacle'), 'Raison du candidat sans repère');

// Sans ticket : tous les candidats sous le seuil, rendus avec badge ou raison.
const noTicketUniverse = [
  proposalReport(21, [event(21, { prudentProbability: 0.3 })], sharpWithSentinel(21)),
  proposalReport(22, [event(22, { prudentProbability: 0.2, odd: 1.9 })], sharpWithSentinel(22)),
  proposalReport(23, [event(23, { prudentProbability: 0.1 })]),
];
const none = await propose(noTicketUniverse);
assert.equal(none.selections.length, 0);
assert.equal(none.market.allSelectionsHaveValue, null);
html = render(none);
assert(!html.includes('class="picks"'), 'Aucun ticket rendu');
assert.equal(count(html, /class="valuebadge"/g), 3);
assert(html.includes('Candidats écartés (3)'));
assert(html.includes('Valeur face au marché +1,4 %'), 'Badge vert du candidat 21');
assert(html.includes('Sous la cote juste −8,3 %'), 'Badge gris du candidat 22');
assert(html.includes('Valeur face au marché : —'), 'Candidat 23 sans repère');

// Examen : la sélection absente du fournisseur garde son badge « — » et sa raison.
html = render(reviewed);
assert.equal(count(html, /class="valuebadge"/g), 2, 'Un badge par sélection examinée');
assert(html.includes('Valeur face au marché : —'));
assert(html.includes(MARKET_VALUE_REASONS.EVENT_MISSING));
assert(!html.includes('Candidats écartés'));
// Le check manquant n'a repris aucune donnée du client (cote 50 non comparée).
assert.equal(reviewed.market.checks[1].index, 1);
assert.equal(reviewed.market.checks[1].odd, null);
assert.equal(reviewed.market.checks[1].marketName, null);
assert.equal(
  ctx.valueCheck(reviewed.market, 'review', 1, reviewed.reviews[1]).reasonCode,
  'EVENT_MISSING',
);
// Une association incohérente (autre match à la même position) ne rend aucun badge.
assert.equal(ctx.valueCheck(reviewed.market, 'review', 0, { matchId: 99 }), undefined);

// Égalité : libellé « À la cote juste », sans pourcentage.
html = render({
  verdict: 'simulation_eligible',
  selections: [],
  reviews: [{ ...event(7), odd: 29 / 14 }],
  market: { checks: [{ role: 'review', index: 0, ...equal }], allSelectionsHaveValue: false },
});
assert(html.includes('>À la cote juste<'));
assert(!html.includes('Sous la cote juste'));
// Écart non nul trop petit pour une décimale : signé, distinct de l'égalité.
const tiny = marketValue(bet('Match Winner', 'Home', 2.0712), pinnacle(), now);
assert.equal(tiny.atFairOdd, false);
html = render({
  verdict: 'simulation_eligible',
  selections: [],
  reviews: [event(7)],
  market: { checks: [{ role: 'review', index: 0, ...tiny }], allSelectionsHaveValue: false },
});
assert(html.includes('Sous la cote juste\u00a0−&lt;0,1\u00a0%'));
console.log(
  'Passed: valeur face au marché 29/14 (+1,38 %), tous les candidats comparés et rendus (7 > 5, sans repère, sans ticket), badge « — » d’une sélection absente, « À la cote juste », plus/moins et BTTS à 2 issues (1e-9), double chance par 1X2 juste, refus null (absent, périmé, autre match, incomplet, hors bet365, client), ticket/verdicts/LLM inchangés, sentinelle absente.',
);
