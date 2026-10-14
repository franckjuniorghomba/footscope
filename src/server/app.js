import { api, fixturesForDay } from './provider.js';
import { POLICY } from './policy.js';
import { json } from './http.js';
import { assistant } from './assistant.js';
import { performance } from './storage.js';
import { exportEvidence, finishEvidence } from './jobs.js';
import { page, css, clientScript, fonts } from '../../.build/web-assets.js';

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (
      req.method !== 'GET' &&
      !(req.method === 'POST' && u.pathname.startsWith('/api/assistant/'))
    )
      return json({ error: 'Méthode non autorisée' }, 405);
    try {
      if (u.pathname === '/api/assistant/evidence') {
        if (req.method !== 'GET')
          return json({ error: 'Méthode non autorisée', code: 'METHOD_NOT_ALLOWED' }, 405);
        return await exportEvidence(req, env);
      }
      if (u.pathname === '/api/diagnostics') {
        const obj = env.BUCKET ? await env.BUCKET.get('api-control/last-limit.json') : null;
        return json({ lastLimit: obj ? await obj.json() : null });
      }
      if (u.pathname === '/api/performance') return json(await performance(env));
      if (u.pathname === '/api/assistant/latest') {
        if (!env.BUCKET) return json({ available: false });
        const date = u.searchParams.get('date');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return json({ error: 'Date invalide' }, 400);
        const obj = await env.BUCKET.get('latest/' + date + '.json');
        return json({ available: !!obj, data: obj ? await obj.json() : null });
      }
      if (u.pathname === '/api/assistant/status')
        return json({
          configured: !!(env.OPENAI_API_KEY && env.LLM_MODEL),
          model: env.LLM_MODEL || null,
          statisticsAvailable: !!env.API_FOOTBALL_KEY,
          policy: POLICY,
          modelValidated: false,
        });
      if (req.method === 'POST' && u.pathname.startsWith('/api/assistant/')) {
        const response = await assistant(req, env, u.pathname);
        return u.pathname === '/api/assistant/propose'
          ? await finishEvidence(req, env, response)
          : response;
      }
      if (u.pathname === '/api/status') {
        const d = await api(env, 'status', 60000);
        return json({
          subscription: d.response.subscription,
          requests: d.response.requests,
          retrievedAt: d.retrievedAt,
        });
      }
      if (u.pathname === '/api/fixtures' || u.pathname === '/api/odds') {
        const date = u.searchParams.get('date');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return json({ error: 'Date invalide' }, 400);
        if (u.pathname === '/api/fixtures') return json(await fixturesForDay(env, date));
        let path =
          (u.pathname === '/api/fixtures' ? 'fixtures' : 'odds') +
          '?date=' +
          date +
          '&timezone=Etc%2FGMT%2B5';
        if (u.pathname === '/api/odds') {
          const n = Number(u.searchParams.get('page') || 1);
          if (!Number.isInteger(n) || n < 1 || n > 100)
            return json({ error: 'Page invalide' }, 400);
          path += '&page=' + n;
        }
        return json(await api(env, path));
      }
      if (u.pathname === '/api/match') {
        const id = u.searchParams.get('id');
        if (!/^\d{1,10}$/.test(id || '')) return json({ error: 'Match invalide' }, 400);
        const fixture = (await api(env, 'fixtures?id=' + id)).response[0];
        if (!fixture) return json({ error: 'Match introuvable' }, 404);
        const tasks = {
          home: 'fixtures?team=' + fixture.teams.home.id + '&last=10',
          away: 'fixtures?team=' + fixture.teams.away.id + '&last=10',
          injuries: 'injuries?fixture=' + id,
          lineups: 'fixtures/lineups?fixture=' + id,
          odds: 'odds?fixture=' + id,
        };
        const out = {
          fixture,
          source: 'API-Football',
          retrievedAt: new Date().toISOString(),
          errors: {},
        };
        let limited = null;
        for (const [k, p] of Object.entries(tasks)) {
          if (limited) {
            out[k] = [];
            out.errors[k] = limited.message;
            continue;
          }
          try {
            out[k] = (await api(env, p)).response;
          } catch (e) {
            if (e.code === 'API_RATE_LIMIT' || e.code === 'API_QUEUE_BUSY') limited = e;
            out[k] = [];
            out.errors[k] = e.message;
          }
        }
        // Une fiche incomplète à cause d'une pause du fournisseur ne doit pas ressembler à
        // « aucune donnée ». Les parties déjà obtenues restent en cache : le nouvel essai est court.
        if (limited) {
          const retryAfter = limited.retryAfter || 65;
          const response = json(
            {
              error:
                'Fiche incomplète : ' +
                limited.message +
                ' Les données déjà obtenues sont conservées.',
              code: limited.code,
              retryable: true,
              retryAfter,
              missing: Object.keys(out.errors),
            },
            429,
          );
          response.headers.set('Retry-After', String(retryAfter));
          return response;
        }
        return json(out);
      }
      if (u.pathname === '/assets/styles.css')
        return new Response(css, {
          headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      if (u.pathname === '/assets/app.js')
        return new Response(clientScript, {
          headers: {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      if (u.pathname.startsWith('/assets/fonts/')) {
        const name = u.pathname.slice('/assets/fonts/'.length);
        if (Object.hasOwn(fonts, name))
          return new Response(
            Uint8Array.from(atob(fonts[name]), (c) => c.charCodeAt(0)),
            {
              headers: {
                'Content-Type': 'font/woff2',
                'Cache-Control': 'public, max-age=86400',
                'X-Content-Type-Options': 'nosniff',
              },
            },
          );
      }
      if (u.pathname === '/')
        return new Response(page, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy':
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'",
          },
        });
      return json({ error: 'Page introuvable' }, 404);
    } catch (e) {
      const response = json(
        {
          error: e.message || 'Erreur de connexion',
          code: e.code || null,
          retryable: !!e.retryable,
          retryAfter: e.retryAfter || null,
        },
        e.status || 502,
      );
      if (e.retryAfter) response.headers.set('Retry-After', String(e.retryAfter));
      return response;
    }
  },
};
