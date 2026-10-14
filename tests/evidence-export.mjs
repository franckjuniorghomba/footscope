import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BELOW_THRESHOLD_REASON } from '../src/server/coupon.js';
import {
  EVIDENCE_LIMITS,
  boundedEvidence,
  redactEvidence,
  ticketDecision,
} from '../src/server/evidence.js';

const source = fs
  .readFileSync('dist/server/index.js', 'utf8')
  .replace(/(?:var|const) API_SPACING_MS\s*=\s*6500\s*;/, 'var API_SPACING_MS = 0;');
const mod = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const worker = mod.default;
const now = Date.now(),
  kickoff = now + 5 * 3600000;
const date = mod.fixedDay(new Date(kickoff).toISOString());
const db = new Map();
let reads = 0,
  writes = 0,
  calls = 0,
  llmRequest;
const env = {
  API_FOOTBALL_KEY: 'football-secret-sentinel',
  OPENAI_API_KEY: 'openai-secret-sentinel',
  LLM_MODEL: 'fixture-model',
  API_RELAY_TOKEN: 'relay-secret-sentinel',
  BUCKET: {
    get: async (key) => {
      reads++;
      return db.has(key) ? { json: async () => JSON.parse(db.get(key)) } : null;
    },
    put: async (key, value, options) => {
      writes++;
      if (options?.onlyIf?.get?.('If-None-Match') === '*' && db.has(key)) return null;
      db.set(key, value);
      return {};
    },
  },
};
const game = (id) => ({
  fixture: {
    id,
    timestamp: Math.floor(kickoff / 1000),
    date: new Date(kickoff).toISOString(),
    status: { short: 'NS' },
  },
  league: { country: 'France', name: 'Test' },
  teams: {
    home: { id: id * 2 + 1000, name: 'Home ' + id },
    away: { id: id * 2 + 1001, name: 'Away ' + id },
  },
  goals: { home: null, away: null },
});
const refusals = Array.from({ length: 21 }, (_, i) => game(i + 1));
// Une donnée inattendue ne doit pas devenir une identité ou un secret exporté.
refusals[0].teams.home.name +=
  ' API_FOOTBALL_KEY ' +
  env.API_FOOTBALL_KEY +
  ' OPENAI_API_KEY ' +
  env.OPENAI_API_KEY +
  ' API_RELAY_TOKEN ' +
  env.API_RELAY_TOKEN;
refusals[0].fixture.identity = 'private-person-sentinel';
let fixtures = refusals;
const odds = (id) => ({
  fixture: { id },
  update: new Date(id === 4 ? now - 3600000 : now).toISOString(),
  bookmakers: [
    {
      name: id === 106 ? 'Book B' : 'Book A',
      bets:
        id === 5
          ? [{ name: 'Corners Over Under', values: [{ value: 'Over 8.5', odd: '2' }] }]
          : [
              {
                name: 'Goals Over/Under',
                values:
                  id >= 100
                    ? [
                        { value: 'Over 0.5', odd: '1.8' },
                        { value: 'Under 9.5', odd: '1.8' },
                        { value: 'Over 10.5', odd: '1.8' },
                        { value: 'Over 2', odd: '2' },
                        { value: 'Under 0.5', odd: '0.9' },
                      ]
                    : [{ value: 'Over 0.5', odd: '1.01' }],
              },
              { name: 'Corners Over Under', values: [{ value: 'Over 8.5', odd: '2' }] },
            ],
    },
  ],
});
globalThis.fetch = async (url, options) => {
  calls++;
  if (url.includes('api.openai.com')) {
    llmRequest = JSON.parse(options.body);
    return Response.json({
      output: [
        {
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({ summary: 'Simulation', reasons: [], risks: ['LLM risk'] }),
            },
          ],
        },
      ],
    });
  }
  const u = new URL(url);
  let response = [];
  if (u.pathname.endsWith('/fixtures')) {
    if (u.searchParams.has('date')) response = u.searchParams.get('date') === date ? fixtures : [];
    else if (u.searchParams.has('id'))
      response = fixtures.filter((f) => f.fixture.id === Number(u.searchParams.get('id')));
    else if (u.searchParams.has('team')) {
      const teamId = Number(u.searchParams.get('team'));
      if (teamId === refusals[1].teams.home.id)
        return Response.json({
          errors: {
            source:
              'unavailable API_FOOTBALL_KEY ' +
              env.API_FOOTBALL_KEY +
              ' OPENAI_API_KEY ' +
              env.OPENAI_API_KEY,
          },
          response: [],
        });
      response = Array.from({ length: 10 }, (_, i) => ({
        ...game(9000 + i),
        fixture: {
          id: 9000 + i,
          timestamp: Math.floor((now - (i + 1) * 86400000) / 1000),
          status: { short: 'FT' },
        },
        teams: { home: { id: teamId, name: 'Team' }, away: { id: 900, name: 'Opponent' } },
        goals: { home: 2, away: 1 },
      }));
    }
  } else if (u.pathname.endsWith('/odds')) {
    response = u.searchParams.has('fixture')
      ? [odds(Number(u.searchParams.get('fixture')))]
      : u.searchParams.get('date') === date
        ? fixtures.filter((f) => f.fixture.id !== 3).map((f) => odds(f.fixture.id))
        : [];
    if (Number(u.searchParams.get('fixture')) >= 200) response = [];
  } else if (u.pathname.endsWith('/injuries')) {
    response = [{ player: { name: 'private-person-sentinel', reason: env.OPENAI_API_KEY } }];
  } else if (u.pathname.endsWith('/lineups')) {
    response = [{ startXI: [{ player: { name: 'private-person-sentinel' } }] }];
  }
  return Response.json({ response, errors: {}, paging: { total: 1 } });
};
const post = async (action, body, user = 'owner-sentinel') =>
  worker.fetch(
    new Request('https://site/api/assistant/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'oai-authenticated-user-id': user },
      body: JSON.stringify(body),
    }),
    env,
  );
