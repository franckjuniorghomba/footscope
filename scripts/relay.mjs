// Relais à IP fixe. HTTPS doit être fourni par le reverse proxy devant ce serveur.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const UPSTREAM = 'https://v3.football.api-sports.io/';
const ALLOWED = new Set(['/status', '/fixtures', '/fixtures/lineups', '/odds', '/injuries']);
const FORWARDED_HEADERS = [
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ratelimit-requests-limit',
  'x-ratelimit-requests-remaining',
];
export function createRelayServer({ token, fetchUpstream = fetch }) {
  if (typeof token !== 'string' || token.length < 32)
    throw Error('RELAY_TOKEN doit contenir au moins 32 caractères.');
  const expected = Buffer.from(token);
  return http.createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...headers,
      });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') return send(200, { ready: true });
    if (req.method !== 'GET')
      return send(405, { error: 'Méthode non autorisée' }, { Allow: 'GET' });
    const supplied = Buffer.from(String(req.headers['x-relay-token'] || ''));
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return send(401, { error: 'Non autorisé' });
    // Accepte exclusivement ces routes, sans URL absolue ni redirection vers une autre origine.
    const raw = req.url || '';
    if (!ALLOWED.has(raw.split('?')[0])) return send(404, { error: 'Route inconnue' });
    const key = req.headers['x-apisports-key'];
    if (!key) return send(400, { error: 'Clé manquante' });
    try {
      const r = await fetchUpstream(UPSTREAM + raw.slice(1), {
        headers: { 'x-apisports-key': key, Accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
        redirect: 'error',
      });
      const headers = {};
      for (const h of FORWARDED_HEADERS) {
        const v = r.headers.get(h);
        if (v !== null) headers[h] = v;
      }
      send(r.status, await r.text(), headers);
    } catch {
      send(502, { error: 'Fournisseur injoignable depuis le relais' });
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT invalide.');
  const host = process.env.RELAY_BIND_ADDRESS || '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0'].includes(host)) throw Error('Adresse d’écoute invalide.');
  createRelayServer({ token: process.env.RELAY_TOKEN }).listen(port, host, () =>
    console.log('Relais API-Football sur le port ' + port),
  );
}
