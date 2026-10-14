import { archiveOdds } from './odds-archive.js';
const memory = new Map(),
  pending = new Map();
let queue = Promise.resolve(),
  lastCall = 0,
  providerPausedUntil = 0;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// Compteurs du cache par isolat, en mémoire : aucune écriture R2 supplémentaire. Ils repartent
// de zéro à chaque nouvel isolat ; `since` indique leur début. Seul le chemin normalisé
// (point d'accès et noms de paramètres, sans valeurs) sert de clé, en nombre borné.
const METRIC_ROUTES = 64,
  METRIC_SEEN = 2000;
let metricsSince = new Date().toISOString();
const routeMetrics = new Map(),
  fetchedPaths = new Map();
export function normalizedPath(path) {
  const [endpoint, query = ''] = String(path).split('?');
  const names = [...new Set([...new URLSearchParams(query).keys()])].sort();
  return endpoint.replace(/\/\d+(?=\/|$)/g, '/:id') + (names.length ? '?' + names.join('&') : '');
}
function countMetric(path, field) {
  let route = normalizedPath(path);
  if (!routeMetrics.has(route) && routeMetrics.size >= METRIC_ROUTES) route = 'autres';
  let m = routeMetrics.get(route);
  if (!m)
    routeMetrics.set(
      route,
      (m = {
        memoryHits: 0,
        bucketHits: 0,
        inflightJoins: 0,
        misses: 0,
        requests: 0,
        duplicateRequests: 0,
        quotaRefusals: 0,
      }),
    );
  m[field]++;
}
function countRequest(path) {
  countMetric(path, 'requests');
  if (fetchedPaths.has(path)) countMetric(path, 'duplicateRequests');
  fetchedPaths.delete(path);
  fetchedPaths.set(path, true);
  if (fetchedPaths.size > METRIC_SEEN) fetchedPaths.delete(fetchedPaths.keys().next().value);
}
export function cacheMetrics() {
  const routes = Object.fromEntries(
    [...routeMetrics].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, { ...v }]),
  );
  const totals = {
    memoryHits: 0,
    bucketHits: 0,
    inflightJoins: 0,
    misses: 0,
    requests: 0,
    duplicateRequests: 0,
    quotaRefusals: 0,
  };
  for (const m of Object.values(routes)) for (const k in totals) totals[k] += m[k];
  const hits = totals.memoryHits + totals.bucketHits;
  return {
    scope: 'isolat',
    since: metricsSince,
    totals: {
      ...totals,
      hits,
      hitRate: hits + totals.misses ? hits / (hits + totals.misses) : null,
    },
    routes,
  };
}
export function resetCacheMetrics() {
  routeMetrics.clear();
  fetchedPaths.clear();
  metricsSince = new Date().toISOString();
}
const API_SPACING_MS = 6500;
export async function reserveProviderSlot(env, spacing = API_SPACING_MS) {
  if (!env.BUCKET) return Math.max(Date.now(), lastCall + spacing);
  for (let attempt = 0; attempt < 20; attempt++) {
    const obj = await env.BUCKET.get('api-control/next-slot.json');
    const next = obj ? (await obj.json()).next : 0;
    const slot = Math.max(Date.now(), Number(next) || 0);
    if (slot - Date.now() > 60000) {
      const error = limitError(Math.ceil((slot - Date.now()) / 1000));
      error.code = 'API_QUEUE_BUSY';
      throw error;
    }
    const onlyIf = obj ? { etagMatches: obj.etag } : new Headers({ 'If-None-Match': '*' });
    const written = await env.BUCKET.put(
      'api-control/next-slot.json',
      JSON.stringify({ next: slot + spacing }),
      { onlyIf },
    );
    if (written !== null) return slot;
    await pause(10 + Math.random() * 20);
  }
  const error = limitError(10);
  error.code = 'API_QUEUE_BUSY';
  throw error;
}
function paced(task, env) {
  const next = queue.then(async () => {
    const slot = await reserveProviderSlot(env);
    await pause(Math.max(0, slot - Date.now()));
    lastCall = Date.now();
    if (env.BUCKET) {
      const obj = await env.BUCKET.get('api-control/cooldown.json');
      if (obj) providerPausedUntil = Math.max(providerPausedUntil, (await obj.json()).until || 0);
    }
    if (providerPausedUntil > Date.now())
      throw limitError(Math.ceil((providerPausedUntil - Date.now()) / 1000));
    return task();
  });
  queue = next.catch(() => {});
  return next;
}

