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
// Polices auto-hébergées : servies depuis le même domaine, sans service tiers ni CSP élargie.
assert(!/fonts\.(googleapis|gstatic)\.com/.test(html));
assert.equal(
  policy,
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'",
);
const css = await readFile('src/web/styles.css', 'utf8');
const fontUrls = [...css.matchAll(/url\('(\/assets\/fonts\/[^']+\.woff2)'\)/g)].map((m) => m[1]);
assert(fontUrls.length >= 12);
for (const path of new Set(fontUrls)) {
  const response = await worker.fetch(new Request('https://site' + path), {});
  assert.equal(response.status, 200, path);
  assert.equal(response.headers.get('content-type'), 'font/woff2');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(bytes.equals(await readFile('src/web' + path.replace('/assets', ''))), path);
}
for (const path of [
  '/assets/fonts/constructor',
  '/assets/fonts/OFL-Barlow.txt',
  '/assets/fonts/x.woff2',
])
  assert.equal((await worker.fetch(new Request('https://site' + path), {})).status, 404, path);
console.log(
  'Passed: separate web assets, self-hosted fonts, correct content types and compatible CSP.',
);