const get = async (query, user = 'owner-sentinel', extraEnv = env) =>
  worker.fetch(
    new Request('https://site/api/assistant/evidence?' + query, {
      headers: user === null ? {} : { 'oai-authenticated-user-id': user },
    }),
    extraEnv,
  );
const successful = async (response) => {
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};
const collect = async () => {
  const prepared = await successful(await post('prepare', { date }));
  for (const day of prepared.quoteDays)
    await successful(await post('quotes', { jobId: prepared.jobId, day, page: 1 }));
  for (const matchId of prepared.ids)
    await successful(await post('scan', { jobId: prepared.jobId, matchId }));
  return prepared;
};
const prepared = await collect();
assert.equal((await get('jobId=' + prepared.jobId)).status, 404, 'No dossier before proposal');
const final = await successful(await post('propose', { jobId: prepared.jobId }));
assert.equal(final.selections.length, 0);
assert(final.evidence.proposalId);
const countBeforeExport = calls,
  writesBeforeExport = writes;
const dossier = await successful(await get('jobId=' + prepared.jobId));
assert.equal(dossier.decisions.length, 21);
assert.deepEqual(
  dossier.decisions.map((d) => d.matchId),
  prepared.ids,
);
assert.equal(dossier.decisions[1].state, 'source_unavailable');
assert(dossier.decisions[1].reasons.some((r) => r.code === 'SOURCE_UNAVAILABLE'));
assert(dossier.decisions[1].quoteSummary.length > 0);
assert(dossier.decisions[0].events[0].reasons.some((r) => r.code === 'EDGE_BELOW_POLICY'));
assert.equal(dossier.decisions[2].reasons[0].code, 'NO_ODDS_AFTER_COMPLETE_COVERAGE');
assert.equal(dossier.decisions[3].reasons[0].code, 'NO_SUPPORTED_FRESH_QUOTES');
assert(dossier.decisions[4].quoteSummary.some((q) => q.code === 'MARKET_NOT_SUPPORTED'));
assert.equal(dossier.llm.requested, false);
assert.equal(dossier.llm.input, null);
const serialized = JSON.stringify(dossier);
for (const secret of [
  'API_FOOTBALL_KEY',
  'OPENAI_API_KEY',
  'API_RELAY_TOKEN',
  env.API_RELAY_TOKEN,
  env.API_FOOTBALL_KEY,
  env.OPENAI_API_KEY,
  'owner-sentinel',
  'private-person-sentinel',
])
  assert(!serialized.includes(secret), 'Export leaked ' + secret.replace(/secret.*/, '[sentinel]'));
assert(dossier.decisions.every((d) => !('snapshot' in d) && !('original' in d)));
assert.deepEqual(dossier.snapshots, []);
const withSnapshot = await successful(
  await get('jobId=' + prepared.jobId + '&limit=1&includeSnapshots=current'),
);
const snapshot = withSnapshot.snapshots[0];
assert.equal(snapshot.snapshotId, dossier.decisions[0].snapshotId);
for (const secret of [
  'API_RELAY_TOKEN',
  env.API_RELAY_TOKEN,
  'API_FOOTBALL_KEY',
  env.API_FOOTBALL_KEY,
  'OPENAI_API_KEY',
  env.OPENAI_API_KEY,
])
  assert(!JSON.stringify(withSnapshot).includes(secret));