export function providerLimitSeconds(headers, now = Date.now()) {
  const after = headers.get('retry-after');
  const n = Number(after);
  if (after && Number.isFinite(n) && n >= 0) return Math.max(1, Math.min(300, Math.ceil(n)));
  const at = Date.parse(after || '');
  if (Number.isFinite(at)) return Math.max(1, Math.min(300, Math.ceil((at - now) / 1000)));
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > now / 1000)
    return Math.max(1, Math.min(300, Math.ceil(reset - now / 1000)));
  return 65;
}
function limitError(seconds, info = '') {
  const e = Error(
    'API-Football demande une pause de ' +
      seconds +
      ' seconde(s). La collecte reprendra sans perdre les pages déjà chargées.' +
      (info ? ' ' + info : ''),
  );
  e.code = 'API_RATE_LIMIT';
  e.status = 429;
  e.retryAfter = seconds;
  e.retryable = true;
  return e;
}
async function cacheKeyFor(path) {
  return (
    'api-cache/' +
    Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path))),
    )
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('') +
    '.json'
  );
}
async function markLimited(env, path, response, data) {
  const seconds = providerLimitSeconds(response.headers);
  providerPausedUntil = Date.now() + seconds * 1000;
  const diagnostic = {
    at: new Date().toISOString(),
    path,
    status: response.status,
    retryAfter: seconds,
    errors: Object.fromEntries(
      Object.entries(data?.errors || {}).map(([k, v]) => [
        k,
        String(v)
          .split(env.API_FOOTBALL_KEY)
          .join('[masqué]')
          .split(env.API_RELAY_TOKEN || '\0')
          .join('[masqué]')
          .slice(0, 400),
      ]),
    ),
    headers: Object.fromEntries(
      [
        'retry-after',
        'x-ratelimit-limit',
        'x-ratelimit-remaining',
        'x-ratelimit-reset',
        'x-ratelimit-requests-limit',
        'x-ratelimit-requests-remaining',
      ].map((k) => [k, response.headers.get(k)]),
    ),
  };
  if (env.BUCKET)
    try {
      await env.BUCKET.put(
        'api-control/cooldown.json',
        JSON.stringify({ until: providerPausedUntil }),
      );
      await env.BUCKET.put('api-control/last-limit.json', JSON.stringify(diagnostic));
    } catch {}
  throw limitError(seconds);
}
// Les IP de sortie partagées de l'hébergement peuvent être limitées par API-Football
// indépendamment du quota de l'abonnement. API_FOOTBALL_BASE_URL permet de passer par un
// relais à IP fixe (voir scripts/relay.mjs) sans changer le reste du code.
export function providerBase(env) {
  const base = String(env.API_FOOTBALL_BASE_URL || '').trim();
  if (!base) return 'https://v3.football.api-sports.io/';
  let u;
  try {
    u = new URL(base);
  } catch {
    throw Error('Adresse du relais invalide.');
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash)
    throw Error('Le relais doit utiliser HTTPS sans identifiant, requête ou fragment.');
  if (
    u.origin !== 'https://v3.football.api-sports.io' &&
    String(env.API_RELAY_TOKEN || '').length < 32
  )
    throw Error('API_RELAY_TOKEN doit contenir au moins 32 caractères pour un relais.');
  return u.href.endsWith('/') ? u.href : u.href + '/';
}
// Contexte d'exécution du Worker, porté par `env` jusqu'à api() sans changer les signatures des
// modules. Non énumérable : il n'apparaît dans aucune copie ni sérialisation de `env`.
const EXECUTION_CONTEXT = Symbol('executionContext');
export function withExecutionContext(env, ctx) {
  if (!env || typeof ctx?.waitUntil !== 'function') return env;
  return Object.create(env, { [EXECUTION_CONTEXT]: { value: ctx } });
}
// `waitUntil` garde le Worker en vie jusqu'à la fin de la tâche sans retarder la réponse.
// Sans contexte (tests, Node), la promesse est détachée et ses erreurs absorbées.
function inBackground(env, task) {
  const ctx = env?.[EXECUTION_CONTEXT];
  const settled = Promise.resolve(task).catch(() => {});
  if (ctx)
    try {
      ctx.waitUntil(settled);
    } catch {}
}
export async function api(env, path, ttl = 300000) {
  if (!env.API_FOOTBALL_KEY) throw Error('La connexion API reste à configurer.');
  const hit = memory.get(path);
  if (hit && Date.now() - hit.at < ttl) {
    countMetric(path, 'memoryHits');
    return hit.data;
  }
  const cacheKey = await cacheKeyFor(path);
  if (env.BUCKET)
    try {
      const obj = await env.BUCKET.get(cacheKey);
      if (obj) {
        const cached = await obj.json();
        if (Date.now() - cached.at < ttl) {
          memory.set(path, cached);
          countMetric(path, 'bucketHits');
          return cached.data;
        }
      }
    } catch {}
  countMetric(path, 'misses');
  if (pending.has(path)) {
    countMetric(path, 'inflightJoins');
    return pending.get(path);
  }
  const job = (async () => {
    if (env.BUCKET)
      try {
        const obj = await env.BUCKET.get('api-control/cooldown.json');
        if (obj) providerPausedUntil = Math.max(providerPausedUntil, (await obj.json()).until || 0);
      } catch {}
    if (providerPausedUntil > Date.now())
      throw limitError(Math.ceil((providerPausedUntil - Date.now()) / 1000));
    const base = providerBase(env);
    const relay = new URL(base).origin !== 'https://v3.football.api-sports.io';
    const r = await paced(() => {
      countRequest(path);
      return fetch(base + path, {
        headers: {
          'x-apisports-key': env.API_FOOTBALL_KEY,
          Accept: 'application/json',
          'User-Agent': 'FootScope/1.0',
          ...(relay ? { 'x-relay-token': env.API_RELAY_TOKEN } : {}),
        },
        cache: 'no-store',
        redirect: 'manual',
        signal: AbortSignal.timeout(20000),
      });
    }, env);
    if (r.status === 429) return markLimited(env, path, r, {});
    if (!r.ok) throw Error('Le fournisseur est indisponible (HTTP ' + r.status + ').');
    const d = await r.json();
    if (d.errors && Object.keys(d.errors).length) {
      const rate = Object.entries(d.errors).some(
        ([k, v]) => /rate|limit/i.test(k) && /minute|second|too many|rate/i.test(String(v)),
      );
      if (rate) return markLimited(env, path, r, d);
      const info = Object.entries(d.errors)
        .map(([k, v]) => k + ': ' + String(v))
        .join(' · ')
        .split(env.API_FOOTBALL_KEY)
        .join('[masqué]')
        .split(env.API_RELAY_TOKEN || '\0')
        .join('[masqué]')
        .slice(0, 700);
      throw Error('API-Football : ' + info);
    }
    const result = { ...d, retrievedAt: new Date().toISOString() };
    const cached = { at: Date.now(), data: result };
    memory.set(path, cached);
    if (env.BUCKET)
      try {
        await env.BUCKET.put(cacheKey, JSON.stringify(cached));
      } catch {}
    if (memory.size > 200) memory.delete(memory.keys().next().value);
    if (path.startsWith('fixtures?date='))
      for (const f of d.response || [])
        memory.set('fixtures?id=' + f.fixture.id, { at: Date.now(), data: { response: [f] } });
    // Réponse réellement reçue du fournisseur : seule entrée de l'archive des cotes (BIS-192).
    // L'écriture ne retarde jamais la réponse : elle continue en arrière-plan.
    inBackground(env, archiveOdds(env, path, result));
    return result;
  })();
  pending.set(path, job);
  job.catch((e) => {
    if (e?.code === 'API_RATE_LIMIT' || e?.code === 'API_QUEUE_BUSY')
      countMetric(path, 'quotaRefusals');
  });
  try {
    return await job;
  } finally {
    pending.delete(path);
  }
}

export function fixedDay(iso) {
  return new Date(Date.parse(iso) - 5 * 3600000).toISOString().slice(0, 10);
}
export async function fixturesForDay(env, date) {
  const next = new Date(Date.parse(date + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  const all = [];
  let retrievedAt;
  for (const day of [date, next]) {
    const d = await api(env, 'fixtures?date=' + day + '&timezone=Etc%2FGMT%2B5', 300000);
    all.push(...d.response);
    retrievedAt = d.retrievedAt;
  }
  const response = [
    ...new Map(
      all.filter((f) => fixedDay(f.fixture.date) === date).map((f) => [f.fixture.id, f]),
    ).values(),
  ];
  return { response, results: response.length, paging: { current: 1, total: 1 }, retrievedAt };
}
