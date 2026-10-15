// Intégration BIS-176 : la route /api/assistant/propose transmet les métadonnées du ticket
// (probabilités combinées, motif d'absence) dans la réponse API et dans l'entrée du LLM.
// Tout le réseau est simulé : aucun secret ni appel payant.
import assert from 'node:assert/strict';
import { finishEvidence } from '../src/server/jobs.js';
import { EVIDENCE_LIMITS } from '../src/server/evidence.js';
import { assistant } from '../src/server/assistant.js';
import { BELOW_THRESHOLD_REASON, NO_CANDIDATE_REASON } from '../src/server/coupon.js';
import { POLICY, MODEL_VERSION } from '../src/server/policy.js';
import { buildLlmInput, LLM_INSTRUCTIONS } from '../src/server/llm.js';

const now = Date.parse('2030-01-01T12:00:00Z');
Date.now = () => now;
const timestamp = (offset = 0) => new Date(now + offset).toISOString();
const close = (a, b) => Math.abs(a - b) < 1e-12;
const event = (matchId, prudentProbability, extra = {}) => ({
  matchId,
  bookmaker: 'Book',
  market: 'Goals Over/Under',
  selection: 'Over 0.5',
  prudentProbability,
  probability: Math.min(1, prudentProbability + 0.05),
  prudentEdge: 0.1,
  odd: 1.5,
  status: 'simulation_eligible',
  kickoff: timestamp(7200000),
  updated: timestamp(),
  reasons: [],
  modelValidated: false,
  realMoneyEligible: false,
  ...extra,
});
const report = (matchId, events) => ({
  matchId,
  match: 'Club ' + matchId + ' — Visiteur ' + matchId,
  country: 'France',
  league: 'Ligue A',
  kickoff: timestamp(7200000),
  retrievedAt: timestamp(),
  common: events.length ? [] : ['Aucune cote exploitable.'],
  events,
});

const db = new Map();
const bucket = {
  get: async (k) => (db.has(k) ? { json: async () => JSON.parse(db.get(k)) } : null),
  put: async (k, v) => {
    db.set(k, v);
    return {};
  },
};
let llmCalls = [];
globalThis.fetch = async (url, options) => {
  assert.equal(url, 'https://api.openai.com/v1/responses', 'Seul le LLM est appelé, et simulé');
  const body = JSON.parse(options.body);
  llmCalls.push(JSON.parse(body.input.slice(body.input.indexOf('\n') + 1)));
  // Le LLM tente de modifier le ticket : le serveur doit l'ignorer.
  const text = JSON.stringify({
    summary: 'Explication simulée',
    selections: [{ matchId: 999 }],
    ticketProbability: 1,
    combinedProbability: 1,
    modelVersion: 'invented',
    modelValidated: true,
    realMoneyEligible: true,
    noTicketReason: null,
    reasons: [],
    risks: [],
  });
  return Response.json({ output: [{ content: [{ type: 'output_text', text }] }] });
};
const llmEnv = { BUCKET: bucket, OPENAI_API_KEY: 'mock-key', LLM_MODEL: 'mock-model' };
const owner = 'private-site';

