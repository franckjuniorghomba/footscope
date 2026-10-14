import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setImmediate } from 'node:timers/promises';
const source = fs
  .readFileSync('dist/server/index.js', 'utf8')
  .replace(/(?:var|const) API_SPACING_MS\s*=\s*6500\s*;/, 'var API_SPACING_MS = 0;');
const w = (
  await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#cache')
).default;
const db = new Map();
let puts = 0;
const bucket = {
  get: async (key) =>
    db.has(key) ? { etag: 'e', json: async () => JSON.parse(db.get(key)) } : null,
  put: async (key, value) => {
    puts++;
    db.set(key, value);
    return {};
  },
};
const secret = 'mock-key-0123456789abcdef';
const env = { BUCKET: bucket, API_FOOTBALL_KEY: secret };
let requests = [],
  limited = false,
  fetchGate;
globalThis.fetch = async (url) => {
  requests.push(String(url));
  if (fetchGate) await fetchGate;
  if (limited)
    return Response.json({ errors: {} }, { status: 429, headers: { 'retry-after': '5' } });
  return Response.json({ response: { requests: { current: 1 } }, errors: {} });
};
const get = (path, init) => w.fetch(new Request('https://site' + path, init), env);
const diagnostics = async () => {
  const r = await get('/api/diagnostics');
  assert.equal(r.status, 200);
  const text = await r.text();
  assert(!text.includes(secret), 'Diagnostics must never expose the provider key');
  return JSON.parse(text).cache;
};

// Avant tout appel : compteurs vides, portée explicite.
let cache = await diagnostics();
assert.equal(cache.scope, 'isolat');
assert.equal(cache.totals.requests, 0);
assert.equal(cache.totals.hitRate, null);

// Deux appels identiques : 1 échec puis 1 succès de cache, 1 seule requête au fournisseur.
assert.equal((await get('/api/status')).status, 200);
assert.equal((await get('/api/status')).status, 200);
assert.equal(requests.length, 1);
cache = await diagnostics();
assert.deepEqual(cache.routes.status, {
  memoryHits: 1,
  bucketHits: 0,
  inflightJoins: 0,
  misses: 1,
  requests: 1,
  duplicateRequests: 0,
  quotaRefusals: 0,
});
assert.equal(cache.totals.hits, 1);
assert.equal(cache.totals.hitRate, 0.5);
const putsAfterStatus = puts;
await diagnostics();
assert.equal(puts, putsAfterStatus, 'Reading or counting metrics writes nothing to R2');

// Appels simultanés : un seul envoi, les autres rejoignent la requête en cours.
const day = '2026-10-14';
const { promise: gate, resolve: releaseFetch } = Promise.withResolvers();
fetchGate = gate;
const concurrent = [1, 2, 3].map(() => get('/api/odds?date=' + day + '&page=1'));
const oddsRoute = 'odds?date&page&timezone';
// La condition observée, et non un délai, décide quand libérer le fournisseur.
// Le délai maximal sert seulement à faire échouer un rattachement manquant.
const deadline = performance.now() + 5000;
try {
  while ((await diagnostics()).routes[oddsRoute]?.inflightJoins !== 2) {
    assert(performance.now() < deadline, 'Both callers must join the held provider request');
    await setImmediate();
  }
} finally {
  releaseFetch();
  fetchGate = undefined;
}
assert.deepEqual(
  (await Promise.all(concurrent)).map((r) => r.status),
  [200, 200, 200],
);
assert.equal(requests.length, 2);
cache = await diagnostics();
assert.equal(cache.routes[oddsRoute].misses, 3);
assert.equal(cache.routes[oddsRoute].inflightJoins, 2);
assert.equal(cache.routes[oddsRoute].requests, 1);

// Chemin normalisé : ni valeur de paramètre, ni identifiant dans les clés exposées.
assert(!JSON.stringify(cache.routes).includes(day));
assert.deepEqual(Object.keys(cache.routes).sort(), [oddsRoute, 'status']);

// Lecture depuis R2 (autre isolat) : succès de cache R2, sans requête.
const path = 'odds?date=2026-10-15&timezone=Etc%2FGMT%2B5&page=2';
const key =
  'api-cache/' +
  Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path))).toString(
    'hex',
  ) +
  '.json';
db.set(key, JSON.stringify({ at: Date.now(), data: { response: [], errors: {} } }));
assert.equal((await get('/api/odds?date=2026-10-15&page=2')).status, 200);
assert.equal(requests.length, 2);
assert.equal((await diagnostics()).routes[oddsRoute].bucketHits, 1);

// Expiration du cache puis nouvel envoi du même chemin : requête dupliquée identifiée.
const realNow = Date.now;
Date.now = () => realNow() + 61000;
assert.equal((await get('/api/status')).status, 200);
Date.now = realNow;
db.delete('api-control/next-slot.json'); // créneau réservé dans le futur simulé
assert.equal(requests.length, 3);
cache = await diagnostics();
assert.equal(cache.routes.status.requests, 2);
assert.equal(cache.routes.status.duplicateRequests, 1);

