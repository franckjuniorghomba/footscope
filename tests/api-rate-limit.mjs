import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs
  .readFileSync('dist/server/index.js', 'utf8')
  .replace(/(?:var|const) API_SPACING_MS\s*=\s*6500\s*;/, 'var API_SPACING_MS = 0;');
const load = (s) =>
  import('data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#' + s);
const first = await load('a');
assert.equal(first.providerLimitSeconds(new Headers({ 'Retry-After': '75' })), 75);
assert.equal(first.providerLimitSeconds(new Headers()), 65);
assert.equal(
  first.providerLimitSeconds(
    new Headers({ 'Retry-After': new Date(Date.now() + 60000).toUTCString() }),
  ),
  60,
);
const objects = new Map();
const bucket = {
  get: async (k) => (objects.has(k) ? { json: async () => JSON.parse(objects.get(k)) } : null),
  put: async (k, v) => objects.set(k, v),
};
const env = { BUCKET: bucket, API_FOOTBALL_KEY: 'fake-secret' };
let calls = 0;
globalThis.fetch = async () => {
  calls++;
  return Response.json(
    { errors: { rateLimit: 'Too many requests per minute. fake-secret' }, response: [] },
    { headers: { 'Retry-After': '65', 'x-ratelimit-limit': '300', 'x-ratelimit-remaining': '0' } },
  );
};
const request = () => new Request('https://site/api/status');
const a = await first.default.fetch(request(), env);
assert.equal(a.status, 429);
const detail = await a.json();
assert.equal(detail.code, 'API_RATE_LIMIT');
assert.equal(detail.retryAfter, 65);
assert.equal(detail.retryable, true);
assert.equal(calls, 1, 'Do not issue three immediate retries');
assert(
  !JSON.stringify([...objects.values()]).includes('fake-secret'),
  'Never persist key in diagnostic',
);
const second = await load('b');
const b = await second.default.fetch(request(), env);
assert.equal(b.status, 429);
assert.equal(calls, 1, 'Another isolate must honor the shared cooldown');
const diagnostic = await (
  await first.default.fetch(new Request('https://site/api/diagnostics'), env)
).json();
assert.equal(diagnostic.lastLimit.headers['x-ratelimit-limit'], '300');
assert.equal(diagnostic.lastLimit.errors.rateLimit, 'Too many requests per minute. [masqué]');
const cacheKey =
  'api-cache/' +
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('status'))),
  )
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('') +
  '.json';
objects.set(
  cacheKey,
  JSON.stringify({
    at: Date.now(),
    data: {
      response: { subscription: { plan: 'Pro', active: true }, requests: { limit_day: 7500 } },
      retrievedAt: new Date().toISOString(),
    },
  }),
);
const c = await second.default.fetch(request(), env);
assert.equal(c.status, 200);
assert.equal(calls, 1, 'Fresh cached data remains available during cooldown');
console.log(
  'Passed: provider Retry-After, one request per rate error, shared cooldown across isolates, cached data availability, precise status and secret-redacted diagnostics.',
);
