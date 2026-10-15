import { fixedDay, fixturesForDay } from './provider.js';
import { POLICY, MODEL_VERSION } from './policy.js';
import { json } from './http.js';
import { putJob, universeJob } from './jobs.js';
import { scan } from './evidence.js';
import { BELOW_THRESHOLD_REASON, selectCouponDetailed } from './coupon.js';
import { llmExplanation, statisticalSummary } from './llm.js';
import { settle, marketCouponObservations } from './storage.js';
import { buildMarketCoupons } from './market-coupons.js';
import { marketValueSummary } from './market.js';

// Clé de scellement dédiée, dérivée de API_FOOTBALL_KEY par HKDF-SHA-256 : la clé du
// fournisseur ne sert plus directement de clé HMAC. Le sel est fixe et public (séparation
// de domaine) ; la confidentialité repose uniquement sur API_FOOTBALL_KEY.
const SEAL_SALT = 'footscope/seal/salt/v1';
const SEAL_INFO = 'footscope-seal-v1';
async function signature(env) {
  if (typeof env.API_FOOTBALL_KEY !== 'string' || !env.API_FOOTBALL_KEY)
    throw Object.assign(Error('Signature des analyses indisponible.'), { status: 503 });
  const encode = (text) => new TextEncoder().encode(text);
  const material = await crypto.subtle.importKey(
    'raw',
    encode(env.API_FOOTBALL_KEY),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encode(SEAL_SALT), info: encode(SEAL_INFO) },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}
async function seal(env, report) {
  const payload = JSON.stringify({ report, expires: Date.now() + 600000 });
  const mac = await crypto.subtle.sign(
    'HMAC',
    await signature(env),
    new TextEncoder().encode(payload),
  );
  return {
    payload,
    signature: Array.from(new Uint8Array(mac), (x) => x.toString(16).padStart(2, '0')).join(''),
  };
}
async function unseal(env, token) {
  const key = await signature(env);
  if (
    typeof token?.payload !== 'string' ||
    token.payload.length > 5000000 ||
    typeof token.signature !== 'string' ||
    !/^[0-9a-f]{64}$/.test(token.signature)
  )
    throw Error('Analyse altérée. Relancez la vérification.');
  const mac = new Uint8Array(token.signature.match(/../g).map((x) => parseInt(x, 16)));
  // Vérification en temps constant par WebCrypto, jamais par comparaison de chaînes.
  if (!(await crypto.subtle.verify('HMAC', key, mac, new TextEncoder().encode(token.payload))))
    throw Error('Analyse altérée. Relancez la vérification.');
  const p = JSON.parse(token.payload);
  if (!(p.expires >= Date.now())) throw Error('Analyse expirée. Relancez la vérification.');
  return p.report;
}

// Même admissibilité temporelle que le compositeur ; aucune nouvelle admission.
// Seuls les meilleurs candidats par match/bookmaker, hors matchs déjà retenus,
// peuvent expliquer pourquoi ajouter un match ferait passer sous le seuil.
function thresholdExcludedCandidates(reports, ticket, now) {
  const bookKey = (name) => (name.trim().toLowerCase() === 'bet365' ? 'Bet365' : name);
  const selected = new Set(ticket.selections.map((e) => e.matchId));
  const combined = ticket.ticketProbability ?? 1;
  const candidates = new Map();
  for (const report of reports) {
    if (now - Date.parse(report.retrievedAt) > 15 * 60000) continue;
    for (const e of report.events) {
      const age = now - Date.parse(e.updated);
      if (
        selected.has(e.matchId) ||
        e.status !== 'simulation_eligible' ||
        !Number.isFinite(e.prudentProbability) ||
        e.prudentProbability <= 0 ||
        e.prudentProbability > 1 ||
        !(Date.parse(e.kickoff) > now) ||
        !(age >= -300000 && age <= POLICY.maxOddsAgeMs) ||
        (ticket.bookmaker && bookKey(e.bookmaker) !== bookKey(ticket.bookmaker))
      )
        continue;
      const key = JSON.stringify([e.matchId, bookKey(e.bookmaker)]);
      const previous = candidates.get(key);
      if (
        !previous ||
        e.prudentProbability > previous.prudentProbability ||
        (e.prudentProbability === previous.prudentProbability &&
          e.prudentEdge > previous.prudentEdge)
      )
        candidates.set(key, e);
    }
  }
  const excluded = [...candidates.values()]
    .filter((e) => combined * e.prudentProbability < POLICY.minTicketProbability)
    // Départage indépendant de l’ordre de collecte : match numérique croissant,
    // puis bookmaker canonique en ordre lexicographique (sans locale).
    .sort((a, b) => {
      const left = bookKey(a.bookmaker),
        right = bookKey(b.bookmaker);
      return (
        b.prudentProbability - a.prudentProbability ||
        a.matchId - b.matchId ||
        (left < right ? -1 : left > right ? 1 : 0)
      );
    });
  return {
    count: excluded.length,
    // Tous les candidats (événements serveur), pour la valeur face au marché descriptive ;
    // l'entrée du LLM reste bornée aux cinq premiers ci-dessous.
    events: excluded,
    candidates: excluded.slice(0, 5).map((e) => ({
      matchId: e.matchId,
      match: e.match,
      bookmaker: e.bookmaker,
      market: e.market,
      selection: e.selection,
      probability: e.probability,
      prudentProbability: e.prudentProbability,
      ticketProbabilityIfAdded: combined * e.prudentProbability,
      reason: 'TICKET_PROBABILITY_BELOW_THRESHOLD',
    })),
  };
}

