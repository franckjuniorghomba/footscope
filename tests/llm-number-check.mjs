// BIS-182 : les chiffres du texte libre du LLM (summary, reasons, risks) doivent venir des
// valeurs calculées par le serveur. Sinon, repli sur le résumé statistique et journal
// sans le texte du LLM. Tout le réseau est simulé : aucun secret ni appel payant.
import assert from 'node:assert/strict';
import { finishEvidence } from '../src/server/jobs.js';
import { assistant } from '../src/server/assistant.js';
import { POLICY } from '../src/server/policy.js';
import { checkLlmNumbers, extractNumbers, llmExplanation } from '../src/server/llm.js';

// Extraction : pourcentages et décimaux en français comme en anglais ; entiers nus ignorés.
const values = (text) => extractNumbers(text).map((n) => n.value);
assert.deepEqual(values('Probabilité de 64,8 %.'), [0.648]);
assert.deepEqual(values('Probability 64.8%.'), [0.648]);
assert.deepEqual(values('soit 64,8 % ou 64,8 %'), [0.648, 0.648]);
assert.deepEqual(values('65 pour cent, 65 percent'), [0.65, 0.65]);
assert.deepEqual(values('cote 1,50 ; probabilité 0,65.'), [1.5, 0.65]);
assert.deepEqual(values('2 sélections, 4 matchs, le 2030-01-01 à 15h, U21, BIS-182'), []);

const input = { ticketProbability: 0.9 * 0.72, minTicketProbability: 0.5 };
const check = (text) => checkLlmNumbers([text], input);
// Arrondis légitimes : une demi-unité du dernier chiffre écrit.
for (const text of ['65 %', '64,8 %', '64.8%', '0,65', '0.648', '50 %', 'seuil 0,5'])
  assert.deepEqual(check(text), { checked: 1, mismatches: 0 }, text);
// Écarts : chiffre inventé, troncature, précision trompeuse, calcul non fourni.
for (const text of ['72 %', '64 %', '64,9 %', '0,64', '35,2 %', '100 %'])
  assert.deepEqual(check(text), { checked: 1, mismatches: 1 }, text);
// Les entiers sans contexte ne sont pas comparés.
assert.deepEqual(check('2 sélections sur 4 matchs'), { checked: 0, mismatches: 0 });
// Un pourcentage ne se justifie que par une probabilité ou un avantage, pas par un identifiant.
assert.deepEqual(checkLlmNumbers(['100 %'], { matchId: 1, ticketProbability: 0.648 }), {
  checked: 1,
  mismatches: 1,
});
assert.deepEqual(
  checkLlmNumbers(['avantage de 10 %', 'cote 1,5'], { prudentEdge: 0.1, odd: 1.5 }),
  { checked: 2, mismatches: 0 },
);
// Les nombres des textes du serveur sont des références (« Over 2.5 », « seuil de 60 % »).
assert.deepEqual(
  checkLlmNumbers(['Plus de 2,5 buts, seuil de 60 %.'], {
    selections: [{ selection: 'Over 2.5' }],
    noTicketReason: 'Sous le seuil de 60 %.',
  }),
  { checked: 2, mismatches: 0 },
);

