import { api } from './provider.js';
import { assessMatch } from './statistics.js';
import { POLICY, MODEL_VERSION } from './policy.js';
import { supportedMarkets } from './coupon.js';

const analysisCache = new Map();
const analysisPending = new Map();

export function sourceStamp(query, retrievedAt, status = 'available') {
  return { provider: 'API-Football', query, retrievedAt: retrievedAt || null, status };
}

// Les erreurs fournisseur et les identités de joueurs ne font pas partie du contrat exporté.
export function redactEvidence(env, value) {
  const forbidden = [
    env.API_FOOTBALL_KEY,
    env.OPENAI_API_KEY,
    env.API_RELAY_TOKEN,
    'API_FOOTBALL_KEY',
    'OPENAI_API_KEY',
    'API_RELAY_TOKEN',
  ].filter(Boolean);
  const clean = (x) => {
    if (typeof x === 'string') {
      for (const secret of forbidden) x = x.split(secret).join('[masqué]');
      return x;
    }
    if (Array.isArray(x)) return x.map(clean);
    if (x && typeof x === 'object')
      return Object.fromEntries(Object.entries(x).map(([k, v]) => [clean(k), clean(v)]));
    return x;
  };
  return clean(value);
}

const pick = (x, keys) =>
  Object.fromEntries(keys.filter((k) => x?.[k] !== undefined).map((k) => [k, x[k]]));
export function publicFixture(f) {
  return {
    fixture: {
      ...pick(f.fixture, ['id', 'timestamp', 'date']),
      status: pick(f.fixture.status, ['short']),
    },
    teams: {
      home: pick(f.teams.home, ['id', 'name']),
      away: pick(f.teams.away, ['id', 'name']),
    },
    league: pick(f.league, ['id', 'name', 'country', 'season']),
    goals: pick(f.goals, ['home', 'away']),
  };
}

export function publicOdds(rows) {
  return rows.map((r) => ({
    fixture: pick(r.fixture, ['id']),
    update: r.update,
    ...(r.collection ? { collection: pick(r.collection, ['query', 'retrievedAt']) } : {}),
    bookmakers: (r.bookmakers || []).map((b) => ({
      name: b.name,
      bets: (b.bets || []).map((m) => ({
        name: m.name,
        values: (m.values || []).map((v) => pick(v, ['value', 'odd'])),
      })),
    })),
  }));
}

const reasonCodes = [
  ['Match commencé', 'MATCH_STARTED'],
  ['Match déjà commencé', 'MATCH_STARTED'],
  ['huit résultats', 'HISTORY_INSUFFICIENT'],
  ['trop ancien', 'HISTORY_STALE'],
  ['Source indisponible', 'SOURCE_UNAVAILABLE'],
  ['Compositions', 'LINEUPS_UNCONFIRMED'],
  ['Cote absente', 'ODDS_STALE_OR_INVALID'],
  ['Marché non modélisé', 'MARKET_UNMODELED'],
  ['Probabilité exploratoire', 'PROBABILITY_BELOW_POLICY'],
  ['Avantage prudent', 'EDGE_BELOW_POLICY'],
];
function structuredReason(message) {
  const code = reasonCodes.find(([text]) => message.includes(text))?.[1] || 'SCREENING_REJECTION';
  return { code, message };
}

export function evidenceSnapshot(
  env,
  fixture,
  data,
  report,
  { code, rawOdds = [], oddsSource, fixtureSource, evaluatedAt } = {},
) {
  const inputs = {
    fixture: publicFixture(data?.fixture || fixture),
    retrievedAt: data?.retrievedAt || report.retrievedAt,
    home: (data?.home || []).map(publicFixture),
    away: (data?.away || []).map(publicFixture),
    odds: publicOdds(data?.odds || rawOdds),
    injuries: [],
    lineups: (data?.lineups || []).map((x) => ({ startXI: (x.startXI || []).map(() => ({})) })),
    errors: Object.fromEntries(Object.keys(data?.errors || {}).map((k) => [k, 'unavailable'])),
  };
  const fullReport = pick(report, [
    'matchId',
    'match',
    'country',
    'league',
    'kickoff',
    'model',
    'lineupsConfirmed',
    'missing',
    'events',
    'common',
    'retrievedAt',
    'modelVersion',
    'modelValidated',
  ]);
  const sources = data?.sources || { fixture: fixtureSource, odds: oddsSource };
  return redactEvidence(env, {
    schemaVersion: 1,
    evaluatedAt: evaluatedAt || new Date().toISOString(),
    modelVersion: MODEL_VERSION,
    policy: { ...POLICY },
    modelParameters: {
      scoreTerms: 30,
      sensitivityMultipliers: [0.75, 1, 1.25],
      prudentDeduction: 0.05,
    },
    sources,
    inputs,
    quotes: publicOdds(rawOdds.length ? rawOdds : data?.odds || []),
    report: fullReport,
    screeningReasons: code
      ? [{ code, message: report.common[0] }]
      : (report.common || []).map(structuredReason),
  });
}

const sameEvent = (a, b) =>
  ['matchId', 'bookmaker', 'market', 'selection'].every((k) => a[k] === b[k]);