export async function assistant(req, env, path) {
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) return json({ error: 'Origine refusée' }, 403);
  if (
    ![
      '/api/assistant/prepare',
      '/api/assistant/scan',
      '/api/assistant/propose',
      '/api/assistant/review',
      '/api/assistant/health',
      '/api/assistant/settle',
      '/api/assistant/quotes',
    ].includes(path)
  )
    return json({ error: 'Action inconnue' }, 404);
  const raw = await req.text();
  if (raw.length > 6000000) return json({ error: 'Demande trop volumineuse' }, 413);
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return json({ error: 'Demande invalide' }, 400);
  }
  if (path.endsWith('settle')) return json(await settle(env));
  if (path.endsWith('health')) {
    const answer = await llmExplanation(env, {
      verdict: 'insufficient',
      selections: [],
      modelValidated: false,
      reasons: ['Test de connexion, aucun pari.'],
    });
    return json({
      configured: !!(env.OPENAI_API_KEY && env.LLM_MODEL),
      connected: answer.engine === 'llm',
      model: env.LLM_MODEL || null,
      error: answer.llmError || null,
    });
  }
  if (path.endsWith('prepare')) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || '')) return json({ error: 'Date invalide' }, 400);
    const scope = {
      date: body.date,
      country: String(body.country || '').slice(0, 80),
      league: String(body.league || '').slice(0, 100),
      search: String(body.search || '').slice(0, 100),
    };
    const rows = (await fixturesForDay(env, scope.date)).response
      .filter(
        (f) =>
          f.fixture.status.short === 'NS' &&
          f.fixture.timestamp * 1000 > Date.now() &&
          (!scope.country || f.league.country === scope.country) &&
          (!scope.league || f.league.name === scope.league) &&
          (!scope.search ||
            (f.teams.home.name + ' ' + f.teams.away.name)
              .toLowerCase()
              .includes(scope.search.toLowerCase())),
      )
      .sort((a, b) => a.fixture.timestamp - b.fixture.timestamp);
    if (!env.BUCKET) return json({ error: 'Stockage requis pour analyser tous les matchs.' }, 503);
    const next = new Date(Date.parse(scope.date + 'T12:00:00Z') + 86400000)
      .toISOString()
      .slice(0, 10);
    const job = {
      id: crypto.randomUUID(),
      owner: req.headers.get('oai-authenticated-user-id') || 'private-site',
      scope,
      createdAt: new Date().toISOString(),
      fixtures: rows,
      quoteMode: rows.length <= 20 ? 'fixtures' : 'days',
      quoteDays: rows.length
        ? rows.length <= 20
          ? rows.map((f) => String(f.fixture.id))
          : [scope.date, next]
        : [],
      quoteTotals: {},
      quoteCompleted: [],
    };
    await putJob(env, job);
    return json({
      scope,
      eligibleCount: rows.length,
      ids: rows.map((f) => f.fixture.id),
      jobId: job.id,
      quoteDays: job.quoteDays,
      quoteMode: job.quoteMode,
      limit: null,
    });
  }
  let preparedJob = null;
  if (
    body.jobId &&
    ['/api/assistant/quotes', '/api/assistant/scan', '/api/assistant/propose'].includes(path)
  ) {
    const response = await universeJob(
      req,
      env,
      path,
      body,
      req.headers.get('oai-authenticated-user-id') || 'private-site',
    );
    if (response instanceof Response) return response;
    preparedJob = response;
  }
  if (path.endsWith('scan')) {
    if (!Number.isInteger(body.matchId) || body.matchId < 1)
      return json({ error: 'Match invalide' }, 400);
    const report = await scan(env, body.matchId);
    return json({ report, token: await seal(env, report) });
  }
  const proposing = path.endsWith('propose');
  if (!preparedJob && (!Array.isArray(body.tokens) || body.tokens.length > 4))
    return json({ error: 'Analyses signées requises.' }, 400);
  const reports = preparedJob?.reports || [];
  if (!preparedJob) for (const t of body.tokens) reports.push(await unseal(env, t));
  if (new Set(reports.map((r) => r.matchId)).size !== reports.length)
    return json({ error: 'Analyse en double.' }, 400);
  let selections = [],
    reviews = [],
    blockers = [],
    ticket = null,
    excludedCandidates = [],
    excludedCandidatesCount = 0,
    excludedEvents = [],
    marketCoupons = [];
  // Événements serveur seulement, pour la valeur face au marché (jamais l'entrée du client).
  const reviewedEvents = [];
  const scope = preparedJob?.scope || body.scope || {};
  if (proposing) {
    const allowed = reports.filter(
      (r) =>
        (!scope.country || r.country === scope.country) &&
        (!scope.league || r.league === scope.league) &&
        (!scope.search || r.match.toLowerCase().includes(String(scope.search).toLowerCase())) &&
        fixedDay(r.kickoff) === scope.date,
    );
    for (const report of allowed) {
      const candidates = report.events
        .filter(
          (x) =>
            x.status === 'simulation_eligible' &&
            Date.parse(x.kickoff) > Date.now() &&
            Date.now() - Date.parse(x.updated) <= POLICY.maxOddsAgeMs,
        )
        .sort(
          (a, b) => b.prudentProbability - a.prudentProbability || b.prudentEdge - a.prudentEdge,
        );
      if (candidates.length) selections.push(candidates[0]);
      else
        blockers.push(
          report.match +
            ' : ' +
            (report.firstRejection ||
              report.common[0] ||
              report.events[0]?.reasons[0] ||
              'Aucune cote exploitable.'),
        );
    }
    const now = Date.now();
    ticket = selectCouponDetailed(allowed, now);
    marketCoupons = buildMarketCoupons(allowed, now);
    const excluded = thresholdExcludedCandidates(allowed, ticket, now);
    excludedCandidates = excluded.candidates;
    excludedCandidatesCount = excluded.count;
    excludedEvents = excluded.events;
    selections = ticket.selections;
  } else {
    if (!Array.isArray(body.selections) || body.selections.length < 1 || body.selections.length > 4)
      return json({ error: 'Une à quatre sélections requises.' }, 400);
    if (new Set(body.selections.map((x) => x.matchId)).size !== body.selections.length)
      blockers.push('Plusieurs sélections liées au même match.');
    if (new Set(body.selections.map((x) => x.bookmaker)).size > 1)
      blockers.push('Bookmakers différents : ce combiné ne peut pas être joué tel quel.');
    for (const x of body.selections) {
      const ev = reports
        .find((r) => r.matchId === x.matchId)
        ?.events.find(
          (y) =>
            y.market === x.market && y.selection === x.selection && y.bookmaker === x.bookmaker,
        );
      if (!ev) {
        reviewedEvents.push({
          missing: true,
          matchId: Number.isInteger(x.matchId) ? x.matchId : null,
        });
        reviews.push({
          ...x,
          // Aucun horodatage client présenté comme une mise à jour fournisseur.
          updated: null,
          status: 'insufficient',
          realMoneyEligible: false,
          reasons: ['Événement absent de la réponse actuelle du fournisseur.'],
        });
        continue;
      }
      const e = { ...ev, reasons: [...ev.reasons] };
      if (Date.parse(e.kickoff) <= Date.now()) {
        e.status = 'reject';
        e.reasons.push('Match déjà commencé.');
      }
      if (Date.now() - Date.parse(e.updated) > POLICY.maxOddsAgeMs) {
        e.status = 'reject';
        e.reasons.push('Cote à actualiser.');
      }
      reviews.push(e);
      reviewedEvents.push(e);
    }
  }
  const verdict = proposing
    ? selections.length
      ? 'simulation_eligible'
      : 'insufficient'
    : blockers.length || reviews.some((x) => x.status === 'reject')
      ? 'reject'
      : reviews.some((x) => x.status === 'insufficient')
        ? 'insufficient'
        : 'simulation_eligible';
  const result = {
    verdict,
    marketCoupons,
    selections,
    reviews,
    blockers,
    scope,
    analyzed: reports.length,
    eligibleCount: preparedJob?.eligibleCount ?? (Number(body.eligibleCount) || reports.length),
    scanLimit: null,
    coverageComplete: !!preparedJob,
    jobId: preparedJob?.jobId || null,
    modelValidated: false,
    realMoneyEligible: false,
    policy: POLICY,
    generatedAt: new Date().toISOString(),
    combinedOdds: selections.length ? selections.reduce((p, x) => p * x.odd, 1) : null,
    combinedProbability: ticket?.ticketProbability ?? null,
    modelVersion: MODEL_VERSION,
    // Métadonnées du ticket calculées par le serveur (null hors proposition) : le LLM les
    // explique sans les recalculer, et le motif d'absence remplace un message générique.
    ticketProbability: ticket?.ticketProbability ?? null,
    ticketProbabilityExploratory: ticket?.ticketProbabilityExploratory ?? null,
    minTicketProbability: POLICY.minTicketProbability,
    excludedCandidates,
    excludedCandidatesCount,
    noTicketReason: ticket?.noTicketReason ?? null,
    risks: [
      'Modèle non validé hors échantillon.',
      'Le scénario prudent n’est pas un intervalle de confiance.',
      'La dépendance entre matchs n’est pas modélisée.',
    ],
  };
  const rejectedCount = reports.filter(
    (r) => !r.events.some((e) => e.status === 'simulation_eligible'),
  ).length;
  result.screening = {
    total: reports.length,
    rejected: rejectedCount,
    withCandidates: reports.length - rejectedCount,
    evaluatedEvents: reports.reduce((n, r) => n + (r.evaluatedEvents ?? r.events.length), 0),
  };
  result.blockers = result.blockers.slice(0, 20);
  // BIS-200 : valeur face au marché, descriptive. Rangée dans « market » racine, que
  // buildLlmInput retire : ni le LLM ni le ticket ne la voient.
  result.market = marketValueSummary(reports, {
    selection: selections,
    review: reviewedEvents,
    excluded: excludedEvents,
  });
  let explanation;
  try {
    explanation =
      // Sous le seuil, des candidats existaient : le LLM explique pourquoi aucun ticket.
      !selections.length && !reviews.length && result.noTicketReason !== BELOW_THRESHOLD_REASON
        ? {
            engine: 'statistics',
            summary:
              result.noTicketReason || 'Aucun coupon : aucun événement ne passe les filtres.',
          }
        : await llmExplanation(env, result);
  } catch {
    explanation = {
      engine: 'statistics',
      summary: statisticalSummary(result),
    };
  }
  // Sans explication du LLM, le motif d'absence calculé par le serveur reste le résumé.
  if (result.noTicketReason && explanation.engine !== 'llm')
    explanation = { ...explanation, summary: result.noTicketReason };
  const final = {
    ...result,
    ...explanation,
    risks: [...result.risks, ...(explanation.risks || [])],
  };
  if (proposing && env.BUCKET) {
    const record = {
      ...final,
      id: crypto.randomUUID(),
      outcomes: [],
      settled: false,
      marketCouponTracking: marketCouponObservations(marketCoupons, final.generatedAt),
    };
    await env.BUCKET.put(
      'observations/' + record.generatedAt.slice(0, 10) + '/' + record.id + '.json',
      JSON.stringify(record),
    );
    if (!scope.country && !scope.league && !scope.search)
      await env.BUCKET.put('latest/' + scope.date + '.json', JSON.stringify(record));
    final.saved = true;
  }
  return json(final);
}
