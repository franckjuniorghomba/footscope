import { open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { cliArgs, externalDirectory, isMain, readJson } from './data.mjs';

export const MAX_CALLS = 30;
export const defaultBudgetFile = () =>
  process.env.BACKTEST_BUDGET_FILE ||
  join(
    process.env.JARVIS_LIVRABLES || '/root/.local/share/jarvis/livrables/footscope/BIS-167',
    'budget-api-football.json',
  );

async function budgetPath(file) {
  const directory = await externalDirectory(dirname(file));
  const path = join(directory, basename(file));
  try {
    // Les alias d'un même registre doivent partager le même verrou.
    const canonical = await realpath(path);
    await externalDirectory(dirname(canonical));
    return canonical;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path;
  }
}

async function locked(path, operation) {
  const lockPath = path + '.lock';
  const lock = await open(lockPath, 'wx').catch(() => {
    throw Error('Registre de budget verrouillé ou verrou à examiner.');
  });
  try {
    return await operation();
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

// Le verrou protège le renommage atomique ; fsync précède tout appel réseau.
async function persist(path, value) {
  const temp = path + '.tmp';
  const file = await open(temp, 'w', 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function initializeBudget({ budgetFile = defaultBudgetFile(), used, reason }) {
  if (!Number.isSafeInteger(used) || used < 0 || used > MAX_CALLS || !reason?.trim())
    throw Error('Initialisation explicite : --used (0 à 30) et --reason requis, sans secret.');
  const path = await budgetPath(budgetFile);
  return locked(path, async () => {
    try {
      await realpath(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw Error('Registre de budget inaccessible.');
      await persist(path, { schemaVersion: 1, initialCalls: used, reason, attempts: [] });
      return path;
    }
    throw Error('Registre existant : initialisation refusée, aucun compteur remis à zéro.');
  });
}

export async function withBudget({ budgetFile = defaultBudgetFile(), out }, operation) {
  const path = await budgetPath(budgetFile);
  const r = relative(out, path);
  if (r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r)))
    throw Error('Le registre de budget doit être hors du dossier --out.');
  return locked(path, async () => {
    let budget;
    try {
      budget = await readJson(path);
    } catch {
      // Refus même sans cache : l'absence ne peut jamais réinitialiser le budget.
      throw Error('Registre de budget absent ou illisible : intervention explicite requise.');
    }
    if (
      budget?.schemaVersion !== 1 ||
      !Number.isSafeInteger(budget.initialCalls) ||
      budget.initialCalls < 0 ||
      typeof budget.reason !== 'string' ||
      !budget.reason.trim() ||
      !Array.isArray(budget.attempts) ||
      budget.initialCalls + budget.attempts.length > MAX_CALLS ||
      budget.attempts.some(
        (a) =>
          !/^\d+-\d+$/.test(a?.id) ||
          !Number.isFinite(Date.parse(a.at)) ||
          typeof a.out !== 'string' ||
          !isAbsolute(a.out) ||
          !/^[a-f0-9]{64}$/.test(a.planHash),
      ) ||
      new Set(budget.attempts.map((a) => a.id)).size !== budget.attempts.length
    )
      throw Error('Registre de budget incohérent : collecte refusée.');
    const canReserve = (id) => {
      if (budget.initialCalls + budget.attempts.length >= MAX_CALLS)
        throw Error('Budget global maximal de trente appels atteint.');
      if (budget.attempts.some((a) => a.id === id))
        throw Error('Tentative globale déjà consommée : aucun retry, intervention requise.');
    };
    const reserve = async (attempt) => {
      canReserve(attempt.id);
      budget.attempts.push(attempt);
      await persist(path, budget);
    };
    // Verrou global tenu pendant la collecte : budget et espacement inter-dossiers.
    return operation({ budget, canReserve, reserve });
  });
}

if (isMain(import.meta.url)) {
  try {
    const args = cliArgs(process.argv.slice(2), ['--used', '--reason']);
    console.log(await initializeBudget({ used: Number(args['--used']), reason: args['--reason'] }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
