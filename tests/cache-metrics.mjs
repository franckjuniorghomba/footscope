import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  limited = false;
globalThis.fetch = async (url) => {
  requests.push(String(url));
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
await Promise.all([1, 2, 3].map(() => get('/api/odds?date=' + day + '&page=1')));
assert.equal(requests.length, 2);
cache = await diagnostics();
const oddsRoute = 'odds?date&page&timezone';
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

console.log(
  'Passed: cache metrics (miss then hit with one provider request, in-flight joins, R2 hits, duplicate detection, quota refusals, normalized paths, no secret, no R2 write, POST refused).',
);
