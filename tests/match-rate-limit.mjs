import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs
  .readFileSync('dist/server/index.js', 'utf8')
  .replace(/(?:var|const) API_SPACING_MS\s*=\s*6500\s*;/, 'var API_SPACING_MS = 0;');
const load = (s) =>
  import('data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#' + s);

// 1. Une pause du fournisseur au milieu d'une fiche renvoie 429, pas une fiche vide en 200.
{
  const worker = (await load('match')).default;
  const env = { API_FOOTBALL_KEY: 'fake-secret' };
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).includes('fixtures?id='))
      return Response.json({
        errors: [],
        response: [
          {
            fixture: { id: 7, timestamp: 2000000000, date: '2033-05-18T00:00:00Z' },
            teams: { home: { id: 1 }, away: { id: 2 } },
          },
        ],
      });
    return Response.json({ errors: { rateLimit: 'Too many requests per minute.' }, response: [] });
  };
  const r = await worker.fetch(new Request('https://site/api/match?id=7'), env);
  assert.equal(r.status, 429, 'Partial match sheet must not be reported as complete');
  assert.equal(r.headers.get('retry-after') !== null, true);
  const d = await r.json();
  assert.equal(d.code, 'API_RATE_LIMIT');
  assert.equal(d.retryable, true);
  assert.deepEqual(d.missing, ['home', 'away', 'injuries', 'lineups', 'odds']);
  assert.equal(urls.length, 2, 'Stop calling the provider once it asked for a pause');
  assert(!JSON.stringify(d).includes('fake-secret'));
}

// 2. Relais à IP fixe : base configurable, HTTPS obligatoire, jeton transmis.
{
  const mod = await load('relay');
  assert.equal(mod.providerBase({}), 'https://v3.football.api-sports.io/');
  assert.equal(
    mod.providerBase({
      API_FOOTBALL_BASE_URL: 'https://relay.example',
      API_RELAY_TOKEN: 'x'.repeat(32),
    }),
    'https://relay.example/',
  );
  assert.throws(() => mod.providerBase({ API_FOOTBALL_BASE_URL: 'http://relay.example' }));
  for (const base of [
    'https://relay.example/?key=x',
    'https://user:secret@relay.example/',
    'https://relay.example/#x',
    'bad-url',
  ]) {
    assert.throws(() =>
      mod.providerBase({ API_FOOTBALL_BASE_URL: base, API_RELAY_TOKEN: 'x'.repeat(32) }),
    );
  }
  assert.throws(() => mod.providerBase({ API_FOOTBALL_BASE_URL: 'https://relay.example/' }));
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), headers: init.headers, redirect: init.redirect };
    return Response.json({ errors: [], response: { subscription: { plan: 'Pro' } } });
  };
  const env = {
    API_FOOTBALL_KEY: 'fake-secret',
    API_FOOTBALL_BASE_URL: 'https://relay.example/',
    API_RELAY_TOKEN: 'x'.repeat(32),
  };
  const r = await mod.default.fetch(new Request('https://site/api/status'), env);
  assert.equal(r.status, 200);
  assert.equal(seen.url, 'https://relay.example/status');
  assert.equal(seen.headers['x-relay-token'], 'x'.repeat(32));
  assert.equal(seen.redirect, 'error');
}
console.log(
  'Passed: honest 429 on partial match sheet, provider stop after pause, fixed-IP relay base and token.',
);
