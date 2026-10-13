import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRelayServer } from '../scripts/relay.mjs';
const token = 'x'.repeat(32);
const calls = [];
assert.throws(() => createRelayServer({ token: 'short' }));
const server = createRelayServer({
  token,
  fetchUpstream: async (url, init) => {
    calls.push({ url, init });
    if (url.includes('injuries')) throw Error('secret-internal-details');
    return new Response('{"response":[]}', {
      status: 429,
      headers: { 'retry-after': '91', 'x-ratelimit-remaining': '0' },
    });
  },
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = 'http://127.0.0.1:' + server.address().port;
const headers = { 'x-relay-token': token, 'x-apisports-key': 'mock-key' };
try {
  assert.equal((await fetch(base + '/status')).status, 401);
  assert.equal((await fetch(base + '/status', { headers, method: 'POST' })).status, 405);
  assert.equal((await fetch(base + '/players', { headers })).status, 404);
  assert.equal(
    (await fetch(base + '/status', { headers: { 'x-relay-token': token } })).status,
    400,
  );
  assert.equal(calls.length, 0, 'Rejected requests do not reach the provider');
  const r = await fetch(base + '/fixtures?team=4&last=10', { headers });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '91');
  assert.equal(r.headers.get('x-ratelimit-remaining'), '0');
  assert.equal(calls[0].url, 'https://v3.football.api-sports.io/fixtures?team=4&last=10');
  assert.equal(calls[0].init.headers['x-apisports-key'], 'mock-key');
  assert.equal(calls[0].init.headers['x-relay-token'], undefined);
  assert.equal(calls[0].init.redirect, 'error');
  const failed = await fetch(base + '/injuries?fixture=4', { headers });
  assert.equal(failed.status, 502);
  assert(!(await failed.text()).includes('secret-internal-details'));
} finally {
  await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}
console.log(
  'Passed: relay authentication, route restriction, no forwarding of relay token, 429 headers and sanitized failures.',
);
