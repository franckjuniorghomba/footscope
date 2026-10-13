import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('dist/server/index.js', 'utf8');
const worker = (
  await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
).default;
const html = await (await worker.fetch(new Request('https://site/'), {})).text();
const js = fs.readFileSync('src/web/app.js', 'utf8');
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
const scans = [],
  pages = [];
let finalCalls = 0;
const fetch = async (path, options) => {
  const b = options?.body ? JSON.parse(options.body) : {};
  let d = { response: [], paging: { total: 1 }, configured: true, subscription: {}, requests: {} };
  if (path.endsWith('/prepare'))
    d = {
      ids: Array.from({ length: 20 }, (_, i) => i + 1),
      jobId: 'job',
      quoteDays: ['2026-10-13'],
      scope: b,
      eligibleCount: 20,
    };
  if (path.endsWith('/quotes')) {
    pages.push(b.page);
    d = { total: 2 };
  }
  if (path.endsWith('/scan')) {
    scans.push(b);
    d = { report: {} };
  }
  if (path.endsWith('/propose')) {
    finalCalls++;
    d =
      finalCalls === 1
        ? { needsRecheck: [20] }
        : {
            engine: 'statistics',
            summary: 'Analyse complète',
            coverageComplete: true,
            analyzed: 20,
            eligibleCount: 20,
            selections: [],
          };
  }
  return { ok: true, text: async () => JSON.stringify(d), json: async () => d };
};
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
  localStorage: { getItem: () => null },
  fetch,
});
vm.runInContext(js, c);
await new Promise((r) => setTimeout(r, 5));
await node('#propose').onclick();
assert.deepEqual(pages, [1, 2]);
assert.equal(scans.filter((x) => !x.recheck).length, 20);
assert.equal(scans.at(-1).matchId, 20);
assert.equal(scans.at(-1).recheck, true);
assert(scans.every((x) => x.jobId === 'job'));
assert.equal(finalCalls, 2);
assert(
  node('#assistantResult').innerHTML.includes('Tous les matchs du périmètre ont été examinés'),
);
assert(!node('#propose').disabled);
console.log(
  'Passed: interface covers every match and odds page, refreshes finalist and displays complete coverage.',
);
