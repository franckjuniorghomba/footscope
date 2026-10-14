import assert from 'node:assert/strict';
const realNow = Date.now;
const realTimeout = globalThis.setTimeout;
let now = 1800000000000;
Date.now = () => now;
const timers = [];
let pumping = false;
globalThis.setTimeout = (callback, delay = 0) => {
  timers.push({ at: now + delay, callback });
  if (!pumping) {
    pumping = true;
    setImmediate(function pump() {
      timers.sort((a, b) => a.at - b.at);
      const timer = timers.shift();
      if (!timer) {
        pumping = false;
        return;
      }
      now = Math.max(now, timer.at);
      timer.callback();
      setImmediate(pump);
    });
  }
};
const load = (name) => import('../src/server/provider.js?' + name);
const pro = {
  'x-ratelimit-limit': '300',
  'x-ratelimit-requests-limit': '7500',
  'x-ratelimit-requests-remaining': '7000',
};
function bucket() {
  const db = new Map();
  let revision = 0;
  return {
    db,
    async get(key) {
      const entry = db.get(key);
      return entry ? { etag: entry.etag, json: async () => JSON.parse(entry.value) } : null;
    },
    async put(key, value, options = {}) {
      const entry = db.get(key);
      const condition = options.onlyIf;
      if (condition?.etagMatches && condition.etagMatches !== entry?.etag) return null;
      if (condition instanceof Headers && condition.get('If-None-Match') === '*' && entry)
        return null;
      const written = { etag: String(++revision), value };
      db.set(key, written);
      return written;
    },
  };
}
const times = [];
let headers = pro;
let refusal = null;
globalThis.fetch = async () => {
  times.push(now);
  return Response.json(
    { response: [], errors: refusal === 'body' ? { rateLimit: 'quota exceeded' } : {} },
    { status: refusal === 'http' ? 429 : 200, headers: { ...headers, 'retry-after': '1' } },
  );
};
try {
  for (const shared of [false, true]) {
    const provider = await load('nominal-' + shared);
    const env = { API_FOOTBALL_KEY: 'fixture', ...(shared ? { BUCKET: bucket() } : {}) };
    times.length = 0;
    headers = pro;
    for (let i = 0; i < 20; i++) await provider.api(env, 'status?n=' + i, 0);
    const elapsed = times.at(-1) - times[0];
    assert.equal(elapsed, shared ? 6500 + 18 * 334 : 19 * 334);
    assert(times.slice(2).every((t, i) => t - times[i + 1] >= 334));
    console.log(
      `20 requests (${shared ? 'R2' : 'local'}): before 123500 ms, after ${elapsed} ms; Requests: ${times.length}`,
    );
    const metrics = provider.cacheMetrics();
    await provider.api(env, 'status?cached=yes');
    await provider.api(env, 'status?cached=yes');
    assert.equal(provider.cacheMetrics().totals.requests, metrics.totals.requests + 1);
    assert.equal(provider.cacheMetrics().totals.memoryHits, 1);
    for (const invalid of [
      {},
      { ...pro, 'x-ratelimit-limit': '-300' },
      { ...pro, 'x-ratelimit-limit': 'Infinity' },
      { ...pro, 'x-ratelimit-limit': '1000000000000000' },
      { ...pro, 'x-ratelimit-limit': '7501' },
      { ...pro, 'x-ratelimit-requests-remaining': '7501' },
      { ...pro, 'x-ratelimit-requests-limit': '' },
    ]) {
      headers = invalid;
      await provider.api(env, 'status?invalid=' + times.length, 0);
      const previous = times.at(-1);
      await provider.api(env, 'status?fallback=' + times.length, 0);
      assert(times.at(-1) - previous >= 6500);
    }
  }
  for (const type of ['http', 'body']) {
    const provider = await load('refusal-' + type);
    const env = { API_FOOTBALL_KEY: 'fixture', BUCKET: bucket() };
    headers = pro;
    await provider.api(env, 'status?warm=' + type, 0);
    refusal = type;
    await assert.rejects(provider.api(env, 'status?denied=' + type, 0), {
      code: 'API_RATE_LIMIT',
      status: 429,
    });
    const refusedAt = now;
    const count = times.length;
    await assert.rejects(provider.api(env, 'status?cooldown=' + type, 0), {
      code: 'API_RATE_LIMIT',
    });
    assert.equal(times.length, count);
    const state = JSON.parse(env.BUCKET.db.get('api-control/next-slot.json').value);
    assert.equal(state.spacing, 6500);
    now += 1001;
    refusal = null;
    await provider.api(env, 'status?resume=' + type, 0);
    assert(times.at(-1) - refusedAt >= 6500);
    assert.equal(provider.cacheMetrics().totals.quotaRefusals, 2);
  }
  // Une panne d'observation survient APRÈS la réservation et la réponse payante.
  // Les erreurs R2 sont volontairement sensibles : aucun contenu ne doit être journalisé.
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    for (const fault of ['put', 'get', 'cas']) {
      for (const outcome of ['http', 'body', 'body-missing', 'http-error', 'success', 'missing']) {
        const client = await load(`observation-failure-${fault}-${outcome}`);
        const storage = bucket();
        const originalPut = storage.put.bind(storage);
        const originalGet = storage.get.bind(storage);
        const operations = [];
        let armed = false;
        let observationAttempts = 0;
        storage.get = async (key) => {
          if (armed && key === 'api-control/next-slot.json' && fault === 'get')
            throw Error('private-provider-key private-relay-token private-person');
          return originalGet(key);
        };
        storage.put = async (key, value, options) => {
          operations.push(key);
          if (armed && key === 'api-control/next-slot.json') {
            observationAttempts++;
            if (fault === 'put')
              throw Error('private-provider-key private-relay-token private-person');
            if (fault === 'cas') return null;
          }
          return originalPut(key, value, options);
        };
        const env = {
          API_FOOTBALL_KEY: 'private-provider-key',
          API_RELAY_TOKEN: 'private-relay-token',
          BUCKET: storage,
        };
        let requests = 0;
        globalThis.fetch = async () => {
          requests++;
          armed = true;
          return Response.json(
            {
              response: [{ fixture: { id: 216 } }],
              errors: outcome.startsWith('body') ? { rateLimit: 'quota exceeded' } : {},
            },
            {
              status: outcome === 'http' ? 429 : outcome === 'http-error' ? 503 : 200,
              headers: {
                ...(outcome.includes('missing') ? {} : pro),
                'retry-after': '30',
              },
            },
          );
        };
        const path = 'status?person=private-person';
        if (['http', 'body', 'body-missing'].includes(outcome)) {
          await assert.rejects(client.api(env, path), {
            code: 'API_RATE_LIMIT',
            status: 429,
            retryAfter: 30,
            retryable: true,
          });
          const cooldown = JSON.parse(storage.db.get('api-control/cooldown.json').value);
          assert(cooldown.until > now);
          if (fault !== 'get')
            assert(
              operations.indexOf('api-control/cooldown.json') <
                operations.lastIndexOf('api-control/next-slot.json'),
            );
          assert.equal(client.cacheMetrics().totals.quotaRefusals, 1);
          const peer = await load(`pause-peer-${fault}-${outcome}`);
          await assert.rejects(peer.api(env, 'status?peer=1'), { code: 'API_RATE_LIMIT' });
          storage.db.delete('api-control/cooldown.json');
          await assert.rejects(client.api(env, 'status?local=1'), { code: 'API_RATE_LIMIT' });
          assert.equal(requests, 1, 'Pauses locale et partagée empêchent les appels suivants');
        } else if (outcome === 'http-error') {
          await assert.rejects(client.api(env, path), /HTTP 503/);
          assert.equal(client.cacheMetrics().totals.quotaRefusals, 0);
        } else {
          const result = await client.api(env, path);
          assert.equal(result.response[0].fixture.id, 216);
          assert.equal(await client.api(env, path), result, 'La réponse réussie reste en cache');
          assert.equal(requests, 1);
          assert([...storage.db.keys()].some((key) => key.startsWith('api-cache/')));
          assert.equal(client.cacheMetrics().totals.quotaRefusals, 0);
        }
        assert.equal(client.cacheMetrics().totals.spacingObservationFailures, 1);
        assert.equal(observationAttempts, fault === 'cas' ? 20 : fault === 'put' ? 1 : 0);
        client.resetCacheMetrics();
        assert.equal(client.cacheMetrics().totals.spacingObservationFailures, 0);
      }
    }
    assert.equal(warnings.length, 18);
    assert(
      warnings.every(
        (args) =>
          args.length === 1 && args[0] === 'Observation de cadence fournisseur non partagée (R2).',
      ),
    );
    console.log(
      'Passed: observation put/get/CAS failures preserve shared/local pauses, typed refusals, HTTP errors and successful cached responses; diagnostics contain no secrets or personal data.',
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
  const provider = await load('daily');
  const env = { API_FOOTBALL_KEY: 'fixture', BUCKET: bucket() };
  headers = { ...pro, 'x-ratelimit-requests-remaining': '374' };
  await provider.api(env, 'status?daily=1', 0);
  const before = now;
  await provider.api(env, 'status?daily=2', 0);
  assert(now - before >= 60000);
  headers = { ...pro, 'x-ratelimit-requests-remaining': '375' };
  await provider.api(env, 'status?daily=boundary', 0);
  assert.equal(JSON.parse(env.BUCKET.db.get('api-control/next-slot.json').value).spacing, 334);
  headers = { ...pro, 'x-ratelimit-limit': '10' };
  await provider.api(env, 'status?small=1', 0);
  assert.equal(JSON.parse(env.BUCKET.db.get('api-control/next-slot.json').value).spacing, 8572);

  const shared = bucket();
  const clients = await Promise.all(Array.from({ length: 4 }, (_, i) => load('client-' + i)));
  headers = pro;
  await clients[0].api({ API_FOOTBALL_KEY: 'fixture', BUCKET: shared }, 'status?warm=clients', 0);
  times.length = 0;
  await Promise.all(
    clients.flatMap((client, i) =>
      Array.from({ length: 5 }, (_, j) =>
        client.api({ API_FOOTBALL_KEY: 'fixture', BUCKET: shared }, `status?client=${i}&n=${j}`, 0),
      ),
    ),
  );
  assert.equal(times.length, 20);
  const sorted = [...times].sort((a, b) => a - b);
  assert(sorted.slice(1).every((t, i) => t - sorted[i] >= 334));
  for (const start of sorted)
    assert(sorted.filter((t) => t >= start && t < start + 1000).length <= 3);
  // Les créneaux rapides déjà réservés doivent être repoussés si les en-têtes disparaissent.
  headers = {};
  times.length = 0;
  await Promise.all(
    clients.map((client, i) =>
      client.api({ API_FOOTBALL_KEY: 'fixture', BUCKET: shared }, `status?missing=${i}`, 0),
    ),
  );
  const slowed = [...times].sort((a, b) => a - b);
  assert(slowed.slice(1).every((t, i) => t - slowed[i] >= 6500));
  headers = pro;
  await clients[0].api({ API_FOOTBALL_KEY: 'fixture', BUCKET: shared }, 'status?rewarm=1', 0);
  now += 60001;
  await clients[1].reserveProviderSlot({ BUCKET: shared });
  assert.equal(JSON.parse(shared.db.get('api-control/next-slot.json').value).next - now, 6500);
  console.log(
    'Passed: adaptive pacing, malformed/missing headers, daily quota boundary, HTTP/body refusals, cache metrics, R2 CAS and four simultaneous isolates below 3/s, expired observations. No real requests.',
  );
} finally {
  Date.now = realNow;
  globalThis.setTimeout = realTimeout;
}
