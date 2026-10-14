// BIS-184 : marge de prudence m apprise sur 2024/25, figée, puis sélection A contre B.
// Trois étapes dans cet ordre, sans retour : `freeze` (2024/25 → fichier de paramètres),
// `control` (2025/26, déjà lue par BIS-167 et BIS-183), `evaluate` (2026/27, lue une fois).
// Aucun réseau, aucun secret ; statistics.js, policy.js et modelValidated restent intacts.
import { open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  cliArgs,
  combineDatasets,
  externalDirectory,
  isMain,
  loadPlan,
  repoRoot,
  sha256,
} from './data.mjs';
import { runBacktest } from './engine.mjs';
import { DIXON_COLES_VERSION, selectDixonColes } from './dixon-coles.mjs';
import { verifiedDataset } from './run.mjs';
import {
  MARGIN_RULE,
  SIZES,
  chooseMargin,
  composeTickets,
  legErrors,
  selectionA,
  selectionB,
  summarizeTickets,
} from './selection.mjs';

export const NO_YIELD =
  'Ce rapport mesure seulement si la probabilité annoncée d’un ticket est juste. Il ne dit RIEN du rendement : aucune cote historique n’est disponible, aucun gain n’est promis.';

const sortFixtures = (xs) =>
  [...xs].sort((a, b) => a.fixture.timestamp - b.fixture.timestamp || a.fixture.id - b.fixture.id);

// Compare A et B sur les mêmes journées d'une phase (mêmes prévisions, mêmes règles).
export function compare(phase, margin, { replicates, seed }) {
  const ticketsA = composeTickets(phase.forecasts, selectionA),
    ticketsB = composeTickets(phase.forecasts, selectionB(margin));
  // Parité : la sélection A recomposée doit égaler le ticket du moteur, journée par journée.
  const engine = phase.ticketRecords.map((t) => ({
    day: t.day,
    legs: t.selections.map((r) => `${r.matchId}:${r.market}:${r.selection}`),
  }));
  const recomposed = ticketsA.map((t) => ({
    day: t.day,
    legs: t.legs.map((r) => `${r.matchId}:${r.market}:${r.selection}`),
  }));
  if (JSON.stringify(engine) !== JSON.stringify(recomposed))
    throw Error('Sélection A différente du moteur : comparaison refusée.');
  const opts = { days: phase.days, replicates, seed };
  return {
    days: phase.days,
    matches: phase.matches,
    A: summarizeTickets(ticketsA, opts),
    B: summarizeTickets(ticketsB, opts),
    tickets: { A: ticketsA, B: ticketsB },
  };
}

// Étape 1 : uniquement l'historique (2023-2025). Le jeu 2026/27 n'est ni ouvert ni lu.
export function freezeMargin(history, plan2026) {
  // (ξ, ridge) du modèle testé en 2026/27 : choisis sur 2025/26 comme dans run.mjs --history ;
  // seules les rencontres antérieures à testStart (2026-07-01) sont transmises.
  const chosen = selectDixonColes(sortFixtures(history.fixtures), plan2026).chosen;
  if (!chosen) throw Error('Aucun paramètre Dixon-Coles choisi : marge non calculable.');
  const report = runBacktest(history, history.plan, { dixonColesChosen: chosen });
  const dev = report.development;
  const margin = chooseMargin(dev.forecasts);
  return {
    report,
    params: {
      schemaVersion: 1,
      issue: 'BIS-184',
      rule: MARGIN_RULE,
      margin: margin.margin,
      ceiling: margin.ceiling,
      dixonColes: { version: DIXON_COLES_VERSION, xi: chosen.xi, ridge: chosen.ridge },
      dixonColesChoice:
        'ξ et ridge choisis sur 2025/26 (plan-2026.json), comme le run 2026/27 ; m est mesurée avec ce même modèle',
      selections: {
        A: 'Poisson prudent (sélection actuelle) : jambe si probabilité Poisson ≥ 0,7 et historique récent ; annoncé = probabilité prudente ; produit ≥ 0,5',
        B: 'Dixon-Coles − m : jambe si probabilité Dixon-Coles ≥ 0,7 et historique récent ; annoncé = max(0, p − m) ; produit ≥ 0,5',
        common: 'un ticket par journée GMT−5, un pari par match, quatre jambes au plus',
      },
      verdictRule:
        '« annoncé fiable » si l’IC à 95 % de (observé − annoncé) contient 0 et |écart| < 5 points ; sinon « optimiste » (observé < annoncé) ou « pessimiste »',
      sources: {
        historySha256: plan2026.history.sha256,
        historyPlanHash: plan2026.history.planHash,
        plan2026Sha256: sha256(JSON.stringify(plan2026)),
      },
      development: {
        days: dev.days,
        matches: dev.matches,
        legErrors: legErrors(dev.forecasts),
        search: margin.search,
      },
      modelValidated: false,
      realMoneyEligible: false,
    },
  };
}