// Intégration : route /api/assistant/propose avec un LLM simulé.
const now = Date.parse('2030-01-01T12:00:00Z');
Date.now = () => now;
const timestamp = (offset = 0) => new Date(now + offset).toISOString();
const event = (matchId, prudentProbability) => ({
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
});
const report = (matchId, events) => ({
  matchId,
  match: 'Club ' + matchId + ' — Visiteur ' + matchId,
  country: 'France',
  league: 'Ligue A',
  kickoff: timestamp(7200000),
  retrievedAt: timestamp(),
  common: [],
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
let llmText;
let llmCalls = 0;
globalThis.fetch = async (url) => {
  assert.equal(url, 'https://api.openai.com/v1/responses', 'Seul le LLM est appelé, et simulé');
  llmCalls++;
  return Response.json({ output: [{ content: [{ type: 'output_text', text: llmText }] }] });
};
const warnings = [];
console.warn = (line) => warnings.push(line);
const env = { BUCKET: bucket, OPENAI_API_KEY: 'mock-key', LLM_MODEL: 'mock-model' };

let jobCount = 0;
async function propose(probabilities, answer) {
  db.clear();
  llmText = JSON.stringify(answer);
  llmCalls = 0;
  warnings.length = 0;
  const reports = probabilities.map((p, i) => report(i + 1, [event(i + 1, p)]));
  const id = '00000000-0000-4000-8000-' + String(++jobCount).padStart(12, '0');
  db.set(
    'jobs/' + id + '/manifest.json',
    JSON.stringify({
      id,
      owner: 'private-site',
      createdAt: timestamp(),
      scope: { date: '2030-01-01', country: '', league: '', search: '' },
      fixtures: reports.map((r) => ({ fixture: { id: r.matchId } })),
      quoteDays: [],
      quoteTotals: {},
      quoteCompleted: [],
      finalChecked: Object.fromEntries(reports.map((r) => [r.matchId, now])),
    }),
  );
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
const ticket = (body) => ({
  selections: body.selections.map((e) => [e.matchId, e.bookmaker, e.selection]),
  ticketProbability: body.ticketProbability,
  minTicketProbability: body.minTicketProbability,
  excludedCandidates: body.excludedCandidates,
  modelValidated: body.modelValidated,
  realMoneyEligible: body.realMoneyEligible,
  verdict: body.verdict,
});

// Arrondi légitime : 0,9 × 0,72 = 64,8 % cité « 65 % » → explication du LLM conservée.
const honest = await propose([0.9, 0.72, 0.72], {
  summary: 'Ticket de 2 sélections à environ 65 % (64,8 %), au-dessus du seuil de 50 %.',
  reasons: ['Sélection à 90 % puis 72 % ; cote 1,50.'],
  risks: ['Ajouter le 3e match ferait 46,7 %, sous le seuil.'],
});
assert.equal(honest.engine, 'llm');
assert.match(honest.summary, /environ 65 %/);
assert.equal(warnings.length, 0);
assert.equal(llmCalls, 1);

// Chiffre inventé : « 72 % » alors que le calcul donne 0,8 × 0,81 = 64,8 % → repli et journal.
const inventedUniverse = [0.8, 0.81, 0.7];
const invented = await propose(inventedUniverse, {
  summary: 'Ce ticket a 72 % de chances de passer.',
  reasons: ['Sélections solides.'],
  risks: [],
});
assert(Math.abs(invented.ticketProbability - 0.648) < 1e-12);
assert.equal(invented.engine, 'statistics');
assert.match(invented.summary, /Probabilité prudente combinée du ticket : 64,8 %/);
assert(!JSON.stringify(invented).includes('72 % de chances'), 'Le texte inventé ne sort pas');
assert(!('model' in invented));
assert.equal(warnings.length, 1);
assert.deepEqual(JSON.parse(warnings[0]), {
  event: 'llm_number_mismatch',
  model: 'mock-model',
  checked: 1,
  mismatches: 1,
});
assert(!warnings[0].includes('chances'), 'Le journal ne contient pas le texte du LLM');
assert(!warnings[0].includes('mock-key'), 'Le journal ne contient aucun secret');

// Un chiffre inventé dans reasons ou risks suffit au repli.
const inRisks = await propose(inventedUniverse, {
  summary: 'Ticket au-dessus du seuil.',
  reasons: ['Deux sélections.'],
  risks: ['Probabilité réelle 0,81 au plus.', 'Échec possible dans 40 % des cas.'],
});
assert.equal(inRisks.engine, 'statistics');
assert.equal(JSON.parse(warnings[0]).mismatches, 1, '0,81 existe, 40 % non');

// Aucun changement du ticket, du seuil ni des drapeaux : seule l'explication diffère.
const accepted = await propose(inventedUniverse, {
  summary: 'Ticket à 64,8 %, seuil de 50 %.',
  reasons: [],
  risks: [],
});
assert.equal(accepted.engine, 'llm');
assert.deepEqual(ticket(invented), ticket(accepted));
for (const body of [honest, invented, accepted]) {
  assert.equal(body.minTicketProbability, POLICY.minTicketProbability);
  assert.equal(body.modelValidated, false);
  assert.equal(body.realMoneyEligible, false);
}

// Le repli n'est pas mis en cache : la même entrée rappelle le LLM, une réponse juste l'est.
const result = { verdict: 'simulation_eligible', selections: [], ticketProbability: 0.648 };
result.minTicketProbability = 0.5;
llmText = JSON.stringify({ summary: 'Ticket à 72 %.', reasons: [], risks: [] });
llmCalls = 0;
assert.equal((await llmExplanation(env, result)).engine, 'statistics');
assert.equal((await llmExplanation(env, result)).engine, 'statistics');
assert.equal(llmCalls, 2);
llmText = JSON.stringify({ summary: 'Ticket à 65 %.', reasons: [], risks: [] });
assert.equal((await llmExplanation(env, result)).engine, 'llm');
assert.equal((await llmExplanation(env, result)).engine, 'llm');
assert.equal(llmCalls, 3);

console.log('LLM number check tests passed');
