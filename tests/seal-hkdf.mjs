import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync('dist/server/index.js', 'utf8');
const module = await import(
  'data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#seal'
);
const w = module.default;
const env = { API_FOOTBALL_KEY: 'mock-key' };
const enc = (s) => new TextEncoder().encode(s);
const hex = (buf) => Buffer.from(buf).toString('hex');
async function hmac(key, payload) {
  return hex(await crypto.subtle.sign('HMAC', key, enc(payload)));
}
async function rawKey(secret) {
  return crypto.subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
}
async function hkdfKey(secret) {
  const ikm = await crypto.subtle.importKey('raw', enc(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: enc('footscope/seal/salt/v1'),
      info: enc('footscope-seal-v1'),
    },
    ikm,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
}
const kickoff = new Date(Date.now() + 3 * 3600000).toISOString();
const report = {
  matchId: 7,
  match: 'Home - Away',
  kickoff,
  events: [],
  common: [],
};
const payloadFor = (expires) => JSON.stringify({ report, expires });
const review = (token, e = env) =>
  w.fetch(
    new Request('https://footscope.test/api/assistant/review', {
      method: 'POST',
      body: JSON.stringify({
        tokens: [token],
        selections: [{ matchId: 7, market: 'x', selection: 'y', bookmaker: 'b' }],
      }),
    }),
    e,
  );
async function refused(token, message, e = env) {
  const r = await review(token, e);
  // Refus prévu : réponse JSON du gestionnaire d'erreurs (502, contrat de decision-engine.mjs).
  assert.equal(r.status, 502, 'Refus attendu : ' + message);
  assert.match((await r.json()).error, message);
}

// Jeton signé avec la clé dérivée par HKDF : accepté.
const payload = payloadFor(Date.now() + 600000);
const valid = { payload, signature: await hmac(await hkdfKey('mock-key'), payload) };
const ok = await review(valid);
assert.equal(ok.status, 200);
const body = await ok.json();
assert.equal(body.analyzed, 1);
assert.equal(body.realMoneyEligible, false);

// Un octet modifié dans la charge utile : refusé.
await refused(
  { ...valid, payload: valid.payload.replace('"matchId":7', '"matchId":8') },
  /altérée/,
);
// Un octet modifié dans la signature : refusé.
const flipped = (valid.signature[0] === '0' ? '1' : '0') + valid.signature.slice(1);
await refused({ ...valid, signature: flipped }, /altérée/);
// Signature mal formée (hex invalide, longueur) : refusée proprement.
await refused({ ...valid, signature: 'zz' + valid.signature.slice(2) }, /altérée/);
await refused({ ...valid, signature: valid.signature.slice(2) }, /altérée/);
await refused({ payload }, /altérée/);
// Ancien format (HMAC avec la clé fournisseur brute) : refusé.
await refused({ payload, signature: await hmac(await rawKey('mock-key'), payload) }, /altérée/);
// Clé fournisseur différente : refusé.
await refused({ payload, signature: await hmac(await hkdfKey('other-key'), payload) }, /altérée/);
// Jeton correctement signé mais expiré : refusé.
const old = payloadFor(Date.now() - 1);
await refused({ payload: old, signature: await hmac(await hkdfKey('mock-key'), old) }, /expirée/);
// Sans clé configurée, aucun jeton n'est accepté (pas de clé « undefined » devinable).
const undefinedKey = { payload, signature: await hmac(await hkdfKey('undefined'), payload) };
const unconfigured = await review(undefinedKey, {});
assert.equal(unconfigured.status, 503);
assert.match((await unconfigured.json()).error, /indisponible/);

// La vérification passe par crypto.subtle.verify (temps constant) et non par une comparaison
// de chaînes : on espionne verify le temps de ces cas, puis on restaure l'original.
const subtle = globalThis.crypto.subtle;
const originalVerify = subtle.verify;
const calls = [];
let forced;
subtle.verify = async function (...args) {
  calls.push(args);
  const result = await originalVerify.apply(subtle, args);
  return forced === undefined ? result : forced;
};
try {
  // Jeton valide : exactement un appel, avec la clé HMAC dérivée, la signature et la charge utile.
  assert.equal((await review(valid)).status, 200);
  assert.equal(calls.length, 1, 'unseal doit appeler crypto.subtle.verify exactement une fois');
  const [algorithm, key, mac, data] = calls[0];
  assert.equal(typeof algorithm === 'string' ? algorithm : algorithm.name, 'HMAC');
  assert.ok(key instanceof CryptoKey);
  assert.equal(key.algorithm.name, 'HMAC');
  assert.equal(key.algorithm.hash.name, 'SHA-256');
  assert.equal(key.extractable, false);
  assert.ok(key.usages.includes('verify'));
  assert.equal(hex(mac), valid.signature);
  assert.equal(new TextDecoder().decode(data), payload);
  // La clé passée à verify est bien la clé HKDF : elle valide un MAC calculé par l'oracle du test
  // et rejette l'ancien format signé avec la clé brute.
  const oracle = await crypto.subtle.sign('HMAC', await hkdfKey('mock-key'), enc('oracle'));
  assert.equal(await originalVerify.call(subtle, 'HMAC', key, oracle, enc('oracle')), true);
  const raw = await crypto.subtle.sign('HMAC', await rawKey('mock-key'), enc('oracle'));
  assert.equal(await originalVerify.call(subtle, 'HMAC', key, raw, enc('oracle')), false);

  // Une charge utile altérée est refusée par verify, appelé une fois.
  calls.length = 0;
  await refused(
    { ...valid, payload: valid.payload.replace('"matchId":7', '"matchId":8') },
    /altérée/,
  );
  assert.equal(calls.length, 1);

  // Le verdict de verify fait foi : forcé à false, un jeton valide est refusé.
  calls.length = 0;
  forced = false;
  await refused(valid, /altérée/);
  assert.equal(calls.length, 1);
} finally {
  subtle.verify = originalVerify;
}
console.log('Seal HKDF tests passed.');