export function ticketDecision(snapshot, selections, at) {
  const report = snapshot.report;
  const selected = selections.find((x) => x.matchId === report.matchId);
  const compositionReason = (event) => {
    if (Date.parse(event.kickoff) <= at) return 'MATCH_STARTED';
    const age = at - Date.parse(event.updated);
    if (!Number.isFinite(age) || age > snapshot.policy.maxOddsAgeMs || age < -300000)
      return 'ODDS_STALE_OR_INVALID';
    if (at - Date.parse(report.retrievedAt) > 15 * 60000) return 'EVIDENCE_STALE';
    if (selected) return 'ONE_SELECTION_PER_MATCH';
    if (selections.length && selections[0].bookmaker !== event.bookmaker) return 'SINGLE_BOOKMAKER';
    if (selections.length >= snapshot.policy.maxSelections) return 'MAX_SELECTIONS';
    return 'CANDIDATE_RANKING';
  };
  const events = (report.events || []).map((e) => {
    const included = selections.some((s) => sameEvent(s, e));
    return {
      ...e,
      state: included ? 'included' : 'excluded',
      reasons: included
        ? [{ code: 'POLICY_PASSED' }, { code: 'TICKET_SELECTED' }]
        : e.reasons.length
          ? e.reasons.map(structuredReason)
          : [{ code: compositionReason(e) }],
      provenance: {
        input: 'inputs',
        sources: ['fixture', 'home', 'away', 'odds'],
        evaluatedAt: snapshot.evaluatedAt,
      },
    };
  });
  // Certaines cotes ne sont jamais soumises au modèle (marché filtré ou cote invalide).
  for (const row of snapshot.quotes)
    for (const book of row.bookmakers)
      for (const market of book.bets)
        for (const value of market.values) {
          const event = {
            matchId: report.matchId,
            bookmaker: book.name,
            market: market.name,
            selection: value.value,
          };
          if (events.some((e) => sameEvent(e, event))) continue;
          events.push({
            ...event,
            odd: value.odd,
            updated: row.update,
            state: 'excluded',
            reasons: [
              {
                code:
                  !Number.isFinite(Number(value.odd)) || Number(value.odd) <= 1
                    ? 'INVALID_ODDS'
                    : !supportedMarkets.has(market.name)
                      ? 'MARKET_NOT_SUPPORTED'
                      : 'QUOTE_NOT_EVALUATED',
              },
              ...snapshot.screeningReasons,
            ],
            provenance: { input: 'quotes', sources: ['odds'], evaluatedAt: snapshot.evaluatedAt },
          });
        }
  return {
    matchId: report.matchId,
    state: selected
      ? 'included'
      : Object.values(snapshot.sources).some((s) => s?.status === 'unavailable')
        ? 'source_unavailable'
        : 'excluded',
    reasons: selected
      ? [{ code: 'TICKET_SELECTED' }]
      : [...snapshot.screeningReasons, ...events.flatMap((e) => e.reasons)],
    events,
  };
}

export async function evidence(env, id, prefetched = {}) {
  const collected = prefetched.fixture ? null : await api(env, 'fixtures?id=' + id, 60000);
  const fixture = prefetched.fixture || collected.response[0];
  if (!fixture) throw Error('Match introuvable.');
  const d = {
    fixture,
    retrievedAt: new Date().toISOString(),
    errors: {},
    odds: prefetched.odds || [],
    lineups: [],
    sources: {
      fixture: collected
        ? sourceStamp('fixtures?id=' + id, collected.retrievedAt)
        : prefetched.fixtureSource,
      odds: prefetched.oddsSource,
    },
  };
  for (const [k, path] of Object.entries({
    home: 'fixtures?team=' + fixture.teams.home.id + '&last=10',
    away: 'fixtures?team=' + fixture.teams.away.id + '&last=10',
    odds: 'odds?fixture=' + id,
    injuries: 'injuries?fixture=' + id,
    lineups: 'fixtures/lineups?fixture=' + id,
  })) {
    if (k === 'odds' && prefetched.odds) continue;
    if (
      k === 'lineups' &&
      prefetched.fixture &&
      fixture.fixture.timestamp * 1000 - Date.now() > 90 * 60000
    ) {
      d.sources[k] = { provider: 'API-Football', status: 'not_requested', retrievedAt: null };
      continue;
    }
    try {
      const response = await api(env, path, k === 'odds' || k === 'lineups' ? 60000 : 900000);
      d[k] = response.response;
      d.sources[k] = sourceStamp(path, response.retrievedAt);
    } catch (e) {
      if (e.code === 'API_RATE_LIMIT' || e.code === 'API_QUEUE_BUSY') throw e;
      d[k] = [];
      d.errors[k] = e.message;
      d.sources[k] = sourceStamp(path, null, 'unavailable');
    }
  }
  return d;
}

export async function scan(env, id) {
  const hit = analysisCache.get(id);
  if (hit && Date.now() - hit.at < 60000) return hit.value;
  if (analysisPending.has(id)) return analysisPending.get(id);
  const task = evidence(env, id)
    .then((d) => {
      const value = assessMatch(d);
      analysisCache.set(id, { at: Date.now(), value });
      if (analysisCache.size > 100) analysisCache.delete(analysisCache.keys().next().value);
      return value;
    })
    .finally(() => analysisPending.delete(id));
  analysisPending.set(id, task);
  return task;
}
