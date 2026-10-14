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