const replay = mod.assessMatch(snapshot.inputs, Date.parse(snapshot.evaluatedAt));
assert.deepEqual(replay.model, snapshot.report.model);
assert.deepEqual(
  replay.events.filter((e) => e.probability !== null),
  snapshot.report.events,
  'Every model output reproduced offline',
);
assert(snapshot.sources.home.retrievedAt);
assert(snapshot.sources.away.retrievedAt);
assert(snapshot.sources.odds.records[0].retrievedAt);
assert.equal(
  snapshot.sources.fixture.retrievedAt,
  null,
  'Do not fabricate missing provider timestamps',
);
assert.equal(snapshot.modelParameters.scoreTerms, 30);
for (const query of [
  'jobId=../other',
  'jobId=' + prepared.jobId + '&includeSnapshots=both',
  'jobId=' + prepared.jobId + '&includeSnapshots=current&includeSnapshots=original',
  'jobId=' + prepared.jobId + '&snapshotId=' + dossier.decisions[0].snapshotId,
  'jobId=' + prepared.jobId + '&limit=101',
  'jobId=' + prepared.jobId + '&limit=0',
  'jobId=' + prepared.jobId + '&offset=-1',
  'jobId=' + prepared.jobId + '&limit=1&limit=2',
  'jobId=' + prepared.jobId + '&proposalId=bad',
  'jobId=' + prepared.jobId + '&owner=owner-sentinel',
]) {
  const response = await get(query);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'INVALID_EVIDENCE_QUERY');
}
let beforeReads = reads;
assert.equal((await get('jobId=' + prepared.jobId, null)).status, 401);
assert.equal((await get('jobId=' + prepared.jobId, 'private-site')).status, 401);
assert.equal(reads, beforeReads, 'No storage read without identity');
assert.equal((await get('jobId=' + prepared.jobId, 'other-owner')).status, 404);
beforeReads = reads;
assert.equal(
  (await get('jobId=' + prepared.jobId + '&includeSnapshots=current', 'other-owner')).status,
  404,
);
assert.equal(reads - beforeReads, 1, 'No snapshot or page read for another owner');
assert.equal(
  (await get('jobId=' + prepared.jobId + '&includeSnapshots=original', null)).status,
  401,
);
assert.equal((await get('jobId=' + prepared.jobId, 'owner-sentinel', {})).status, 503);
assert.equal((await post('evidence', { jobId: prepared.jobId })).status, 405);
const pages = [];
for (let offset = 0; offset !== null;) {
  const page = await successful(
    await get('jobId=' + prepared.jobId + '&offset=' + offset + '&limit=7'),
  );
  pages.push(...page.decisions.map((d) => d.matchId));
  offset = page.pagination.nextOffset;
}
assert.deepEqual(pages, prepared.ids);
assert.equal(
  (await successful(await get('jobId=' + prepared.jobId + '&offset=21'))).decisions.length,
  0,
);
assert.equal(
  calls - countBeforeExport,
  0,
  'Opening, pagination and refusals make zero provider or LLM calls',
);
assert.equal(writes, writesBeforeExport, 'Export is read-only');

