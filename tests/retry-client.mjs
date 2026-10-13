import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const js = fs.readFileSync('src/web/app.js', 'utf8');
const nodes = new Map(),
  timers = new Map(),
  requests = [];
let clock = Date.now(),
  timerId = 0,
  paused = false,
  status = 429;
const makeNode = (key) => ({
  value: key === '#stake' ? '10' : key === '#calcOdds' ? '1.8' : key === '#calcP' ? '60' : '',
  classList: { add() {}, remove() {}, toggle() {} },
  dataset: {},
  scrollIntoView() {},
  textContent: '',
});
const node = (key) => {
  if (!nodes.has(key)) nodes.set(key, makeNode(key));
  return nodes.get(key);
};
const nav = ['today', 'journal', 'method'].map((view) => ({
  ...makeNode('nav'),
  dataset: { view },
}));
class FakeDate extends Date {
  constructor(...args) {
    super(...(args.length ? args : [clock]));
  }
  static now() {
    return clock;
  }
}
const context = vm.createContext({
  document: {
    querySelector: node,
    querySelectorAll: (s) => (s === 'nav button' ? nav : []),
    visibilityState: 'visible',
  },
  Intl,
  Date: FakeDate,
  Number,
  String,
  Math,
  Map,
  JSON,
  localStorage: { getItem: () => null },
  setTimeout() {},
  setInterval(fn, ms) {
    const id = ++timerId;
    timers.set(id, { fn, ms });
    return id;
  },
  clearInterval(id) {
    timers.delete(id);
  },
  fetch: async (path) => {
    requests.push(path);
    const limited = paused && (path.startsWith('/api/fixtures?') || path.startsWith('/api/match?'));
    const data = limited
      ? { error: 'Provider paused', code: 'API_RATE_LIMIT', retryable: true, retryAfter: 2 }
      : { response: [], paging: { total: 1 }, configured: true, subscription: {}, requests: {} };
    return {
      ok: !limited,
      status: limited ? status : 200,
      text: async () => JSON.stringify(data),
      json: async () => data,
    };
  },
});
const flush = () => new Promise((resolve) => setImmediate(resolve));
const retryTimers = () => [...timers.values()].filter((t) => t.ms === 1000);
async function tick() {
  clock += 2000;
  for (const t of retryTimers()) t.fn();
  await flush();
}
vm.runInContext(js, context);
await flush();
requests.length = 0;
paused = true;
await vm.runInContext('load()', context);
assert.match(node('#status').textContent, /2 s/);
assert.equal(retryTimers().length, 1);
await tick();
await tick();
assert.equal(
  requests.filter((p) => p.startsWith('/api/fixtures?')).length,
  3,
  'Two automatic retries maximum',
);
assert.equal(retryTimers().length, 0);
assert.match(node('#status').textContent, /Reprises automatiques arrêtées/);
// Filter changes, successful-view back navigation and application tabs cancel pending retries.
await vm.runInContext('load()', context);
node('#search').oninput();
assert.equal(retryTimers().length, 0);
await vm.runInContext('detail(7)', context);
assert.equal(retryTimers().length, 1);
node('#back').onclick();
assert.equal(retryTimers().length, 0);
await vm.runInContext('detail(7)', context);
nav[1].onclick();
assert.equal(retryTimers().length, 0);
nav[0].onclick();
// Switching match discards the previous timer and retries only the latest match.
requests.length = 0;
await vm.runInContext('detail(7)', context);
await vm.runInContext('detail(8)', context);
await tick();
assert.equal(requests.filter((p) => p === '/api/match?id=7').length, 1);
assert.equal(requests.filter((p) => p === '/api/match?id=8').length, 2);
node('#back').onclick();
status = 401;
await vm.runInContext('detail(7)', context);
assert.equal(
  retryTimers().length,
  0,
  'An authentication error never retries, even with a retryable body',
);
console.log(
  'Passed: bounded client retries, countdown, cancellation by filters/back/tabs/match change and no authentication retries.',
);