// Prépare un univers complet (manifeste + rapports) puis appelle la route de proposition.
let jobCount = 0;
async function propose(reports, env = llmEnv, headers = {}) {
  db.clear();
  llmCalls = [];
  const id = '00000000-0000-4000-8000-' + String(++jobCount).padStart(12, '0');
  const job = {
    id,
    owner,
    createdAt: timestamp(),
    scope: { date: '2030-01-01', country: '', league: '', search: '' },
    fixtures: reports.map((r) => ({ fixture: { id: r.matchId } })),
    quoteDays: [],
    quoteTotals: {},
    quoteCompleted: [],
    finalChecked: Object.fromEntries(reports.map((r) => [r.matchId, now])),
  };
  db.set('jobs/' + id + '/manifest.json', JSON.stringify(job));
  for (const r of reports) {
    const snapshotId = String(r.matchId).padStart(64, '0');
    const prefix = 'jobs/' + id + '/evidence/';
    db.set(prefix + 'original/' + r.matchId + '.json', JSON.stringify({ snapshotId }));
    db.set(
      prefix + 'snapshots/' + snapshotId + '.json',
      JSON.stringify({
        report: r,
        policy: POLICY,
        evaluatedAt: timestamp(),
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
    headers,
    body: JSON.stringify({ jobId: id }),
  });
  const response = await assistant(req, env, '/api/assistant/propose');
  return finishEvidence(req, env, response);
}
async function proposed(reports, env) {
  const response = await propose(reports, env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.modelValidated, false);
  assert.equal(body.realMoneyEligible, false);
  assert.equal(body.minTicketProbability, POLICY.minTicketProbability);
  return body;
}
const universe = (probabilities) => probabilities.map((p, i) => report(i + 1, [event(i + 1, p)]));
const fields = ['ticketProbability', 'ticketProbabilityExploratory', 'noTicketReason'];

// Cas nominal (critère de l'issue) : 0,90 / 0,72 ×4 → {0,90 ; 0,72} = 0,648.
const strong = await proposed(universe([0.9, 0.72, 0.72, 0.72, 0.72]));
assert.equal(strong.verdict, 'simulation_eligible');
assert.deepEqual(
  strong.selections.map((e) => e.matchId),
  [1, 2],
);
assert(close(strong.ticketProbability, 0.9 * 0.72));
assert(close(strong.ticketProbabilityExploratory, 0.95 * 0.77));
assert.equal(strong.noTicketReason, null);
assert.equal(strong.engine, 'llm');
assert.equal(strong.summary, 'Explication simulée');
// Le LLM ne modifie ni le ticket ni ses probabilités.
assert(!strong.selections.some((e) => e.matchId === 999));
assert(close(strong.ticketProbability, 0.648));
// Entrée du LLM : mêmes métadonnées que la réponse API.
assert.equal(llmCalls.length, 1);
const strongInput = llmCalls[0];
for (const f of fields) assert.equal(strongInput[f], strong[f], 'Entrée LLM : ' + f);
assert.equal(strongInput.minTicketProbability, POLICY.minTicketProbability);
assert.deepEqual(
  strongInput.selections.map((e) => e.matchId),
  [1, 2],
);
assert.equal(strongInput.modelValidated, false);
assert.equal(strongInput.ticketProbability, strongInput.combinedProbability);
assert.equal(strongInput.modelVersion, MODEL_VERSION);
assert.deepEqual(
  strongInput.excludedCandidates.map((e) => e.matchId),
  [3, 4, 5],
);
for (const e of strongInput.excludedCandidates) {
  assert.equal(e.prudentProbability, 0.72);
  assert.equal(e.probability, 0.77);
  assert(close(e.ticketProbabilityIfAdded, 0.648 * 0.72));
  assert(e.ticketProbabilityIfAdded < 0.5);
  assert.equal(e.reason, 'TICKET_PROBABILITY_BELOW_THRESHOLD');
}
assert.match(LLM_INSTRUCTIONS, /minTicketProbability reçu dans les données/);
assert(!LLM_INSTRUCTIONS.includes('0,5'));
assert.match(LLM_INSTRUCTIONS, /sans ticket, elle est la probabilité seule du candidat/);
assert(!LLM_INSTRUCTIONS.includes('Au plus quatre sélections, pas de coupon obligatoire.'));
assert.match(LLM_INSTRUCTIONS, /n’invente aucun chiffre/);
// La réponse enregistrée porte les mêmes valeurs que la réponse API.
const saved = [...db.entries()].find(([k]) => k.startsWith('observations/'));
assert(saved, 'Proposition enregistrée');
for (const f of fields) assert.equal(JSON.parse(saved[1])[f], strong[f]);
const recorded = JSON.parse(saved[1]);
assert.equal(recorded.combinedProbability, strong.ticketProbability);
assert.equal(recorded.modelVersion, MODEL_VERSION);
assert.equal(recorded.modelValidated, false);
assert.equal(recorded.realMoneyEligible, false);
assert.deepEqual(recorded.excludedCandidates, strongInput.excludedCandidates);

// Le repère sans marge est descriptif : seuls les noms de marchés peuvent passer.
const projected = buildLlmInput({
  ...strong,
  market: { probability: 0.999, sentinel: 'descriptive-only' },
  reports: [{ market: { sentinel: 'descriptive-only' } }],
  reviews: [{ matchId: 9, market: { sentinel: 'descriptive-only' } }],
});
assert(!JSON.stringify(projected).includes('descriptive-only'));
assert.equal(projected.selections[0].market, 'Goals Over/Under');
assert(!('engine' in projected));

// Sans clé, le ticket garde sa probabilité et un résumé chiffré prudent.
const fallback = await proposed(universe([0.9, 0.72, 0.72]), { BUCKET: bucket });
assert.equal(fallback.engine, 'statistics');
assert.match(fallback.summary, /Probabilité prudente combinée.*64,8 %.*50 %/);
assert.match(fallback.summary, /non validé/);
assert.equal(llmCalls.length, 0);

// Ne pas présenter un autre bookmaker, un autre événement du même match,
// une preuve périmée ou un événement refusé comme un ajout possible.
const excludedScope = await proposed([
  report(1, [event(1, 0.9), event(1, 0.8)]),
  report(2, [event(2, 0.72)]),
  report(3, [event(3, 0.72), event(3, 0.6)]),
  report(4, [event(4, 0.7, { bookmaker: 'Other' })]),
  report(5, [event(5, 0.7, { status: 'reject' })]),
  { ...report(6, [event(6, 0.7)]), retrievedAt: timestamp(-16 * 60000) },
  report(7, [event(7, 0.7, { updated: timestamp(-POLICY.maxOddsAgeMs - 1) })]),
  report(8, [event(8, 0.7, { updated: timestamp(300001) })]),
  report(9, [event(9, NaN)]),
]);
assert.deepEqual(
  excludedScope.excludedCandidates.map((e) => e.matchId),
  [3],
);

// BIS-217 : la route accepte 23 h 59 et conserve updated pour tous les candidats.
const aged = await proposed([
  report(1, [event(1, 0.9, { updated: timestamp(-1439 * 60000) })]),
  report(2, [event(2, 0.72, { updated: timestamp(-1439 * 60000) })]),
  report(3, [event(3, 0.72, { updated: timestamp(-1439 * 60000) })]),
  report(4, [event(4, 0.7, { updated: timestamp(-1441 * 60000) })]),
]);
assert.deepEqual(
  aged.selections.map((e) => e.matchId),
  [1, 2],
);
assert.deepEqual(
  aged.excludedCandidates.map((e) => e.matchId),
  [3],
);
assert(aged.market.checks.every((c) => c.updated === timestamp(-1439 * 60000)));
assert.equal(aged.realMoneyEligible, false);

// Produit exactement au seuil : 1 × 0,8 × 0,625 = 0,5, accepté.
const exact = await proposed(universe([1, 0.8, 0.625]));
assert.equal(exact.selections.length, 3);
assert.equal(exact.ticketProbability, 0.5);
assert.equal(llmCalls[0].ticketProbability, 0.5);

// Aucune sélection n'atteint 0,5 : pas de ticket, motif du seuil dans la réponse et pour le LLM.
const weak = await proposed(universe([0.49, 0.45]));
assert.equal(weak.verdict, 'insufficient');
assert.deepEqual(weak.selections, []);
assert.equal(weak.ticketProbability, null);
assert.equal(weak.ticketProbabilityExploratory, null);
assert.equal(weak.noTicketReason, BELOW_THRESHOLD_REASON);
assert.equal(weak.combinedOdds, null);
assert.equal(llmCalls.length, 1, 'Le LLM explique pourquoi aucun ticket');
assert.equal(llmCalls[0].noTicketReason, BELOW_THRESHOLD_REASON);
assert.equal(llmCalls[0].ticketProbability, null);
assert.deepEqual(llmCalls[0].selections, []);
assert.deepEqual(weak.selections, [], 'Le LLM ne crée pas de ticket');
assert.deepEqual(
  weak.excludedCandidates.map((e) => e.prudentProbability),
  [0.49, 0.45],
);

// Juste sous le seuil, sans LLM configuré : le résumé est le motif du seuil, pas un message générique.
const noLlm = await proposed(universe([0.4999999]), { BUCKET: bucket });
assert.equal(noLlm.engine, 'statistics');
assert.equal(noLlm.noTicketReason, BELOW_THRESHOLD_REASON);
assert.equal(noLlm.summary, BELOW_THRESHOLD_REASON);
assert.equal(llmCalls.length, 0);

// LLM en erreur : le motif du seuil reste le résumé.
const failingFetch = globalThis.fetch;
globalThis.fetch = async () => Response.json({ error: { code: 'server_error' } }, { status: 500 });
const llmDown = await proposed(universe([0.3]));
assert.equal(llmDown.engine, 'statistics');
assert.equal(llmDown.summary, BELOW_THRESHOLD_REASON);
globalThis.fetch = failingFetch;

// Un échec HTTP, une réponse illisible ou un timeout gardent la probabilité dans le repli.
for (const fetchFailure of [
  async () => Response.json({ error: { code: 'server_error' } }, { status: 500 }),
  async () => Response.json({ output: [{ content: [{ type: 'output_text', text: 'invalid' }] }] }),
  async () => {
    throw Error('Simulated timeout');
  },
]) {
  globalThis.fetch = fetchFailure;
  const down = await proposed(universe([0.9, 0.72]));
  assert.equal(down.engine, 'statistics');
  assert.match(down.summary, /64,8 %/);
  assert.equal(down.ticketProbability, 0.648);
}
globalThis.fetch = failingFetch;

// Aucun événement admissible : motif « aucun candidat », sans appel au LLM.
const empty = await proposed([report(1, [])]);
assert.deepEqual(empty.selections, []);
assert.equal(empty.noTicketReason, NO_CANDIDATE_REASON);
assert.equal(empty.summary, NO_CANDIDATE_REASON);
assert.equal(empty.ticketProbability, null);
assert.equal(llmCalls.length, 0);

// Égalités : à probabilités et marges égales, l'ordre d'entrée décide, de façon stable.
const ties = await proposed(universe([0.85, 0.85, 0.85, 0.85, 0.85]));
assert.deepEqual(
  ties.selections.map((e) => e.matchId),
  [1, 2, 3, 4],
);
const capped = await proposed(universe([0.99, 0.99, 0.99, 0.99, 0.99]));
assert.equal(capped.selections.length, 4);
assert.deepEqual(capped.excludedCandidates, [], 'Le plafond seul ne devient pas un refus de seuil');
assert(close(ties.ticketProbability, 0.85 ** 4));
assert.deepEqual(
  (await proposed(universe([0.85, 0.85, 0.85, 0.85, 0.85]))).selections.map((e) => e.matchId),
  [1, 2, 3, 4],
  'Même entrée, même ticket',
);

// Grand univers : exclusions bornées, preuves exhaustives, plafonds UTF-8.
const books = ['Book', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8'];
for (const withTicket of [true, false]) {
  const reports = Array.from({ length: 200 }, (_, i) =>
    report(
      i + 1,
      books.map((bookmaker) => event(i + 1, withTicket && i === 0 ? 0.9 : 0.45, { bookmaker })),
    ),
  );
  const body = await proposed(reports);
  assert.equal(body.analyzed, 200);
  assert.equal(body.coverageComplete, true);
  assert.equal(body.selections.length, withTicket ? 1 : 0);
  assert.equal(llmCalls.length, 1);
  const input = llmCalls[0];
  assert.equal(input.excludedCandidates.length, 5);
  assert.equal(input.excludedCandidatesCount, withTicket ? 199 : 1600);
  assert.deepEqual(input.excludedCandidates, body.excludedCandidates);
  assert(Buffer.byteLength(JSON.stringify(input)) < 8 * 1024);
  assert.deepEqual(
    input.excludedCandidates.map((e) => [e.matchId, e.bookmaker]),
    withTicket ? [2, 3, 4, 5, 6].map((id) => [id, 'Book']) : books.slice(1, 6).map((b) => [1, b]),
  );
  for (const e of input.excludedCandidates)
    assert(close(e.ticketProbabilityIfAdded, (withTicket ? 0.9 : 1) * e.prudentProbability));
  assert.equal(body.evidence.status, 'complete');
  const metadata = [...db.entries()].find(([k]) => k.endsWith('/ticket.json'));
  const pages = [...db.entries()].filter(([k]) => k.includes('/pages/'));
  assert(metadata);
  assert(Buffer.byteLength(metadata[1]) <= EVIDENCE_LIMITS.metadataBytes);
  assert.deepEqual(JSON.parse(metadata[1]).llm.input, input);
  const decisions = pages.flatMap(([, value]) => JSON.parse(value));
  assert.equal(decisions.length, 200);
  assert.equal(new Set(decisions.map((d) => d.matchId)).size, 200);
  assert.equal(
    decisions.reduce((n, d) => n + d.events.length, 0),
    1600,
  );
  assert(
    Buffer.byteLength(metadata[1]) +
      pages.reduce((n, [, v]) => n + Buffer.byteLength(v), 0) +
      1024 <=
      EVIDENCE_LIMITS.proposalBytes,
  );
  console.log(
    JSON.stringify({
      withTicket,
      exclusions: body.excludedCandidates.length,
      count: body.excludedCandidatesCount,
      inputBytes: Buffer.byteLength(JSON.stringify(llmCalls[0])),
      evidence: body.evidence,
      metadataBytes: metadata ? Buffer.byteLength(metadata[1]) : null,
      dossierBytes: metadata
        ? Buffer.byteLength(metadata[1]) + pages.reduce((n, [, v]) => n + Buffer.byteLength(v), 0)
        : null,
    }),
  );
}

// Le classement privilégie la probabilité, puis l’identité ; aucun effet de collecte.
const rankedReports = universe([0.3, 0.48, 0.45, 0.48, 0.4, 0.47, 0.46]);
const ranked = await proposed(rankedReports);
assert.equal(ranked.excludedCandidatesCount, 7);
assert.deepEqual(
  ranked.excludedCandidates.map((e) => e.matchId),
  [2, 4, 6, 7, 3],
);
const reversed = await proposed([...rankedReports].reverse());
assert.deepEqual(reversed.excludedCandidates, ranked.excludedCandidates);
assert.equal(reversed.excludedCandidatesCount, 7);

// Revue d'un ticket existant : pas de composition, donc pas de métadonnées de ticket.
db.clear();
const reviewed = await (
  await assistant(
    new Request('https://site/api/assistant/review', {
      method: 'POST',
      body: JSON.stringify({ tokens: [], selections: [{ matchId: 1 }] }),
    }),
    llmEnv,
    '/api/assistant/review',
  )
).json();
for (const f of fields) assert.equal(reviewed[f], null, 'Revue : ' + f);

// Refus : origine étrangère, analyse d'un autre utilisateur, jetons signés absents.
const foreign = await propose(universe([0.9]), llmEnv, { origin: 'https://evil.test' });
assert.equal(foreign.status, 403);
await assert.rejects(
  propose(universe([0.9]), llmEnv, { 'oai-authenticated-user-id': 'someone-else' }),
  /Accès à cette analyse refusé/,
);
const unsigned = await assistant(
  new Request('https://site/api/assistant/propose', {
    method: 'POST',
    body: JSON.stringify({ tokens: 'x' }),
  }),
  llmEnv,
  '/api/assistant/propose',
);
assert.equal(unsigned.status, 400);
assert.equal(llmCalls.length, 0, 'Aucun appel LLM pour une demande refusée');

console.log(
  'Passed: ticket API metadata (0.648, exact 0.5, below-threshold reason, no candidate, ties) in API response and LLM input; refusals.',
);