// Même contrat pour un ticket : quatre sélections, alternatives du même match,
// bookmaker différent et candidats valables exclus par la limite de taille.
fixtures = Array.from({ length: 7 }, (_, i) => game(100 + i));
// On crée le manifeste comme prepare le ferait pour un deuxième périmètre,
// sans réinitialiser les caches partagés du fournisseur.
const jobId = crypto.randomUUID();
db.set(
  'jobs/' + jobId + '/manifest.json',
  JSON.stringify({
    id: jobId,
    owner: 'owner-sentinel',
    scope: { date, country: '', league: '', search: '' },
    fixtures,
    createdAt: new Date().toISOString(),
    quoteMode: 'fixtures',
    quoteDays: fixtures.map((f) => String(f.fixture.id)),
    quoteTotals: {},
    quoteCompleted: [],
  }),
);
const manifest = JSON.parse(db.get('jobs/' + jobId + '/manifest.json'));
for (const day of manifest.quoteDays) await successful(await post('quotes', { jobId, day }));
for (const f of fixtures) await successful(await post('scan', { jobId, matchId: f.fixture.id }));
let proposed;
do {
  proposed = await successful(await post('propose', { jobId }));
  for (const matchId of proposed.needsRecheck || [])
    await successful(await post('scan', { jobId, matchId, recheck: true }));
} while (proposed.needsRecheck?.length);
assert.equal(proposed.selections.length, 4);
const ticketDossier = await successful(await get('jobId=' + jobId));
assert.deepEqual(ticketDossier.ticket.selections, proposed.selections);
assert.equal(ticketDossier.ticket.noTicketReason, proposed.noTicketReason);
assert.equal(
  ticketDossier.ticket.ticketProbabilityExploratory,
  proposed.ticketProbabilityExploratory,
);
assert.equal(ticketDossier.ticket.rules.maxSelections, 4);
assert.equal(ticketDossier.modelValidated, false);
assert.equal(ticketDossier.realMoneyEligible, false);
assert.equal(ticketDossier.llm.requested, true);
assert.equal(ticketDossier.llm.instructions, llmRequest.instructions);
assert.equal(ticketDossier.llm.parameters.store, llmRequest.store);
assert.equal(ticketDossier.llm.parameters.max_output_tokens, llmRequest.max_output_tokens);
assert.deepEqual(ticketDossier.llm.parameters.text, llmRequest.text);
assert.deepEqual(
  ticketDossier.llm.input,
  JSON.parse(llmRequest.input.split('\n').slice(1).join('\n')),
  'Preserved semantic input equals actual OpenAI request',
);
assert(
  ticketDossier.decisions
    .flatMap((d) => d.events)
    .some((e) => e.reasons.some((r) => r.code === 'ONE_SELECTION_PER_MATCH')),
);
assert(
  ticketDossier.decisions
    .flatMap((d) => d.events)
    .some((e) => e.reasons.some((r) => r.code === 'SINGLE_BOOKMAKER')),
);
assert(
  ticketDossier.decisions
    .flatMap((d) => d.events)
    .some((e) => e.reasons.some((r) => r.code === 'MAX_SELECTIONS')),
);
assert(ticketDossier.decisions.some((d) => d.quoteSummary.some((q) => q.code === 'INVALID_ODDS')));
const checked = ticketDossier.decisions.find((d) => d.state === 'included');
assert.notEqual(
  checked.snapshotId,
  checked.originalSnapshotId,
  'Final refresh is a separate snapshot',
);
const originalDossier = await successful(
  await get('jobId=' + jobId + '&includeSnapshots=original'),
);
const originalSnapshot = originalDossier.snapshots.find(
  (s) => s.snapshotId === checked.originalSnapshotId,
);
assert(
  originalSnapshot.inputs.odds.some((r) =>
    r.bookmakers.some((b) => b.bets.some((m) => m.name === 'Corners Over Under')),
  ),
);
const originalBytes = db.get(
  'jobs/' + jobId + '/evidence/snapshots/' + checked.originalSnapshotId + '.json',
);
await successful(await post('scan', { jobId, matchId: checked.matchId, recheck: true }));
assert.equal(
  db.get('jobs/' + jobId + '/evidence/snapshots/' + checked.originalSnapshotId + '.json'),
  originalBytes,
);
// Le seuil est simulé uniquement dans une copie du bundle : ces candidats réels
// de la fixture ne passent plus, sans modifier POLICY ni leurs preuves.
const thresholdSource = source.replace(
  /minTicketProbability:\s*0\.5\b/,
  'minTicketProbability: 0.99',
);
assert.notEqual(thresholdSource, source, 'Simulated threshold was applied');
const thresholdWorker = (
  await import('data:text/javascript;base64,' + Buffer.from(thresholdSource).toString('base64'))
).default;
const thresholdReason = BELOW_THRESHOLD_REASON.replace('50 %', '99 %');
const proposeBelowThreshold = async (configured = true) =>
  successful(
    await thresholdWorker.fetch(
      new Request('https://site/api/assistant/propose', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'oai-authenticated-user-id': 'owner-sentinel',
        },
        body: JSON.stringify({ jobId }),
      }),
      configured ? env : { ...env, OPENAI_API_KEY: undefined },
    ),
  );
llmRequest = null;
const belowThreshold = await proposeBelowThreshold();
assert.deepEqual(belowThreshold.selections, []);
assert.equal(belowThreshold.noTicketReason, thresholdReason);
assert.equal(belowThreshold.engine, 'llm');
assert(llmRequest, 'The LLM explains the below-threshold refusal');
const callsBeforeThresholdExport = calls;
const writesBeforeThresholdExport = writes;
const belowDossier = await successful(
  await get('jobId=' + jobId + '&proposalId=' + belowThreshold.evidence.proposalId),
);
assert.equal(belowDossier.llm.requested, true);
assert.equal(belowDossier.llm.outcome, 'llm');
assert.equal(belowDossier.llm.model, llmRequest.model);
assert.equal(belowDossier.llm.instructions, llmRequest.instructions);
assert.deepEqual(belowDossier.llm.parameters, {
  store: llmRequest.store,
  max_output_tokens: llmRequest.max_output_tokens,
  text: llmRequest.text,
});
assert.deepEqual(
  belowDossier.llm.input,
  JSON.parse(llmRequest.input.split('\n').slice(1).join('\n')),
  'Below-threshold semantic input equals actual OpenAI request',
);
assert.equal(belowDossier.ticket.noTicketReason, thresholdReason);
assert.equal(belowDossier.ticket.ticketProbabilityExploratory, null);
assert.equal(calls, callsBeforeThresholdExport, 'Below-threshold export makes no external calls');
assert.equal(writes, writesBeforeThresholdExport, 'Below-threshold export is read-only');
llmRequest = null;
const belowWithoutLlm = await proposeBelowThreshold(false);
assert.equal(belowWithoutLlm.noTicketReason, thresholdReason);
assert.equal(belowWithoutLlm.engine, 'statistics');
assert.equal(llmRequest, null);
const belowWithoutLlmDossier = await successful(await get('jobId=' + jobId));
assert.equal(belowWithoutLlmDossier.ticket.noTicketReason, thresholdReason);
assert.equal(belowWithoutLlmDossier.ticket.ticketProbabilityExploratory, null);
assert.equal(belowWithoutLlmDossier.llm.requested, false);
for (const field of ['input', 'instructions', 'parameters', 'model'])
  assert.equal(belowWithoutLlmDossier.llm[field], null);

