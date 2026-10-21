// BIS-309 : le premier coupon reste visible sans défiler sur mobile, y compris avec un nom de match
// long, et les espacements autour de l'avertissement restent ceux de dev.
// Partie statique : toujours exécutée. Partie navigateur : Chromium via Playwright si disponible
// (sinon ignorée) ; WEB_ROOT=<dossier src/web de dev> imprime aussi la mesure « avant ».
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const css = await readFile('src/web/styles.css', 'utf8');
const mobile = css.slice(css.indexOf('/* BIS-309'));
assert.ok(mobile.includes('@media (max-width: 720px)'), 'bloc mobile BIS-309 présent');
assert.doesNotMatch(
  mobile,
  /\.mcwarn\s*\{[^}]*margin/,
  'espacement avertissement → coupon (16 px) non modifié',
);
assert.doesNotMatch(
  mobile,
  /\.tickethead\s*\{[^}]*margin-bottom/,
  'espacement mention de simulation → avertissement (20 px) non modifié',
);

const LONG = 'Olympique de Marseille — Paris Saint-Germain';
const pick = (i, match) => ({
  matchId: i,
  match,
  kickoff: '2030-01-01T14:00:00.000Z',
  market: 'Both Teams Score',
  selection: 'Yes',
  marketProbability: 0.82,
  modelProbability: null,
  modelCheck: 'non vérifié',
  odd: 1 / 0.82,
  fairOdds: 1 / 0.82,
  minOdds: 1.22,
  oddsAgeMinutes: 0,
  valueVsMarket: -0.001,
});
const coupons = (first) => {
  const names = [first, 'Arsenal — Chelsea', 'Club 3 — Visiteur 3', 'Club 4 — Visiteur 4'];
  const picks = names.map((n, i) => pick(i + 1, n));
  return [1, 2].map((size) => ({
    id: `fixture-${size}`,
    size,
    confidence: 0.82 ** size,
    combinedOdds: (1 / 0.82) ** size,
    bookmaker: 'bet365',
    selections: size === 1 ? picks.slice(0, 1) : picks.slice(1, 3),
  }));
};

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  try {
    const root = process.env.PLAYWRIGHT_PATH || '/root/.npm-global/lib/node_modules/playwright';
    ({ chromium } = await import(pathToFileURL(path.join(root, 'index.mjs')).href));
  } catch {
    console.log('mobile-coupon-layout : navigateur indisponible, mesures ignorées');
  }
}
if (chromium) {
  const measure = async (browser, root, first, theme, width, height) => {
    const server = http.createServer(async (req, res) => {
      const p = new URL(req.url, 'http://x').pathname;
      const file = p === '/' ? 'index.html' : p.replace(/^\/assets\//, '');
      try {
        res.setHeader(
          'Content-Type',
          file.endsWith('.css')
            ? 'text/css'
            : file.endsWith('.js')
              ? 'text/javascript'
              : file.endsWith('.woff2')
                ? 'font/woff2'
                : 'text/html',
        );
        res.end(await readFile(path.join(root, file)));
      } catch {
        res.writeHead(404).end();
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const context = await browser.newContext({
      viewport: { width, height },
      colorScheme: theme,
      locale: 'fr-FR',
    });
    const page = await context.newPage();
    await page.clock.install({ time: new Date('2026-10-19T16:00:00Z') });
    await page.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (u.hostname !== '127.0.0.1') return route.abort();
      if (u.pathname.startsWith('/api/')) {
        const data =
          u.pathname === '/api/status'
            ? { subscription: { active: true, plan: 'fixture' }, requests: { limit_day: 7500 } }
            : u.pathname === '/api/fixtures'
              ? { response: [], retrievedAt: '2026-10-19T16:00:00Z' }
              : u.pathname === '/api/odds'
                ? { response: [], paging: { total: 1 } }
                : u.pathname === '/api/assistant/status'
                  ? { configured: false }
                  : { available: false };
        return route.fulfill({ json: data });
      }
      return route.continue();
    });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => typeof marketCouponsState === 'function');
    await page.evaluate((c) => marketCouponsState('result', { marketCoupons: c }), coupons(first));
    await page.evaluate(() => document.fonts.ready);
    const m = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const chip = r('.marketcoupons .chip');
      const warn = r('.mcwarn');
      const coupon = r('.mcoupon');
      return {
        fairBottom: r('.mcpick .mcfacts>div:nth-child(3) dd').bottom,
        chipToWarning: warn.top - chip.bottom,
        warningToCoupon: coupon.top - warn.bottom,
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    await context.close();
    server.close();
    return m;
  };
  const browser = await chromium.launch({ headless: true });
  const rows = [];
  try {
    const cases = [
      [360, 800],
      [375, 900],
    ];
    for (const [width, height] of cases) {
      for (const theme of ['light', 'dark']) {
        for (const [label, first] of [
          ['courte', 'Club 1 — Visiteur 1'],
          ['nom long', LONG],
        ]) {
          const after = await measure(browser, 'src/web', first, theme, width, height);
          const before = process.env.WEB_ROOT
            ? await measure(browser, process.env.WEB_ROOT, first, theme, width, height)
            : null;
          rows.push({ label, theme, width, height, before, after });
          assert.ok(
            after.fairBottom <= height,
            `${label} ${width}x${height} ${theme} : cote juste à ${after.fairBottom}`,
          );
          assert.equal(after.overflow, 0, 'aucun débordement horizontal');
          assert.equal(Math.round(after.chipToWarning), 20, 'mention → avertissement : 20 px');
          assert.equal(Math.round(after.warningToCoupon), 16, 'avertissement → coupon : 16 px');
        }
      }
    }
  } finally {
    await browser.close();
  }
  if (process.env.WEB_ROOT) console.log(JSON.stringify(rows, null, 1));
}
