import { api } from './provider.js';
import { json } from './http.js';
import { evidence } from './evidence.js';
import { assessMatch } from './statistics.js';
import {
  supportedMarkets,
  supportedQuotes,
  compactReport,
  blockedReport,
  selectCoupon,
} from './coupon.js';

export async function putJob(env, job) {
  await env.BUCKET.put('jobs/' + job.id + '/manifest.json', JSON.stringify(job));
}
async function getJob(env, id, who) {
  if (!env.BUCKET) throw Error('Stockage requis pour une analyse complète.');
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw Error('Analyse inconnue.');
  const obj = await env.BUCKET.get('jobs/' + id + '/manifest.json');
  if (!obj) throw Error('Analyse introuvable.');
  const job = await obj.json();
  if (job.owner !== who) throw Error('Accès à cette analyse refusé.');
  if (Date.now() - Date.parse(job.createdAt) > 86400000)
    throw Error('Analyse expirée : relancez une nouvelle collecte.');
  return job;
}
function coverageReady(job) {
  return job.quoteDays.every(
    (d) =>
      Number.isInteger(job.quoteTotals[d]) &&
      Array.from({ length: job.quoteTotals[d] }, (_, i) => d + ':' + (i + 1)).every((k) =>
        job.quoteCompleted.includes(k),
      ),
  );
}
export async function universeJob(req, env, path, body, who) {
  const job = await getJob(env, body.jobId, who);
  if (path.endsWith('quotes')) {
    const day = body.day,
      page = Number(body.page || 1);
    if (!job.quoteDays.includes(day) || !Number.isInteger(page) || page < 1 || page > 1000)
      throw Error('Page de cotes invalide.');
    const quotePath =
      job.quoteMode === 'fixtures'
        ? 'odds?fixture=' + day + '&page=' + page
        : 'odds?date=' + day + '&timezone=Etc%2FGMT%2B5&page=' + page;
    const d = await api(env, quotePath, 300000);
    const ids = new Set(job.fixtures.map((f) => f.fixture.id));
    for (const row of d.response || []) {
      if (!ids.has(row.fixture.id)) continue;
      const key = 'jobs/' + job.id + '/odds/' + row.fixture.id + '.json';
      const obj = await env.BUCKET.get(key);
      const prior = obj ? await obj.json() : [];
      const trimmed = {
        ...row,
        bookmakers: (row.bookmakers || [])
          .map((b) => ({ ...b, bets: (b.bets || []).filter((m) => supportedMarkets.has(m.name)) }))
          .filter((b) => b.bets.length),
      };
      const merged = new Map();
      for (const r of [...prior, trimmed])
        for (const b of r.bookmakers) {
          const old = merged.get(b.name);
          if (!old || Date.parse(r.update) >= Date.parse(old.update))
            merged.set(b.name, { ...r, bookmakers: [b] });
        }
      await env.BUCKET.put(key, JSON.stringify([...merged.values()]));
    }
    job.quoteTotals[day] = Math.max(1, Number(d.paging?.total) || 1);
    if (!job.quoteCompleted.includes(day + ':' + page)) job.quoteCompleted.push(day + ':' + page);
    await putJob(env, job);
    return json({
      jobId: job.id,
      day,
      page,
      total: job.quoteTotals[day],
      coverageReady: coverageReady(job),
    });
  }
  if (path.endsWith('scan')) {
    if (!coverageReady(job))
      return json(
        { error: 'Toutes les pages de cotes doivent être parcourues avant de classer les matchs.' },
        409,
      );
    const f = job.fixtures.find((x) => x.fixture.id === body.matchId);
    if (!f) return json({ error: 'Match hors du périmètre de cette analyse.' }, 400);
    const key = 'jobs/' + job.id + '/reports/' + f.fixture.id + '.json';
    const prev = await env.BUCKET.get(key);
    if (prev && !body.recheck) {
      const report = await prev.json();
      if (Date.now() - Date.parse(report.retrievedAt) < 60000)
        return json({ jobId: job.id, report, cached: true });
    }
    const obj = await env.BUCKET.get('jobs/' + job.id + '/odds/' + f.fixture.id + '.json');
    const odds = obj ? await obj.json() : [];
    let report;
    if (f.fixture.timestamp * 1000 <= Date.now())
      report = blockedReport(f, 'Match déjà commencé pendant la collecte.');
    else if (body.recheck) {
      try {
        report = compactReport(assessMatch(await evidence(env, f.fixture.id)));
      } catch (e) {
        if (e.code === 'API_RATE_LIMIT') throw e;
        report = blockedReport(f, 'Actualisation finale impossible : ' + e.message);
      }
      job.finalChecked = job.finalChecked || {};
      job.finalChecked[String(f.fixture.id)] = Date.now();
      await putJob(env, job);
    } else if (!odds.length)
      report = blockedReport(
        f,
        'Aucune cote retournée après parcours de toutes les pages du fournisseur.',
      );
    else if (!supportedQuotes(odds))
      report = blockedReport(
        f,
        'Aucun marché modélisé avec une cote datant de moins de 30 minutes.',
      );
    else
      report = compactReport(assessMatch(await evidence(env, f.fixture.id, { fixture: f, odds })));
    await env.BUCKET.put(key, JSON.stringify(report));
    return json({ jobId: job.id, report });
  }
  if (path.endsWith('propose')) {
    if (!coverageReady(job))
      return json({ error: 'Couverture des cotes incomplète : coupon non proposé.' }, 409);
    const reports = [],
      missing = [];
    for (const f of job.fixtures) {
      const obj = await env.BUCKET.get('jobs/' + job.id + '/reports/' + f.fixture.id + '.json');
      if (obj) reports.push(await obj.json());
      else missing.push(f.fixture.id);
    }
    if (missing.length)
      return json(
        {
          error: 'Analyse incomplète : ' + missing.length + ' match(s) restent à examiner.',
          missing,
          analyzed: reports.length,
          eligibleCount: job.fixtures.length,
        },
        409,
      );
    const preliminary = selectCoupon(reports);
    const needsRecheck = preliminary
      .filter(
        (e) =>
          !job.finalChecked?.[String(e.matchId)] ||
          Date.now() - job.finalChecked[String(e.matchId)] > 300000,
      )
      .map((e) => e.matchId);
    if (needsRecheck.length)
      return json({
        jobId: job.id,
        needsRecheck,
        analyzed: reports.length,
        eligibleCount: job.fixtures.length,
      });
    return { reports, scope: job.scope, eligibleCount: job.fixtures.length, jobId: job.id };
  }
  return json({ error: 'Action inconnue' }, 404);
}