const laterProposal = await successful(await post('propose', { jobId }));
assert.notEqual(laterProposal.evidence.proposalId, proposed.evidence.proposalId);
assert.deepEqual(
  await successful(await get('jobId=' + jobId + '&proposalId=' + proposed.evidence.proposalId)),
  ticketDossier,
  'Earlier ticket remains immutable after a new proposal',
);
// Conservation : l'expiration d'une collecte ne supprime pas son export.
manifest.createdAt = new Date(now - 2 * 86400000).toISOString();
db.set('jobs/' + jobId + '/manifest.json', JSON.stringify(manifest));
beforeReads = reads;
const callsBefore = calls;
const archived = await successful(await get('jobId=' + jobId + '&limit=1'));
assert.equal(archived.decisions.length, 1);
assert(reads - beforeReads <= 6, 'Indexed blob reads bounded by the page size');
assert.equal(calls, callsBefore);
const missingKey =
  'jobs/' + jobId + '/evidence/proposals/' + laterProposal.evidence.proposalId + '/pages/0.json';
db.delete(missingKey);
const broken = await get('jobId=' + jobId + '&limit=1');
assert.equal(broken.status, 409);
assert.equal((await broken.json()).code, 'EVIDENCE_INCOMPLETE');

// Une page HTTP peut chevaucher deux pages physiques sans lire chaque match.
const largeId = crypto.randomUUID();
const largeFixtures = Array.from({ length: 103 }, (_, i) => game(200 + i));
db.set(
  'jobs/' + largeId + '/manifest.json',
  JSON.stringify({
    id: largeId,
    owner: 'owner-sentinel',
    scope: { date, country: '', league: '', search: '' },
    fixtures: largeFixtures,
    createdAt: new Date().toISOString(),
    quoteMode: 'fixtures',
    quoteDays: largeFixtures.map((f) => String(f.fixture.id)),
    quoteTotals: {},
    quoteCompleted: [],
  }),
);
for (const f of largeFixtures)
  await successful(await post('quotes', { jobId: largeId, day: String(f.fixture.id) }));
for (const f of largeFixtures)
  await successful(await post('scan', { jobId: largeId, matchId: f.fixture.id }));
await successful(await post('propose', { jobId: largeId }));
beforeReads = reads;
const largeCalls = calls;
const crossing = await successful(await get('jobId=' + largeId + '&offset=95&limit=8'));
assert.deepEqual(
  crossing.decisions.map((d) => d.matchId),
  largeFixtures.slice(95).map((f) => f.fixture.id),
);
assert.equal(crossing.pagination.total, 103);
assert.equal(crossing.pagination.nextOffset, null);
assert.equal(reads - beforeReads, 7, 'Four small pages plus three metadata reads');
assert.equal(calls, largeCalls);
assert.equal(
  (await successful(await get('jobId=' + largeId + '&limit=100'))).decisions.length,
  100,
);
console.log(
  'Passed: 21/21 retained decisions (zero eligible, refusals and source failure), offline numeric replay, dated sources, secrets/identity absent, owner refusals, bounded read-only pagination, zero export calls, immutable original/recheck/tickets, composition rules and exact semantic LLM input.',
);

