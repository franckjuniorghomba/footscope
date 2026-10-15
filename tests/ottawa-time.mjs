import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { archiveKey } from '../src/server/odds-archive.js';

const source = (await readFile('dist/server/index.js', 'utf8')).replace(
  /(?:var|const) API_SPACING_MS\s*=\s*6500\s*;/,
  'var API_SPACING_MS = 0;',
);
const { default: worker, ottawaDay } = await import(
  'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
);
const realNow = Date.now;
Date.now = () => Date.parse('2026-01-01T00:00:00Z');
const db = new Map();
const env = {
  API_FOOTBALL_KEY: 'mock-key',
  BUCKET: {
    get: async (key) => (db.has(key) ? { json: async () => JSON.parse(db.get(key)) } : null),
    put: async (key, value) => db.set(key, value),
  },
};
let rows = [];
const requests = [];
globalThis.fetch = async (url) => {
  const u = new URL(url);
  requests.push(u);
  assert.equal(u.searchParams.get('timezone'), 'America/Toronto');
  assert(u.search.includes('timezone=America%2FToronto'));
  return Response.json({
    response: u.pathname.endsWith('/fixtures') ? rows : [],
    paging: { total: 1 },
    errors: {},
  });
};
const post = (action, body, owner = 'owner') =>
  worker.fetch(
    new Request('https://site/api/assistant/' + action, {
      method: 'POST',
      headers: { 'oai-authenticated-user-id': owner },
      body: JSON.stringify(body),
    }),
    env,
  );

// Bornes explicites et indépendantes de la fonction testée : 24, 24, 25 et 23 heures.
for (const [day, start, hours] of [
  ['2026-10-15', '2026-10-15T04:00:00Z', 24],
  ['2026-11-03', '2026-11-03T05:00:00Z', 24],
  ['2026-11-01', '2026-11-01T04:00:00Z', 25],
  ['2026-03-08', '2026-03-08T05:00:00Z', 23],
]) {
  const begin = Date.parse(start);
  rows = Array.from({ length: hours + 2 }, (_, i) => {
    const at = begin + (i - 1) * 3600000;
    return {
      fixture: {
        id: i + 1,
        date: new Date(at).toISOString(),
        timestamp: at / 1000,
        status: { short: 'NS' },
      },
      league: { country: 'Canada', name: 'Fixture' },
      teams: { home: { name: 'Home' }, away: { name: 'Away' } },
    };
  });
  assert.notEqual(ottawaDay(new Date(begin - 1).toISOString()), day);
  assert.equal(ottawaDay(start), day);
  assert.equal(ottawaDay(new Date(begin + hours * 3600000 - 1).toISOString()), day);
  assert.notEqual(ottawaDay(new Date(begin + hours * 3600000).toISOString()), day);
  const result = await (
    await worker.fetch(new Request('https://site/api/fixtures?date=' + day), env)
  ).json();
  const expectedIds = rows.slice(1, -1).map((r) => r.fixture.id);
  assert.equal(result.results, hours, 'Toute la journée, sans doublons ni matchs voisins');
  assert.deepEqual(
    result.response.map((r) => r.fixture.id),
    expectedIds,
  );
  const plan = await (await post('prepare', { date: day })).json();
  assert.deepEqual(plan.ids, expectedIds, 'Le périmètre des coupons suit la même journée');
  if (day === '2026-11-01') {
    assert(
      plan.ids.includes(3) && plan.ids.includes(4),
      'Les deux occurrences de 01 h sont conservées',
    );
    assert.equal(
      (await post('quotes', { jobId: plan.jobId, day: plan.quoteDays[0] }, 'other')).status,
      502,
    );
    assert.equal((await post('quotes', { jobId: plan.jobId, day: '2026-11-05' })).status, 502);
    const quoted = await post('quotes', { jobId: plan.jobId, day: plan.quoteDays[0], page: 1 });
    assert.equal(quoted.status, 200);
    assert(requests.at(-1).pathname.endsWith('/odds'));
  }
}
assert.equal(
  (await worker.fetch(new Request('https://site/api/odds?date=2026-10-15&page=1'), env)).status,
  200,
);
const count = requests.length;
assert.equal(
  (await worker.fetch(new Request('https://site/api/fixtures?date=bad'), env)).status,
  400,
);
assert.equal(
  (await worker.fetch(new Request('https://site/api/odds?date=2026-10-15&page=0'), env)).status,
  400,
);
assert.equal(requests.length, count, 'Entrées refusées avant tout appel fournisseur');
Date.now = realNow;

// Les clés historiques restent identiques même pendant l'heure avancée.
assert.equal(
  archiveKey(7, '2026-10-15T04:30:00.000Z'),
  'odds-archive/2026-10-14/7/20261015T043000000Z.json',
);
assert.equal(
  archiveKey(7, '2026-11-01T04:30:00.000Z'),
  'odds-archive/2026-10-31/7/20261101T043000000Z.json',
);

const ui = await readFile('src/web/app.js', 'utf8');
const html = await readFile('src/web/index.html', 'utf8');
assert(!/GMT[−-]5|Etc\/GMT/.test(ui + html));
for (const [instant, expected] of [
  ['2026-10-15T16:00:00Z', '12 h 00'],
  ['2026-11-03T17:00:00Z', '12 h 00'],
  ['2026-11-01T05:00:00Z', '01 h 00'],
  ['2026-11-01T06:00:00Z', '01 h 00'],
]) {
  const ctx = {};
  runInNewContext(
    ui.slice(ui.indexOf('const tz ='), ui.indexOf('const dateParts =')) +
      ui.slice(ui.indexOf('function time('), ui.indexOf('// Écusson neutre')),
    ctx,
  );
  assert.equal(ctx.time(instant), expected);
  assert(ctx.kickoff(instant).includes(expected.replace(/\s?h\s?/, 'h')));
  assert(ctx.stamp(instant).includes(expected));
}
// À 00 h 30 en heure avancée, le sélecteur ouvre bien le 15 (le fuseau fixe ouvrait le 14).
const dateField = {};
runInNewContext(
  ui.slice(ui.indexOf('const tz ='), ui.indexOf('let fixtures =')) +
    '\nglobalThis.selected = today;',
  {
    $: () => dateField,
    Date: class extends Date {
      constructor() {
        super('2026-10-15T04:30:00Z');
      }
    },
  },
);
assert.equal(dateField.value, '2026-10-15');
console.log(
  'Passed: Ottawa summer/winter display, midnight, 25/23-hour days, all fixtures, API timezone and refusals, stable archive keys.',
);
