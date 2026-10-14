import { open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  atomicJson,
  cliArgs,
  defaultPlan,
  externalDirectory,
  isMain,
  normalizeFixture,
  readJson,
  sha256,
  validateDataset,
  validatePlan,
} from './data.mjs';

const MAX_CALLS = 30;
const SPACING_MS = 6500;

// Un seul périmètre figé, un seul dossier de collecte, aucun retry automatique.
export async function collect({
  out,
  key,
  plan = defaultPlan,
  fetchImpl = fetch,
  wait = sleep,
  now = Date.now,
}) {
  validatePlan(plan);
  out = await externalDirectory(out);
  const lockPath = join(out, 'collect.lock');
  const lock = await open(lockPath, 'wx').catch(() => {
    throw Error('Collecteur déjà actif ou verrou à examiner.');
  });
  try {
    const journalPath = join(out, 'collection.json');
    const planHash = sha256(JSON.stringify(plan));
    let journal;
    try {
      journal = await readJson(journalPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw Error('Journal de collecte illisible.');
      journal = { schemaVersion: 1, planHash, attempts: [], files: {} };
    }
    if (
      journal.schemaVersion !== 1 ||
      journal.planHash !== planHash ||
      !Array.isArray(journal.attempts) ||
      journal.attempts.length > MAX_CALLS ||
      !journal.files
    )
      throw Error('Journal incompatible avec le plan figé.');
    const pairs = new Set(plan.leagues.flatMap((l) => plan.seasons.map((s) => `${l}-${s}`)));
    if (
      journal.attempts.some((a) => !pairs.has(a?.id) || !Number.isFinite(Date.parse(a.at))) ||
      new Set(journal.attempts.map((a) => a.id)).size !== journal.attempts.length ||
      Object.entries(journal.files).some(
        ([id, file]) =>
          !pairs.has(id) ||
          !journal.attempts.some((a) => a.id === id) ||
          !/^[a-f0-9]{64}$/.test(file?.sha256) ||
          !Number.isSafeInteger(file.count) ||
          file.count <= 0,
      )
    )
      throw Error('Journal de budget ou de cache incohérent.');
    const fixtures = [];
    for (const league of plan.leagues)
      for (const season of plan.seasons) {
        const id = `${league}-${season}`;
        const path = join(out, `fixtures-${id}.json`);
        if (journal.files[id]) {
          const bytes = await readFile(path);
          if (sha256(bytes) !== journal.files[id].sha256)
            throw Error('Cache altéré : collecte suspendue.');
          const cached = JSON.parse(bytes);
          validateDataset({
            schemaVersion: 1,
            kind: 'historical',
            source: 'API-Football',
            fixtures: cached,
          });
          if (
            cached.length !== journal.files[id].count ||
            cached.some((f) => f.league.id !== league || f.league.season !== season)
          )
            throw Error('Périmètre du cache incohérent.');
          fixtures.push(...cached);
          continue;
        }
        if (journal.attempts.some((x) => x.id === id))
          throw Error('Tentative déjà consommée sans cache : intervention requise, aucun retry.');
        if (journal.attempts.length >= MAX_CALLS)
          throw Error('Budget maximal de trente appels atteint.');
        if (!key)
          throw Error(
            'API_FOOTBALL_KEY absente : aucun appel effectué. Voir la commande de collecte dans le README.',
          );
        const previous = journal.attempts.at(-1)?.at;
        if (previous) await wait(Math.max(0, SPACING_MS - (now() - Date.parse(previous))));
        // Réserver le budget AVANT le réseau : les interruptions et refus consomment une tentative.
        journal.attempts.push({ id, at: new Date(now()).toISOString() });
        await atomicJson(journalPath, journal);
        let response;
        try {
          response = await fetchImpl(
            `https://v3.football.api-sports.io/fixtures?league=${league}&season=${season}`,
            {
              headers: { 'x-apisports-key': key },
              signal: AbortSignal.timeout(30000),
              redirect: 'error',
            },
          );
        } catch {
          throw Error('Transport fournisseur interrompu ; tentative consommée, aucun retry.');
        }
        if (!response.ok)
          throw Error(
            `Refus fournisseur HTTP ${response.status} ; collecte suspendue, aucun retry.`,
          );
        let body;
        try {
          body = await response.json();
        } catch {
          throw Error('Réponse fournisseur illisible.');
        }
        if (
          !body ||
          Object.keys(body.errors || {}).length ||
          !Array.isArray(body.response) ||
          !body.response.length ||
          body.results !== body.response.length ||
          body.paging?.total !== 1 ||
          body.paging?.current !== 1
        )
          throw Error(
            'Réponse fournisseur incomplète, vide, paginée ou en erreur ; collecte suspendue.',
          );
        const normalized = body.response.map(normalizeFixture);
        validateDataset({
          schemaVersion: 1,
          kind: 'historical',
          source: 'API-Football',
          fixtures: normalized,
        });
        if (normalized.some((x) => x.league.id !== league || x.league.season !== season))
          throw Error('Périmètre fournisseur incohérent.');
        await atomicJson(path, normalized);
        journal.files[id] = { sha256: sha256(await readFile(path)), count: normalized.length };
        await atomicJson(journalPath, journal);
        fixtures.push(...normalized);
      }
    const dataset = validateDataset({
      schemaVersion: 1,
      kind: 'historical',
      source: 'API-Football',
      plan,
      collection: { calls: journal.attempts.length, files: journal.files },
      fixtures,
    });
    const path = join(out, 'dataset.json');
    await atomicJson(path, dataset);
    const checksum = sha256(await readFile(path));
    await atomicJson(join(out, 'dataset-checksum.json'), {
      file: 'dataset.json',
      sha256: checksum,
      planHash,
    });
    return { path, calls: journal.attempts.length, fixtures: fixtures.length, sha256: checksum };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

if (isMain(import.meta.url)) {
  try {
    const args = cliArgs(process.argv.slice(2), ['--out']);
    if (!args['--out']) throw Error('Argument --out requis (dossier hors dépôt).');
    const result = await collect({ out: args['--out'], key: process.env.API_FOOTBALL_KEY });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