// Régression volume : 21 matchs, 6 bookmakers × 25 marchés × 6 valeurs.
const realisticMarkets = ['Match Winner', 'Goals Over/Under', 'Both Teams Score', 'Double Chance'];
const richOdds = (id) => ({
  fixture: { id },
  update: new Date(now).toISOString(),
  bookmakers: Array.from({ length: 6 }, (_, b) => ({
    name: 'Realistic bookmaker ' + b,
    bets: Array.from({ length: 25 }, (_, m) => ({
      name: realisticMarkets[m] || 'Market number ' + m,
      values: Array.from({ length: 6 }, (_, v) => ({
        value: m === 1 ? (v % 2 ? 'Under ' : 'Over ') + (v + 0.5) : 'Value ' + v,
        odd: (1.5 + v / 10).toFixed(2),
      })),
    })),
  })),
});
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const u = new URL(url);
  if (u.pathname.endsWith('/odds') && u.searchParams.has('fixture'))
    return Response.json({
      response: [richOdds(Number(u.searchParams.get('fixture')))],
      errors: {},
      paging: { total: 1 },
    });
  return originalFetch(url, options);
};
const richId = crypto.randomUUID();
fixtures = Array.from({ length: 21 }, (_, i) => game(400 + i));
db.set(
  'jobs/' + richId + '/manifest.json',
  JSON.stringify({
    ...manifest,
    id: richId,
    fixtures,
    createdAt: new Date().toISOString(),
    quoteDays: fixtures.map((f) => String(f.fixture.id)),
    quoteTotals: {},
    quoteCompleted: [],
    finalChecked: {},
  }),
);
for (const f of fixtures)
  await successful(await post('quotes', { jobId: richId, day: String(f.fixture.id) }));
for (const f of fixtures)
  await successful(await post('scan', { jobId: richId, matchId: f.fixture.id }));
let richProposal;
do {
  richProposal = await successful(await post('propose', { jobId: richId }));
  for (const matchId of richProposal.needsRecheck || [])
    await successful(await post('scan', { jobId: richId, matchId, recheck: true }));
} while (richProposal.needsRecheck?.length);
assert.equal(richProposal.evidence.status, 'complete');
const richDossier = await successful(await get('jobId=' + richId));
assert.equal(richDossier.decisions.length, 21);
for (const d of richDossier.decisions) {
  assert(Buffer.byteLength(JSON.stringify(d)) <= 128 * 1024, 'Decision ≤ 128 KiB');
  assert(!('snapshot' in d) && !('original' in d));
  assert.equal(d.events.length, 36, 'Only numeric model events remain individual');
  assert.equal(
    d.quoteSummary.reduce((n, q) => n + q.count, 0),
    864,
    'Every other quote counted',
  );
}
const richPrefix =
  'jobs/' + richId + '/evidence/proposals/' + richProposal.evidence.proposalId + '/';
const richObjects = [...db.entries()].filter(([key]) => key.startsWith(richPrefix));
assert(
  richObjects
    .filter(([key]) => key.includes('/pages/'))
    .every(([, value]) => Buffer.byteLength(value) <= 512 * 1024),
);
assert(richObjects.reduce((n, [, value]) => n + Buffer.byteLength(value), 0) <= 8 * 1024 * 1024);
assert(
  [...db.entries()]
    .filter(([key]) => key.startsWith('jobs/' + richId + '/evidence/snapshots/'))
    .every(([, value]) => Buffer.byteLength(value) <= 512 * 1024),
);
const getCount = reads,
  putCount = writes,
  callCount = calls;
const richWithSnapshot = await successful(
  await get('jobId=' + richId + '&limit=1&includeSnapshots=current'),
);
assert.equal(reads - getCount, 5, 'Three metadata, one page, one snapshot for limit=1');
assert.equal(writes, putCount);
assert.equal(calls, callCount);
assert.equal(richWithSnapshot.snapshots.length, 1);
assert(!('quotes' in richWithSnapshot.snapshots[0]), 'No duplicated inputs.odds / quotes');
assert.equal(
  richWithSnapshot.snapshots[0].inputs.odds.reduce(
    (n, row) =>
      n +
      row.bookmakers.reduce((sum, b) => sum + b.bets.reduce((s, m) => s + m.values.length, 0), 0),
    0,
  ),
  900,
);
const richReplay = mod.assessMatch(
  richWithSnapshot.snapshots[0].inputs,
  Date.parse(richWithSnapshot.snapshots[0].evaluatedAt),
);
assert.deepEqual(
  richReplay.events.filter((e) => e.probability !== null),
  richWithSnapshot.snapshots[0].report.events,
);
const snapshotIds = [];
for (let offset = 0; offset !== null;) {
  const startReads = reads;
  const response = await get(
    'jobId=' + richId + '&offset=' + offset + '&limit=100&includeSnapshots=current',
  );
  const text = await response.text();
  assert.equal(response.status, 200);
  assert(Buffer.byteLength(text) <= 1024 * 1024, 'HTTP page ≤ 1 MiB, even with snapshots');
  const page = JSON.parse(text);
  assert(page.decisions.length > 0);
  assert(reads - startReads <= 3 + Math.ceil(100 / 3) + 1 + 100);
  snapshotIds.push(...page.decisions.map((d) => d.matchId));
  offset = page.pagination.nextOffset;
}
assert.deepEqual(
  snapshotIds,
  fixtures.map((f) => f.fixture.id),
  'Byte pagination never drops a match',
);

