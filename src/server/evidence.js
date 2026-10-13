import { api } from './provider.js';
import { assessMatch } from './statistics.js';

const analysisCache = new Map();
const analysisPending = new Map();

export async function evidence(env, id, prefetched = {}) {
  const fixture = prefetched.fixture || (await api(env, 'fixtures?id=' + id, 60000)).response[0];
  if (!fixture) throw Error('Match introuvable.');
  const d = {
    fixture,
    retrievedAt: new Date().toISOString(),
    errors: {},
    odds: prefetched.odds || [],
    lineups: [],
  };
  for (const [k, path] of Object.entries({
    home: 'fixtures?team=' + fixture.teams.home.id + '&last=10',
    away: 'fixtures?team=' + fixture.teams.away.id + '&last=10',
    odds: 'odds?fixture=' + id,
    injuries: 'injuries?fixture=' + id,
    lineups: 'fixtures/lineups?fixture=' + id,
  })) {
    if (k === 'odds' && prefetched.odds) continue;
    if (
      k === 'lineups' &&
      prefetched.fixture &&
      fixture.fixture.timestamp * 1000 - Date.now() > 90 * 60000
    )
      continue;
    try {
      d[k] = (await api(env, path, k === 'odds' || k === 'lineups' ? 60000 : 900000)).response;
    } catch (e) {
      if (e.code === 'API_RATE_LIMIT') throw e;
      d[k] = [];
      d.errors[k] = e.message;
    }
  }
  return d;
}

export async function scan(env, id) {
  const hit = analysisCache.get(id);
  if (hit && Date.now() - hit.at < 60000) return hit.value;
  if (analysisPending.has(id)) return analysisPending.get(id);
  const task = evidence(env, id)
    .then((d) => {
      const value = assessMatch(d);
      analysisCache.set(id, { at: Date.now(), value });
      if (analysisCache.size > 100) analysisCache.delete(analysisCache.keys().next().value);
      return value;
    })
    .finally(() => analysisPending.delete(id));
  analysisPending.set(id, task);
  return task;
}