// Refus pour quota : la réponse 429 puis la pause locale sont comptées ; la pause n'envoie rien.
limited = true;
assert.equal((await get('/api/odds?date=2026-10-16&page=1')).status, 429);
assert.equal(requests.length, 4);
assert.equal((await get('/api/odds?date=2026-10-17&page=1')).status, 429);
assert.equal(requests.length, 4, 'The shared pause still blocks before sending');
cache = await diagnostics();
assert.equal(cache.routes[oddsRoute].quotaRefusals, 2);
assert.equal(cache.totals.quotaRefusals, 2);
assert.equal(cache.totals.requests, 4);

// Méthode refusée sur la route de diagnostic.
assert.equal((await get('/api/diagnostics', { method: 'POST' })).status, 405);
assert(requests.every((u) => !u.includes(secret)));

// Isolat fournisseur distinct : inspection de la seule map privée nécessaire pour
// prouver la borne mémoire, sans ajouter d'export au code de production.
const providerSource =
  fs
    .readFileSync('src/server/provider.js', 'utf8')
    .replace('const API_SPACING_MS = 6500;', 'const API_SPACING_MS = 0;')
    // Une URL data n'a pas de base : l'import relatif de l'archive des cotes devient absolu.
    .replace(
      "'./odds-archive.js'",
      JSON.stringify(import.meta.resolve('../src/server/odds-archive.js')),
    ) + '\nexport { fetchedPaths };';
const freshProvider = (tag) =>
  import(
    'data:text/javascript;base64,' + Buffer.from(providerSource).toString('base64') + '#' + tag
  );
const bounded = await freshProvider('bounds');
limited = false;
requests = [];
const exactPath = (i) => 'route' + i + '?team=private-value&key=' + secret;
for (let i = 0; i < 2001; i++) {
  await bounded.api({ API_FOOTBALL_KEY: secret }, exactPath(i), 0);
  assert(bounded.fetchedPaths.size <= 2000, 'Exact-path tracking must remain bounded');
  if (i === 63) {
    assert.equal(Object.keys(bounded.cacheMetrics().routes).length, 64);
    assert(!('autres' in bounded.cacheMetrics().routes));
  }
  if (i === 64) {
    assert.equal(Object.keys(bounded.cacheMetrics().routes).length, 65);
    assert.equal(bounded.cacheMetrics().routes.autres.requests, 1);
  }
}
cache = bounded.cacheMetrics();
assert.equal(Object.keys(cache.routes).length, 65);
assert.equal(cache.routes.autres.requests, 1937);
assert.equal(cache.totals.requests, 2001);
assert.equal(requests.length, 2001);
assert.equal(bounded.fetchedPaths.size, 2000);
assert(!bounded.fetchedPaths.has(exactPath(0)), 'Oldest exact path must be evicted');
assert(!JSON.stringify(cache).includes(secret));
assert(!JSON.stringify(cache).includes('private-value'));
await bounded.api({ API_FOOTBALL_KEY: secret }, exactPath(1), 0);
assert.equal(bounded.cacheMetrics().totals.duplicateRequests, 1, 'Retained path is detected');
assert(bounded.fetchedPaths.has(exactPath(1)), 'A repeated path refreshes its tracking position');
await bounded.api({ API_FOOTBALL_KEY: secret }, exactPath(0), 0);
assert.equal(
  bounded.cacheMetrics().totals.duplicateRequests,
  1,
  'Evicted path is outside the window',
);
assert.equal(bounded.fetchedPaths.size, 2000);

// File partagée saturée : erreur typée, aucun envoi ni écriture, un seul refus.
const busy = await freshProvider('queue-busy');
requests = [];
const busyEnv = {
  API_FOOTBALL_KEY: secret,
  BUCKET: {
    get: async (key) =>
      key === 'api-control/next-slot.json'
        ? { etag: 'busy', json: async () => ({ next: Date.now() + 120000 }) }
        : null,
    put: async () => assert.fail('A busy queue must not write to R2'),
  },
};
await assert.rejects(busy.api(busyEnv, 'status'), (error) => {
  assert.equal(error.code, 'API_QUEUE_BUSY');
  assert.equal(error.status, 429);
  assert.equal(error.retryable, true);
  return true;
});
assert.equal(requests.length, 0);
cache = busy.cacheMetrics();
assert.equal(cache.totals.requests, 0);
assert.equal(cache.totals.misses, 1);
assert.equal(cache.totals.quotaRefusals, 1);

console.log(
  'Passed: cache metrics (miss then hit with one provider request, in-flight joins, R2 hits, duplicate detection, quota refusals, normalized paths, no secret, no R2 write, POST refused, 64 routes + autres, 2000 exact paths, queue busy).',
);
