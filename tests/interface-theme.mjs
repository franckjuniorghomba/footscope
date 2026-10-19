import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile('src/web/app.js', 'utf8');
const themeCode = source.slice(
  source.indexOf('function initTheme()'),
  source.indexOf('const tz ='),
);
for (const saved of [null, 'dark', 'light', 'invalid', 'blocked']) {
  let click, change, stored;
  const button = {
    setAttribute: (_, value) => (button.pressed = value),
    textContent: '',
    addEventListener: (_, fn) => (click = fn),
  };
  const system = { matches: true, addEventListener: (_, fn) => (change = fn) };
  const document = { documentElement: { dataset: {} }, querySelector: () => null };
  runInNewContext(themeCode, {
    $: () => button,
    document,
    window: { matchMedia: () => system },
    localStorage: {
      getItem: () => {
        if (saved === 'blocked') throw Error('Storage unavailable');
        return saved;
      },
      setItem: (_, value) => {
        if (saved === 'blocked') throw Error('Storage unavailable');
        stored = value;
      },
    },
  });
  assert.equal(document.documentElement.dataset.theme, saved === 'light' ? 'light' : 'dark');
  assert.equal(button.textContent, saved === 'light' ? 'Mode sombre' : 'Mode clair');
  system.matches = false;
  change();
  const expected = saved === 'dark' ? 'dark' : 'light';
  assert.equal(
    document.documentElement.dataset.theme,
    expected,
    'seul un choix valide prime sur le système',
  );
  click();
  const chosen = expected === 'dark' ? 'light' : 'dark';
  assert.equal(document.documentElement.dataset.theme, chosen);
  assert.equal(button.pressed, String(chosen === 'dark'));
  assert.equal(button.textContent, chosen === 'dark' ? 'Mode clair' : 'Mode sombre');
  if (saved !== 'blocked') assert.equal(stored, chosen);
  system.matches = true;
  change();
  assert.equal(document.documentElement.dataset.theme, chosen, 'le choix explicite reste stable');
}
const css = await readFile('src/web/styles.css', 'utf8');
assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)/);
assert.match(css, /:root:not\(\[data-theme\]\)/);
assert(!/<script\b[^>]*>[^<]+/i.test(await readFile('src/web/index.html', 'utf8')));
console.log('Thèmes : système, choix persistant et stockage indisponible vérifiés.');
