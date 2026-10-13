import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const s = fs.readFileSync('dist/server/index.js', 'utf8');
const w = (await import('data:text/javascript;base64,' + Buffer.from(s).toString('base64')))
  .default;
const html = await (await w.fetch(new Request('https://site/'), {})).text();
const script = fs.readFileSync('src/web/app.js', 'utf8');
const nodes = new Map();
function node(k) {
  if (!nodes.has(k))
    nodes.set(k, {
      value: k === '#stake' ? '10' : k === '#calcOdds' ? '1.8' : k === '#calcP' ? '60' : '',
      classList: { add() {}, remove() {}, toggle() {} },
      dataset: {},
      scrollIntoView() {},
    });
  return nodes.get(k);
}
const c = vm.createContext({
  document: { querySelector: node, querySelectorAll: () => [] },
  Intl,
  Date,
  Number,
  String,
  Math,
  Map,
  JSON,
  setTimeout() {},
  setInterval() {},
  clearInterval() {},
  localStorage: { getItem: () => null },
  fetch: async () => ({
    ok: true,
    text: async () =>
      JSON.stringify({
        configured: false,
        subscription: {},
        requests: {},
        response: [],
        paging: { total: 1 },
      }),
  }),
});
vm.runInContext(script, c);
await new Promise((r) => setTimeout(r, 10));
const rows = Array.from({ length: 30 }, (_, i) => ({
  fixture: { id: i + 1, date: '2030-01-01T18:00:00Z', timestamp: i, status: { short: 'NS' } },
  league: { name: i < 25 ? 'Ligue A' : 'Ligue B', country: i < 25 ? 'France' : 'Spain' },
  teams: { home: { name: 'Club ' + i }, away: { name: 'Visiteur ' + i } },
}));
c.rows = rows;
vm.runInContext('fixtures=rows;', c);
node('#country').value = 'France';
vm.runInContext('updateLeagues();render();', c);
assert.equal((node('#matches').innerHTML.match(/<article/g) || []).length, 12);
assert.equal(node('#matchPage').textContent, 'PAGE 1 / 3');
assert(node('#prevMatches').disabled);
assert(!node('#nextMatches').disabled);
node('#nextMatches').onclick();
assert.equal(node('#matchPage').textContent, 'PAGE 2 / 3');
node('#nextMatches').onclick();
assert.equal((node('#matches').innerHTML.match(/<article/g) || []).length, 1);
assert(node('#nextMatches').disabled);
node('#country').value = 'Spain';
node('#country').onchange();
assert.equal(node('#matchPage').textContent, 'PAGE 1 / 1');
assert.equal((node('#matches').innerHTML.match(/<article/g) || []).length, 5);
assert(!node('#matches').innerHTML.includes('Ligue A'));

const status = await (await w.fetch(new Request('https://site/api/assistant/status'), {})).json();
assert.equal(status.configured, false);
const response = await w.fetch(
  new Request('https://site/api/assistant/propose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-10-12', country: 'France' }),
  }),
  {},
);
assert.equal(response.status, 400);
assert.match((await response.json()).error, /Analyses signées/);
const forbidden = await w.fetch(
  new Request('https://site/api/assistant/review', {
    method: 'POST',
    headers: { Origin: 'https://other/' },
    body: '{}',
  }),
  {},
);
assert.equal(forbidden.status, 403);
console.log(
  'Passed: country scope, dependent leagues, 12-match pagination, arrows, no-LLM honesty, coupon review and cross-origin guard.',
);