// Échecs après observation/LLM : ticket HTTP 200, statut incomplet, journal expurgé.
const logs = [],
  warn = console.warn;
console.warn = (message) => logs.push(message);
const observationCount = () =>
  [...db.keys()].filter((key) => key.startsWith('observations/')).length;
const originalPut = env.BUCKET.put;
for (const suffix of ['/pages/0.json', '/ticket.json', '/latest.json']) {
  const before = observationCount();
  env.BUCKET.put = async (key, value, options) => {
    if (key.includes('/evidence/') && key.endsWith(suffix))
      throw Error(env.API_RELAY_TOKEN + ' private-person-sentinel');
    return originalPut(key, value, options);
  };
  const failed = await successful(await post('propose', { jobId: richId }));
  assert.equal(failed.saved, true);
  assert.equal(failed.selections.length, richProposal.selections.length);
  assert.equal(failed.evidence.status, 'incomplete');
  assert.equal(failed.evidence.code, 'EVIDENCE_STORAGE_FAILED');
  assert.equal(observationCount() - before, 1, 'No second observation from dossier finalization');
  assert.equal(
    JSON.parse(
      db.get(
        'jobs/' + richId + '/evidence/proposals/' + failed.evidence.proposalId + '/status.json',
      ),
    ).status,
    'incomplete',
  );
  assert.equal(
    (await successful(await get('jobId=' + richId))).proposalId,
    richProposal.evidence.proposalId,
    'Failed proposal does not replace latest complete dossier',
  );
}
env.BUCKET.put = async (key, value, options) => {
  if (key.includes('/evidence/proposals/') && key.endsWith('/pages/0.json')) return null;
  return originalPut(key, value, options);
};
const unacknowledgedWrite = await successful(await post('propose', { jobId: richId }));
assert.equal(unacknowledgedWrite.evidence.status, 'incomplete');
assert.equal(unacknowledgedWrite.evidence.code, 'EVIDENCE_STORAGE_FAILED');
env.BUCKET.put = originalPut;
const lostKey =
  'jobs/' + richId + '/evidence/snapshots/' + richDossier.decisions[0].snapshotId + '.json';
const lostSnapshot = db.get(lostKey);
db.delete(lostKey);
const missingSnapshot = await successful(await post('propose', { jobId: richId }));
assert.equal(missingSnapshot.evidence.status, 'incomplete');
assert.equal(missingSnapshot.evidence.code, 'EVIDENCE_INCOMPLETE');
assert.equal((await get('jobId=' + richId + '&includeSnapshots=current&limit=1')).status, 409);
db.set(lostKey, lostSnapshot);
// Plafond de décision exercé par la route, avec un texte UTF-8 multioctet.
const oversized = JSON.parse(lostSnapshot);
oversized.report.events[0].match = 'é'.repeat(80000);
db.set(lostKey, JSON.stringify(oversized));
const tooLarge = await successful(await post('propose', { jobId: richId }));
assert.equal(tooLarge.evidence.status, 'incomplete');
assert.equal(tooLarge.evidence.code, 'EVIDENCE_TOO_LARGE');
db.set(lostKey, lostSnapshot);
// Budget global : chaque décision respecte son plafond, leur somme dépasse 8 MiB.
const budgetId = crypto.randomUUID();
const budgetFixtures = Array.from({ length: 110 }, (_, i) => game(1000 + i));
db.set(
  'jobs/' + budgetId + '/manifest.json',
  JSON.stringify({
    ...manifest,
    id: budgetId,
    fixtures: budgetFixtures,
    createdAt: new Date().toISOString(),
    quoteDays: [],
    quoteTotals: {},
    quoteCompleted: [],
  }),
);
for (const f of budgetFixtures) {
  const id = f.fixture.id,
    snapshotId = id.toString(16).padStart(64, '0');
  const snapshot = JSON.parse(lostSnapshot);
  snapshot.report.matchId = id;
  snapshot.report.events = [
    { ...snapshot.report.events[0], matchId: id, status: 'reject', reasons: ['x'.repeat(80000)] },
  ];
  db.set(
    'jobs/' + budgetId + '/evidence/snapshots/' + snapshotId + '.json',
    JSON.stringify(snapshot),
  );
  db.set('jobs/' + budgetId + '/evidence/original/' + id + '.json', JSON.stringify({ snapshotId }));
  db.set(
    'jobs/' + budgetId + '/reports/' + id + '.json',
    JSON.stringify({ ...snapshot.report, events: [], evidenceSnapshotId: snapshotId }),
  );
}
const overBudget = await successful(await post('propose', { jobId: budgetId }));
assert.equal(overBudget.evidence.code, 'EVIDENCE_TOO_LARGE');
assert.equal(overBudget.evidence.status, 'incomplete');
const budgetObjects = [...db.entries()].filter(([key]) =>
  key.startsWith('jobs/' + budgetId + '/evidence/proposals/'),
);
assert(
  budgetObjects.reduce((n, [, value]) => n + Buffer.byteLength(value), 0) <= 8 * 1024 * 1024,
  'Even partial writes respect total proposal budget',
);
assert.equal((await get('jobId=' + budgetId)).status, 404, 'No publication of a partial dossier');
// Une panne qui touche également le marqueur R2 reste signalée dans la réponse et les journaux.
env.BUCKET.put = async (key, value, options) => {
  if (key.includes('/evidence/proposals/')) throw Error(env.API_FOOTBALL_KEY);
  return originalPut(key, value, options);
};
const totalFailure = await successful(await post('propose', { jobId: richId }));
assert.equal(totalFailure.evidence.status, 'incomplete');
assert(logs.some((line) => JSON.parse(line).event === 'evidence_status_write_failed'));
env.BUCKET.put = originalPut;
console.warn = warn;
assert(logs.some((line) => JSON.parse(line).event === 'evidence_incomplete'));
assert(!JSON.stringify(logs).includes(env.API_RELAY_TOKEN));
assert(!JSON.stringify(logs).includes('private-person-sentinel'));