const pct = (x) => (Number.isFinite(x) ? (100 * x).toFixed(1).replace('.', ',') + ' %' : '—');
const pts = (x) =>
  Number.isFinite(x) ? (x >= 0 ? '+' : '') + (100 * x).toFixed(1).replace('.', ',') : '—';
const ci = (xs, f) => (xs ? `[${f(xs[0])} ; ${f(xs[1])}]` : 'non défini');
const num = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d).replace('.', ',') : '—');

export function sizeTable(result) {
  const lines = [
    '| Sélection | Taille | Tickets | Effectif | Annoncé | Observé (IC 95 %) | Observé − annoncé, pts (IC 95 %) | Brier | Verdict |',
    '| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const name of ['A', 'B'])
    for (const k of [...SIZES, 'total']) {
      const r = k === 'total' ? result[name].total : result[name].bySize[k];
      const n = r.count;
      lines.push(
        `| ${name} | ${k === 'total' ? 'total' : k} | ${n} | ${n ? (r.lowSample ? 'faible (< 30)' : 'suffisant') : 'nul'} | ${n ? pct(r.announced) : 'non défini'} | ${n ? `${pct(r.observed)} ${ci(r.observedInterval95, pct)}` : 'non défini'} | ${n ? `${pts(r.gap)} ${ci(r.gapInterval95, pts)}` : 'non défini'} | ${n ? num(r.brier) : 'non défini'} | ${r.verdict} |`,
      );
    }
  lines.push(
    '',
    `Journées : ${result.days} ; sans ticket : A ${result.A.noTicketDays}, B ${result.B.noTicketDays}.`,
  );
  return lines.join('\n');
}

export function conclusion(result) {
  return [...SIZES, 'total']
    .map((k) => {
      const v = (s) => (k === 'total' ? result[s].total : result[s].bySize[k]);
      return `- ${k === 'total' ? 'Total' : `Taille ${k}`} : A ${v('A').verdict} (n = ${v('A').count}) ; B ${v('B').verdict} (n = ${v('B').count}).`;
    })
    .join('\n');
}

export function markdown({ params, paramsSha256, control, test, sources }) {
  const e = params.development.legErrors;
  const chosen = params.development.search.find((r) => r.margin === params.margin);
  return `# BIS-184 — sélection A (Poisson prudent) contre B (Dixon-Coles − m)

> **${NO_YIELD}**

\`modelValidated\` et \`realMoneyEligible\` restent faux. Aucun appel réseau.

## Sources

- Historique 2023-2025 : SHA-256 \`${sources.history}\`.
- Période neuve 2026/27 : SHA-256 \`${sources.current}\`, collectée le ${sources.collectedAt}, évaluée du 2026-07-01 au ${sources.testEnd} (exclu).
- Fichier de paramètres \`scripts/backtest/margin-2026.json\` : SHA-256 \`${paramsSha256}\`, committé avant la lecture de 2026/27.

## 1. Marge m apprise sur 2024/25 (développement)

Règle fixée d'avance : ${params.rule.condition} ; ${params.rule.choice} ; grille ${params.rule.grid}.
Dixon-Coles : ξ = ${params.dixonColes.xi}, ridge = ${params.dixonColes.ridge} (${params.dixonColesChoice}).

Erreurs Dixon-Coles (annoncé − observé) sur ${e.count} jambes candidates (p ≥ 0,7, historique récent) : ${pts(e.error)} pts (annoncé ${pct(e.announced)}, observé ${pct(e.observed)}).
${e.bins.map((b) => `- p ∈ [${num(b.lower, 1)} ; ${num(b.upper, 1)}[ : ${b.count} jambes, annoncé ${pct(b.announced)}, observé ${pct(b.observed)}, erreur ${pts(b.error)} pts`).join('\n')}

**m = ${params.margin}**${params.ceiling ? ' (plafond de la grille : condition jamais remplie)' : ''} : sur 2024/25, ${chosen.tickets} tickets B, annoncé ${pct(chosen.announced)}, observé ${pct(chosen.observed)}.

## 2. Contrôle secondaire 2025/26 (déjà lue)

**Attention : la saison 2025/26 a déjà été lue par BIS-167 et BIS-183 pour comparer les modèles, et elle a servi au choix de ξ et ridge.** Ce n'est pas un test intact ; il est donné à titre de contrôle.

${sizeTable(control)}

## 3. Période neuve 2026/27 (lecture unique, m figée)

${sizeTable(test)}

## Conclusion mécanique

${conclusion(test)}

Règle : ${params.verdictRule}. « Non défini » si l'effectif est nul ou inférieur à 2. Un effectif < 30 est faible : le verdict est alors peu informatif.

## Limites

- Aucune cote : ni rendement, ni avantage, ni disponibilité du marché. Tickets conditionnels aux seules probabilités.
- Produit des probabilités supposant l'indépendance des jambes.
- Le passage observé d'un petit échantillon varie beaucoup ; un « annoncé fiable » ne valide pas le modèle.
- Mise en production hors périmètre : décision du responsable.
`;
}

// Écrit un JSON une seule fois : un second lancement sur la même sortie est refusé.
export async function writeOnce(path, value) {
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function loadParams(path, expected) {
  const bytes = await readFile(path);
  if (sha256(bytes) !== expected) throw Error('Fichier de paramètres modifié depuis son gel.');
  return JSON.parse(bytes);
}

async function main(argv) {
  const [command, ...rest] = argv;
  const args = cliArgs(rest, [
    '--history',
    '--input',
    '--params',
    '--params-sha',
    '--out',
    '--control',
  ]);
  const plan2026 = await loadPlan(join(repoRoot, 'scripts/backtest/plan-2026.json'));
  const history = await verifiedDataset(args['--history']);
  if (!history.verified || sha256(history.bytes) !== plan2026.history.sha256)
    throw Error('Historique différent de celui épinglé par le plan 2026.');
  if (command === 'freeze') {
    const { params } = freezeMargin(history.dataset, plan2026);
    const bytes = JSON.stringify(params, null, 2) + '\n';
    await writeFile(args['--params'], bytes, { flag: 'wx' });
    return { margin: params.margin, ceiling: params.ceiling, sha256: sha256(bytes) };
  }
  const params = await loadParams(args['--params'], args['--params-sha']);
  const out = await externalDirectory(args['--out']);
  const replicates = history.dataset.plan.bootstrapReplicates;
  if (command === 'control') {
    const report = runBacktest(history.dataset, history.dataset.plan, {
      dixonColesChosen: params.dixonColes,
    });
    const control = compare(report.test, params.margin, { replicates, seed: 184 });
    await writeOnce(join(out, 'controle-2025-26.json'), {
      paramsSha256: args['--params-sha'],
      ...control,
    });
    return { days: control.days, A: control.A.tickets, B: control.B.tickets };
  }
  if (command === 'evaluate') {
    const control = JSON.parse(await readFile(args['--control'], 'utf8'));
    if (control.paramsSha256 !== args['--params-sha'])
      throw Error('Contrôle 2025/26 d’un autre gel.');
    // Lecture unique : le témoin est créé avant toute lecture du jeu 2026/27.
    await writeOnce(join(out, 'lecture-2026-27.json'), {
      paramsSha256: args['--params-sha'],
      startedAt: new Date().toISOString(),
    });
    const current = await verifiedDataset(args['--input']);
    if (!current.verified) throw Error('Jeu 2026/27 non vérifié.');
    const combined = combineDatasets({
      history: history.dataset,
      historySha256: sha256(history.bytes),
      current: current.dataset,
      currentSha256: sha256(current.bytes),
    });
    const report = runBacktest(combined, combined.plan, {
      analysis: true,
      dixonColesChosen: params.dixonColes,
    });
    const test = compare(report.test, params.margin, { replicates, seed: 184 });
    const sources = {
      history: combined.sources.history.sha256,
      current: combined.sources.current.sha256,
      collectedAt: combined.sources.current.collectedAt,
      testEnd: combined.plan.testEnd,
    };
    await writeOnce(join(out, 'rapport-bis184.json'), {
      paramsSha256: args['--params-sha'],
      params,
      sources,
      coverage: report.coverage,
      dixonColesStats: report.dixonColes.stats,
      control: { ...control, tickets: undefined },
      test,
      modelValidated: false,
      realMoneyEligible: false,
    });
    await writeFile(
      join(out, 'rapport-bis184.md'),
      markdown({ params, paramsSha256: args['--params-sha'], control, test, sources }),
      { flag: 'wx' },
    );
    return { days: test.days, A: test.A.tickets, B: test.B.tickets, out };
  }
  throw Error('Commande attendue : freeze, control ou evaluate.');
}

if (isMain(import.meta.url)) {
  try {
    console.log(JSON.stringify(await main(process.argv.slice(2))));
  } catch (error) {
    // Message borné : jamais de contenu de données ni de secret.
    console.error(`BIS-184 interrompu : ${String(error?.message).slice(0, 200)}`);
    process.exitCode = 1;
  }
}
