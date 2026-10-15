import assert from 'node:assert/strict';
import { assistant } from '../src/server/assistant.js';
import { finishEvidence } from '../src/server/jobs.js';
import { performance, settle } from '../src/server/storage.js';
import { marketReport, MARKET_COUPON_NOW as now } from './fixtures/market-coupons.mjs';
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [Date.now()]));
  }
};
Date.now = () => now;
const db = new Map();
const bucket = {
  get: async (key) => (db.has(key) ? { json: async () => JSON.parse(db.get(key)) } : null),
  put: async (key, value) => {
    db.set(key, value);
    return {};
  },
  list: async ({ prefix }) => ({
    objects: [...db.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key, uploaded: new Date(now) })),
  }),
};
const env = { BUCKET: bucket, API_FOOTBALL_KEY: 'mock-key' };
const id = '00000000-0000-4000-8000-000000000220';
const reports = Array.from({ length: 6 }, (_, i) => marketReport(i + 1));
const job = {
  id,
  owner: 'owner',
  createdAt: new Date(now).toISOString(),
  scope: { date: '2030-01-01' },
  fixtures: reports.map((r) => ({ fixture: { id: r.matchId } })),
  quoteDays: [],
  quoteTotals: {},
  quoteCompleted: [],
  finalChecked: {},
};
db.set('jobs/' + id + '/manifest.json', JSON.stringify(job));
for (const r of reports) {
  const snapshotId = String(r.matchId).padStart(64, '0');
  const prefix = `jobs/${id}/evidence/`;
  db.set(prefix + 'original/' + r.matchId + '.json', JSON.stringify({ snapshotId }));
  db.set(
    prefix + 'snapshots/' + snapshotId + '.json',
    JSON.stringify({
      report: { ...r, marketCouponQuotes: undefined },
      evaluatedAt: new Date(now).toISOString(),
      sources: {},
      screeningReasons: [],
      quoteSummary: [],
    }),
  );
  db.set(
    `jobs/${id}/reports/${r.matchId}.json`,
    JSON.stringify({ ...r, evidenceSnapshotId: snapshotId }),
  );
}
const request = (body = {}, user = 'owner', origin) =>
  new Request('https://site/api/assistant/propose', {
    method: 'POST',
    headers: { 'oai-authenticated-user-id': user, ...(origin ? { origin } : {}) },
    body: JSON.stringify({ jobId: id, ...body }),
  });
