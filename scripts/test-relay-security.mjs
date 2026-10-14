// Test HTTPS local : le vrai Caddy et le relais, fournisseur entièrement simulé.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { createRelayServer } from './relay.mjs';

const caddy = process.env.CADDY_BIN || 'caddy';
assert.match(execFileSync(caddy, ['version'], { encoding: 'utf8' }), /^v2\.10\.2\b/);
const work = await mkdtemp(join(tmpdir(), 'relay-security-'));
const token = 'FICTIONAL-RELAY-TOKEN-ONLY-000000000000';
const key = 'FICTIONAL-APISPORTS-KEY-ONLY-000000000';
const relay = createRelayServer({
  token,
  fetchUpstream: async (_url, options) => {
    assert.equal(options.headers['x-apisports-key'], key);
    return new Response('{"fixture":true}', { status: 200 });
  },
});
let child;
let stdout = '';
let stderr = '';
try {
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  const upstream = relay.address().port;
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  // Seuls l'adresse du site, le dial et la PKI sont adaptés au test local.
  let config = await readFile(resolve(process.argv[2] || 'deploy/relay/Caddyfile'), 'utf8');
  if (!config.startsWith('{\n')) config = '{\n}\n' + config;
  config = config.replace('{\n', '{\n    auto_https disable_redirects\n    skip_install_trust\n');
  config = config.replace(
    '{$RELAY_DOMAIN} {',
    `https://localhost:${port} {\n    bind 127.0.0.1\n    tls internal`,
  );
  config = config.replace('relay:8787', `127.0.0.1:${upstream}`);
  await writeFile(join(work, 'Caddyfile'), config);
  child = spawn(caddy, ['run', '--config', join(work, 'Caddyfile'), '--adapter', 'caddyfile'], {
    env: { ...process.env, XDG_DATA_HOME: work, XDG_CONFIG_HOME: work },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => (stdout += data));
  child.stderr.on('data', (data) => (stderr += data));
  const request = (path, headers = {}) =>
    new Promise((done, fail) => {
      const req = https.get(
        {
          hostname: 'localhost',
          port,
          family: 4,
          path,
          // Uniquement pour la PKI éphémère du test sur loopback.
          rejectUnauthorized: false,
          headers: { 'x-relay-token': token, 'x-apisports-key': key, ...headers },
        },
        (res) => {
          let body = '';
          res.on('data', (data) => (body += data));
          res.on('end', () => done({ status: res.statusCode, headers: res.headers, body }));
        },
      );
      req.setTimeout(2000, () => req.destroy(Error('Timeout HTTPS local')));
      req.on('error', fail);
    });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error('Caddy arrêté avant le test');
    try {
      await request('/health');
      ready = true;
      break;
    } catch {
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  assert.ok(ready, 'Caddy doit démarrer');
  const responses = [
    [await request('/status'), 200],
    [await request('/status', { 'x-relay-token': 'FICTIONAL-INVALID-TOKEN' }), 401],
    [await request('/unknown'), 404],
  ];
  await new Promise((done) => relay.close(done));
  responses.push([await request('/status'), 502]);
  child.kill('SIGTERM');
  await once(child, 'close');
  child = null;
  const logs = stdout + stderr;
  for (const value of [token, key, 'FICTIONAL-INVALID-TOKEN']) {
    assert.ok(!logs.includes(value), 'Une valeur fictive a fui dans les journaux Caddy');
  }
  if (process.env.RELAY_TEST_LOGS) await writeFile(process.env.RELAY_TEST_LOGS, logs);
  const entries = logs
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(
    entries.some((e) => e.logger?.startsWith('http.log.error') && e.status === 502),
    'Erreur 502 journalisée',
  );
  for (const [response, status] of responses) {
    assert.equal(response.status, status);
    assert.equal(
      response.headers['strict-transport-security'],
      'max-age=31536000',
      `HSTS sur ${status}`,
    );
    assert.ok(
      entries.some((e) => e.logger?.startsWith('http.log.access') && e.status === status),
      `Accès ${status} journalisé`,
    );
  }
  assert.equal(responses[0][0].body, '{"fixture":true}');
  console.log(
    'PASS : 0 fuite ; journaux erreur/accès présents ; HSTS sur 200/401/404/502 ; clé transmise au fournisseur simulé.',
  );
} finally {
  if (child) {
    child.kill('SIGTERM');
    await once(child, 'close');
  }
  if (relay.listening) await new Promise((done) => relay.close(done));
  await rm(work, { recursive: true, force: true });
}
