import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('dist/server/index.js', 'utf8');
const worker = (
  await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
).default;
const html = await (await worker.fetch(new Request('https://test/'), {})).text();
const script = fs.readFileSync('src/web/app.js', 'utf8');
const nodes = new Map(),
  calls = [];
const node = (key) => {
  if (!nodes.has(key))
    nodes.set(key, {
      value: key === '#stake' ? '10' : key === '#calcOdds' ? '1.8' : key === '#calcP' ? '60' : '',
      classList: { add() {}, remove() {}, toggle() {} },
      dataset: {},
    });
  return nodes.get(key);
};
const regionalIntl = {
  DateTimeFormat: class {
    formatToParts() {
      return [
        { type: 'month', value: '10' },
        { type: 'day', value: '12' },
        { type: 'year', value: '2026' },
      ];
    }
  },
};
vm.runInNewContext(script, {
  document: { querySelector: node, querySelectorAll: () => [] },
  Intl: regionalIntl,
  Date,
  Map,
  Math,
  JSON,
  Number,
  String,
  localStorage: { getItem: () => null },
  setTimeout() {},
  setInterval() {},
  clearInterval() {},
  fetch: async (path) => {
    calls.push(path);
    return {
      ok: true,
      text: async () =>
        JSON.stringify({
          subscription: { plan: 'Pro', active: true },
          requests: { limit_day: 7500 },
          response: [],
          paging: { total: 1 },
          retrievedAt: new Date().toISOString(),
        }),
    };
  },
});
await new Promise((r) => setTimeout(r, 10));
assert.equal(node('#date').value, '2026-10-12');
assert(calls.includes('/api/fixtures?date=2026-10-12'));
assert.equal(calls.length, 6);
assert(calls.includes('/api/assistant/latest?date=2026-10-12'));
assert(calls.includes('/api/performance'));
assert(calls.includes('/api/assistant/status'));
globalThis.fetch = async () =>
  Response.json({ errors: { quota: 'Daily limit reached' }, response: [] });
const res = await worker.fetch(new Request('https://test/api/status'), {
  API_FOOTBALL_KEY: 'test-secret',
});
assert.equal(res.status, 502);
assert.match((await res.json()).error, /Daily limit reached/);
assert(!html.includes('test-secret'));
console.log(
  'Passed: locale-independent date, client initialization, error details and secret isolation.',
);
