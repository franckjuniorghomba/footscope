import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from '../worker/index.js';
const home = await worker.fetch(new Request('https://site/'), {});
const html = await home.text();
assert(html.includes('src="/assets/app.js"'));
assert(html.includes('href="/assets/styles.css"'));
const policy = home.headers.get('content-security-policy');
assert(policy.includes("script-src 'self'"));
assert(policy.includes("style-src 'self' 'unsafe-inline'"));
for (const [path, file, type] of [
  ['/assets/app.js', 'src/web/app.js', 'application/javascript'],
  ['/assets/styles.css', 'src/web/styles.css', 'text/css'],
]) {
  const response = await worker.fetch(new Request('https://site' + path), {});
  assert.equal(response.status, 200);
  assert(response.headers.get('content-type').startsWith(type));
  assert.equal(await response.text(), await readFile(file, 'utf8'));
}
console.log('Passed: separate web assets, correct content types and compatible CSP.');