// Bornes exactes UTF-8 et secrets courts : champs stables, valeur autonome masquée.
assert.equal(boundedEvidence('é', 4), '"é"');
assert.throws(() => boundedEvidence('é', 3), { code: 'EVIDENCE_TOO_LARGE' });
assert.deepEqual(
  redactEvidence(
    { API_FOOTBALL_KEY: 'k', API_RELAY_TOKEN: 'x+' },
    { bookmakers: 'Book k x+', kickoff: 'kickoff' },
  ),
  { bookmakers: 'Book [masqué] [masqué]', kickoff: 'kickoff' },
);
const shortId = crypto.randomUUID(),
  originalKey = env.API_FOOTBALL_KEY;
db.set(
  'jobs/' + shortId + '/manifest.json',
  JSON.stringify({
    ...manifest,
    id: shortId,
    fixtures: [game(8000)],
    createdAt: new Date().toISOString(),
    quoteDays: ['8000'],
    quoteTotals: {},
    quoteCompleted: [],
  }),
);
env.API_FOOTBALL_KEY = 'k';
await successful(await post('quotes', { jobId: shortId, day: '8000' }));
assert(
  JSON.parse(db.get('jobs/' + shortId + '/evidence/quotes/8000.json')).rows[0].bookmakers.length >
    0,
  'Short key no longer renames bookmakers or breaks quotes route',
);
env.API_FOOTBALL_KEY = originalKey;
assert.equal(
  (
    await get(
      'jobId=' +
        prepared.jobId +
        '&proposalId=' +
        richProposal.evidence.proposalId +
        '&includeSnapshots=current',
    )
  ).status,
  404,
  'A proposal from another job cannot select its snapshots',
);
// Code futur de #7, aucune dépendance ni modification des seuils actuels.
const thresholdSnapshot = JSON.parse(lostSnapshot);
thresholdSnapshot.policy.minTicketProbability = 0.5;
thresholdSnapshot.report.events = [
  { ...thresholdSnapshot.report.events[0], prudentProbability: 0.6, probability: 0.9, reasons: [] },
];
const thresholdDecision = ticketDecision(
  thresholdSnapshot,
  [
    {
      matchId: 999,
      bookmaker: thresholdSnapshot.report.events[0].bookmaker,
      prudentProbability: 0.7,
    },
  ],
  now,
);
assert.equal(thresholdDecision.events[0].reasons[0].code, 'TICKET_PROBABILITY_BELOW_THRESHOLD');
const normalizedSnapshot = JSON.parse(lostSnapshot);
normalizedSnapshot.report.events = [
  { ...normalizedSnapshot.report.events[0], bookmaker: ' bet365 ', reasons: [] },
];
const normalizedDecision = ticketDecision(
  normalizedSnapshot,
  [{ matchId: 999, bookmaker: 'Bet365' }],
  now,
);
assert.equal(normalizedDecision.events[0].reasons[0].code, 'CANDIDATE_RANKING');
assert.equal(EVIDENCE_LIMITS.proposalBytes, 8 * 1024 * 1024);
console.log(
  'Passed: realistic 900 quotes/match, UTF-8 byte ceilings, on-demand snapshots, complete byte pagination, lost R2 writes/missing snapshot preserve ticket, safe logs and relay/short-key redaction.',
);