let requests = 0;
globalThis.fetch = async () => {
  requests++;
  throw Error('Aucun réseau attendu');
};
const req = request({
  marketCoupons: [{ confidence: 1 }],
  selections: [{ matchId: 999 }],
  marketCouponQuotes: [{ odd: 50 }],
});
const result = await (
  await finishEvidence(req, env, await assistant(req, env, '/api/assistant/propose'))
).json();
assert.deepEqual(
  result.marketCoupons.map((c) => c.size),
  [1, 2, 3],
);
assert.equal(result.selections.length, 0, 'Le ticket prudent reste vide');
assert.equal(result.verdict, 'insufficient');
assert.equal(result.ticketProbability, null);
assert.equal(result.modelValidated, false);
assert.equal(result.realMoneyEligible, false);
assert.equal(requests, 0);
const observationKey = [...db.keys()].find((k) => k.startsWith('observations/'));
const record = JSON.parse(db.get(observationKey));
assert.deepEqual(record.marketCoupons, result.marketCoupons);
assert.deepEqual(
  record.marketCouponTracking.map((c) => c.type),
  Array(3).fill('coupon marché'),
);
assert.deepEqual(
  record.marketCouponTracking.map((c) => c.combinedProbability),
  result.marketCoupons.map((c) => c.confidence),
);
assert.equal(record.combinedProbability, null);
assert.deepEqual(record.outcomes, []);
const before = new Map(db);
await assert.rejects(
  assistant(request({}, 'other'), env, '/api/assistant/propose'),
  /Accès.*refusé/,
);
assert.deepEqual(
  db,
  before,
  'Aucune lecture de rapport ni écriture de suivi pour autre utilisateur',
);
assert.equal(
  (await assistant(request({}, 'owner', 'https://other'), env, '/api/assistant/propose')).status,
  403,
);
assert.equal(
  (
    await assistant(request(), { ...env, BUCKET: null }, '/api/assistant/propose').catch(() => ({
      status: 503,
    }))
  ).status,
  503,
);
// La couverture incomplète refuse tout coupon.
job.quoteDays = ['2030-01-01'];
db.set('jobs/' + id + '/manifest.json', JSON.stringify(job));
assert.equal((await assistant(request(), env, '/api/assistant/propose')).status, 409);
assert.equal(requests, 0);
// Le règlement utilise les règles existantes, sans recalcul de confiance, et est idempotent.
Date.now = () => now + 86400000;
for (let matchId = 1; matchId <= 6; matchId++) {
  const hash = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode('fixtures?id=' + matchId)),
  ).toString('hex');
  db.set(
    'api-cache/' + hash + '.json',
    JSON.stringify({
      at: Date.now(),
      data: {
        response: [{ fixture: { status: { short: 'FT' } }, goals: { home: 2, away: 1 } }],
        errors: {},
      },
    }),
  );
}
const resolved = await settle(env);
assert.equal(resolved.examined, 3);
const after = JSON.parse(db.get(observationKey));
assert.deepEqual(
  after.marketCouponTracking.map((c) => c.combinedProbability),
  record.marketCouponTracking.map((c) => c.combinedProbability),
);
assert(after.marketCouponTracking.every((c) => c.settled && c.outcomes.every((o) => o.won)));
assert.deepEqual(after.outcomes, []);
const callCount = requests;
assert.equal((await settle(env)).examined, 0);
assert.equal(requests, callCount);
const perf = await performance(env);
assert.equal(perf.tickets.settled, 0);
assert.equal(perf.settledSelections, 0);
assert.equal(perf.marketCoupons.type, 'coupon marché');
assert.equal(perf.marketCoupons.settled, 3);
assert.equal(perf.marketCoupons.items[0].probabilitySource, 'recorded');
assert.equal(
  perf.marketCoupons.items[0].announcedProbability,
  record.marketCouponTracking[0].combinedProbability,
);
console.log(
  'Passed: API coupons serveur, injection ignorée, ticket inchangé, refus propriétaire/origine/couverture, zéro requête de proposition, suivi distinct et confiance figée, règlement idempotent.',
);
// Projection réellement envoyée au LLM et conservée dans les preuves : aucun coupon marché.
Date.now = () => now;
job.quoteDays = [];
job.finalChecked = { 1: now };
db.set('jobs/' + id + '/manifest.json', JSON.stringify(job));
const withTicket = {
  ...reports[0],
  evidenceSnapshotId: String(1).padStart(64, '0'),
  events: [
    {
      matchId: 1,
      match: reports[0].match,
      kickoff: reports[0].kickoff,
      updated: new Date(now).toISOString(),
      market: 'Both Teams Score',
      selection: 'Yes',
      bookmaker: 'bet365',
      odd: 1.5,
      probability: 0.85,
      prudentProbability: 0.8,
      prudentEdge: 0.2,
      status: 'simulation_eligible',
      reasons: [],
    },
  ],
};
db.set(`jobs/${id}/reports/1.json`, JSON.stringify(withTicket));
let input;
globalThis.fetch = async (url, options) => {
  assert.equal(url, 'https://api.openai.com/v1/responses');
  const body = JSON.parse(options.body);
  input = JSON.parse(body.input.slice(body.input.indexOf('\n') + 1));
  assert.equal(input.marketCoupons, undefined);
  assert.equal(input.marketCouponQuotes, undefined);
  return Response.json({
    output: [
      {
        content: [
          {
            type: 'output_text',
            text: JSON.stringify({ summary: 'Explication simulée', reasons: [], risks: [] }),
          },
        ],
      },
    ],
  });
};
const llmEnv = { ...env, OPENAI_API_KEY: 'mock-llm-key', LLM_MODEL: 'mock-model' };
const llmReq = request();
const llmResult = await (
  await finishEvidence(llmReq, llmEnv, await assistant(llmReq, llmEnv, '/api/assistant/propose'))
).json();
assert.equal(llmResult.marketCoupons.length, 3);
assert.deepEqual(llmResult.selections, withTicket.events);
assert.equal(llmResult.ticketProbability, 0.8);
assert.equal(llmResult.evidence.status, 'complete');
const metadata = [...db.entries()]
  .filter(([k]) => k.includes('/proposals/') && k.endsWith('/ticket.json'))
  .map(([, v]) => JSON.parse(v))
  .find((v) => v.llm.requested);
assert(metadata);
assert.deepEqual(metadata.llm.input, input);
assert(!JSON.stringify(metadata).includes('marketCoupons'));
console.log(
  'Passed: coupons absents de la requête LLM réelle et des métadonnées de preuves ; ticket prudent conservé.',
);
