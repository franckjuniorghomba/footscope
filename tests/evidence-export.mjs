import assert from 'node:assert/strict';
import fs from 'node:fs';

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
  ' API_FOOTBALL_KEY ' + env.API_FOOTBALL_KEY + ' OPENAI_API_KEY ' + env.OPENAI_API_KEY;
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
assert(dossier.decisions[1].events[0].reasons.some((r) => r.code === 'SOURCE_UNAVAILABLE'));
assert(dossier.decisions[0].events[0].reasons.some((r) => r.code === 'EDGE_BELOW_POLICY'));
assert.equal(dossier.decisions[2].reasons[0].code, 'NO_ODDS_AFTER_COMPLETE_COVERAGE');
assert.equal(dossier.decisions[3].reasons[0].code, 'NO_SUPPORTED_FRESH_QUOTES');
assert(
  dossier.decisions[4].events.some((e) => e.reasons.some((r) => r.code === 'MARKET_NOT_SUPPORTED')),
);
assert.equal(dossier.llm.requested, false);
assert.equal(dossier.llm.input, null);
const serialized = JSON.stringify(dossier);
for (const secret of [
  'API_FOOTBALL_KEY',
  'OPENAI_API_KEY',
  env.API_FOOTBALL_KEY,
  env.OPENAI_API_KEY,
  'owner-sentinel',
  'private-person-sentinel',
])
  assert(!serialized.includes(secret), 'Export leaked ' + secret.replace(/secret.*/, '[sentinel]'));
const snapshot = dossier.decisions[0].snapshot;
const replay = mod.assessMatch(snapshot.inputs, Date.parse(snapshot.evaluatedAt));
assert.deepEqual(replay.model, snapshot.report.model);
assert.deepEqual(replay.events, snapshot.report.events, 'Every model output reproduced offline');
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
assert(
  ticketDossier.decisions
    .flatMap((d) => d.events)
    .some((e) => e.reasons.some((r) => r.code === 'INVALID_ODDS')),
);
const checked = ticketDossier.decisions.find((d) => d.state === 'included');
assert.notEqual(
  checked.snapshotId,
  checked.originalSnapshotId,
  'Final refresh is a separate snapshot',
);
assert(
  checked.original.quotes.some((r) =>
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
assert.equal(
  reads - beforeReads,
  5,
  'Two indexed pages plus three metadata reads, independent of match count',
);
assert.equal(calls, largeCalls);
assert.equal(
  (await successful(await get('jobId=' + largeId + '&limit=100'))).decisions.length,
  100,
);
console.log(
  'Passed: 21/21 retained decisions (zero eligible, refusals and source failure), offline numeric replay, dated sources, secrets/identity absent, owner refusals, bounded read-only pagination, zero export calls, immutable original/recheck/tickets, composition rules and exact semantic LLM input.',
);
