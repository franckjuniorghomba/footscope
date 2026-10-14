import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  COLLECTION_DAY,
  atomicJson,
  cliArgs,
  combineDatasets,
  externalDirectory,
  isMain,
  sha256,
} from './data.mjs';
import { runBacktest } from './engine.mjs';
import { calibrationSvg, markdownReport } from './report.mjs';

async function verifiedDataset(input) {
  const bytes = await readFile(input),
    dataset = JSON.parse(bytes);
  if (dataset.kind === 'historical') {
    const checksum = JSON.parse(
      await readFile(join(dirname(input), 'dataset-checksum.json'), 'utf8'),
    );
    if (
      checksum.file !== basename(input) ||
      checksum.sha256 !== sha256(bytes) ||
      checksum.planHash !== sha256(JSON.stringify(dataset.plan))
    )
      throw Error('Jeu historique altéré depuis sa collecte.');
  }
  return { bytes, dataset };
}

// BIS-185 : un jeu à période neuve exige l'historique épinglé par son plan (--history).
export async function writeReport(input, out, { history } = {}) {
  out = await externalDirectory(out);
  const verified = await verifiedDataset(input),
    bytes = verified.bytes;
  let dataset = verified.dataset;
  const fresh = dataset.plan?.testEnd === COLLECTION_DAY;
  if (fresh !== Boolean(history))
    throw Error('--history est requis pour un plan à période neuve, et réservé à ce cas.');
  if (fresh) {
    const past = await verifiedDataset(history);
    dataset = combineDatasets({
      history: past.dataset,
      historySha256: sha256(past.bytes),
      current: dataset,
      currentSha256: sha256(bytes),
    });
  }
  const start = performance.now();
  const report = runBacktest(dataset);
  report.elapsedMs = performance.now() - start;
  report.maxRssKiB = process.resourceUsage().maxRSS;
  report.inputSha256 = sha256(bytes);
  if (fresh) report.sources = dataset.sources;
  report.planSha256 = sha256(JSON.stringify(report.plan));
  await atomicJson(join(out, 'report.json'), report);
  await writeFile(join(out, 'rapport-backtest.md'), markdownReport(report));
  await writeFile(join(out, 'calibration.svg'), calibrationSvg(report));
  return {
    kind: report.kind,
    matches: report.test.matches,
    tickets: report.test.tickets.count,
    out,
  };
}

if (isMain(import.meta.url)) {
  try {
    const args = cliArgs(process.argv.slice(2), ['--input', '--out', '--history']);
    if (!args['--input'] || !args['--out']) throw Error('Arguments --input et --out requis.');
    console.log(
      JSON.stringify(
        await writeReport(args['--input'], args['--out'], { history: args['--history'] }),
      ),
    );
  } catch {
    console.error(
      'Backtest interrompu : entrée, périmètre ou dossier invalides. Aucun résultat partiel annoncé.',
    );
    process.exitCode = 1;
  }
}
