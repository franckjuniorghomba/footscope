import { createHash } from 'node:crypto';
import { readFile, mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const fixedDay = (date) =>
  new Date(Date.parse(date) - 5 * 3600000).toISOString().slice(0, 10);
export const dayStart = (day) => Date.parse(day + 'T05:00:00Z');
export const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
export const defaultPlan = await readJson(new URL('./plan.json', import.meta.url));

export function validatePlan(plan) {
  const date = (v) =>
    typeof v === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    Number.isFinite(dayStart(v)) &&
    new Date(dayStart(v)).toISOString().slice(0, 10) === v;
  if (
    plan.schemaVersion !== 1 ||
    !Array.isArray(plan.leagues) ||
    !Array.isArray(plan.seasons) ||
    !plan.leagues.length ||
    !plan.seasons.length ||
    plan.leagues.length * plan.seasons.length > 30 ||
    [plan.leagues, plan.seasons].some(
      (xs) => new Set(xs).size !== xs.length || xs.some((x) => !Number.isSafeInteger(x) || x <= 0),
    ) ||
    ![plan.developmentStart, plan.testStart, plan.testEnd].every(date) ||
    !(plan.developmentStart < plan.testStart && plan.testStart < plan.testEnd) ||
    !Number.isInteger(plan.bootstrapReplicates) ||
    plan.bootstrapReplicates < 100 ||
    plan.bootstrapReplicates > 10000 ||
    !Number.isSafeInteger(plan.seed)
  )
    throw Error('Plan temporel ou budget invalide.');
  return plan;
}

export function validateDataset(data) {
  if (
    data.schemaVersion !== 1 ||
    !['historical', 'demonstration'].includes(data.kind) ||
    data.source !== (data.kind === 'historical' ? 'API-Football' : 'synthetic') ||
    !Array.isArray(data.fixtures) ||
    !data.fixtures.length
  )
    throw Error('Jeu de résultats invalide.');
  const ids = new Set();
  for (const f of data.fixtures) {
    const t = Date.parse(f.fixture?.date);
    if (
      !Number.isSafeInteger(f.fixture?.id) ||
      ids.has(f.fixture.id) ||
      !Number.isFinite(t) ||
      !Number.isSafeInteger(f.fixture.timestamp) ||
      f.fixture.timestamp * 1000 !== t ||
      !Number.isSafeInteger(f.league?.id) ||
      !Number.isSafeInteger(f.league.season) ||
      typeof f.fixture.status?.short !== 'string' ||
      [f.teams?.home, f.teams?.away].some(
        (x) => !Number.isSafeInteger(x?.id) || typeof x.name !== 'string',
      ) ||
      f.teams.home.id === f.teams.away.id ||
      !f.goals ||
      ['home', 'away'].some(
        (s) => f.goals[s] !== null && (!Number.isSafeInteger(f.goals[s]) || f.goals[s] < 0),
      ) ||
      (f.fixture.status.short === 'FT' && [f.goals.home, f.goals.away].includes(null))
    ) {
      throw Error('Rencontre invalide ou identifiant dupliqué.');
    }
    ids.add(f.fixture.id);
  }
  return data;
}

export function normalizeFixture(f) {
  return {
    fixture: {
      id: f.fixture?.id,
      date: f.fixture?.date,
      timestamp: f.fixture?.timestamp,
      status: { short: f.fixture?.status?.short },
    },
    league: {
      id: f.league?.id,
      season: f.league?.season,
      name: f.league?.name,
      country: f.league?.country,
    },
    teams: {
      home: { id: f.teams?.home?.id, name: f.teams?.home?.name },
      away: { id: f.teams?.away?.id, name: f.teams?.away?.name },
    },
    goals: { home: f.goals?.home ?? null, away: f.goals?.away ?? null },
  };
}

// Tous les jeux, journaux et rapports sont extérieurs au checkout, même via un lien symbolique.
export async function externalDirectory(path) {
  const target = resolve(path);
  const inside = (p) => {
    const r = relative(repoRoot, p);
    return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r));
  };
  if (inside(target)) throw Error('Le dossier de sortie doit être hors dépôt.');
  // Vérifier le parent existant avant de créer des répertoires via un éventuel lien symbolique.
  let parent = target;
  while (true) {
    try {
      if (inside(await realpath(parent))) throw Error('Le dossier de sortie doit être hors dépôt.');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      parent = dirname(parent);
    }
  }
  await mkdir(target, { recursive: true });
  return realpath(target);
}

export async function atomicJson(path, value) {
  const temp = path + '.tmp';
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, path);
}

export function cliArgs(argv, allowed) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!allowed.includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--') || args[argv[i]])
      throw Error('Arguments invalides. Consulter scripts/backtest/README.md.');
    args[argv[i]] = argv[i + 1];
  }
  return args;
}

export const isMain = (url) => process.argv[1] && resolve(process.argv[1]) === fileURLToPath(url);
