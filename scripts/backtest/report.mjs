import { verdict } from './dixon-coles.mjs';

const num = (v) => (v === null || v === undefined ? 'non défini' : v.toFixed(4));
const pct = (v) => (v === null || v === undefined ? 'non défini' : (100 * v).toFixed(1) + ' %');
const interval = (v) =>
  v?.interval95 ? `[${num(v.interval95[0])} ; ${num(v.interval95[1])}]` : 'non défini';
const LABELS = {
  poisson: 'poisson',
  prudent: 'prudent',
  naive: 'naive',
  dixonColes: 'dixon-coles',
};

function dixonColesProtocol(report) {
  const dc = report.dixonColes;
  return [
    '### Dixon-Coles (BIS-183, banc uniquement)',
    '',
    `Modèle : ${dc.version}. Par ligue : intercept, avantage du terrain, attaque et défense par équipe, correction ρ appliquée seulement aux scores 0-0, 1-0, 0-1 et 1-1, bornée par |ρ| ≤ ${dc.rhoBound} (ρ = ${dc.rhoBound} × tanh z, borne structurelle fixe). Contraintes d’identifiabilité : somme des attaques = somme des défenses = 0 dans chaque ligue. Maximum de vraisemblance pondéré par exp(−ξ × âge en jours), L-BFGS déterministe, départ à chaud depuis l’ajustement précédent de la ligue.`,
    '',
    'Réajustement : au plus une fois par ligue et par journée GMT−5, avec les seules rencontres FT de la ligue des journées strictement antérieures (toutes saisons collectées). Une prédiction après apprentissage du jour même lève une erreur.',
    '',
    `Rétrécissement : pénalité ridge ½ × ridge × Σ(attaque² + défense²), soit un prior gaussien centré sur la moyenne de la ligue. Une équipe promue ou peu observée reste près de cette moyenne tant que ses matchs ne l’en écartent pas. Les prédictions dont une équipe compte moins de ${dc.lowHistoryMatches} matchs de ligue antérieurs sont comptées ci-dessous. Une rencontre sans prédiction Dixon-Coles est exclue pour tous les modèles avec son motif.`,
    '',
    `Grille fixe : ξ ∈ {${dc.grid.xi.join(' ; ')}} par jour × ridge ∈ {${dc.grid.ridge.join(' ; ')}}. Règle : ${dc.selectionRule.criterion}, sur les rencontres FT de la saison de développement dont les deux équipes ont au moins ${dc.selectionRule.minTeamMatches} matchs de ligue antérieurs. Seules les rencontres antérieures à ${report.plan.testStart} sont transmises à ce choix ; la saison test n’est lue qu’une fois, avec les paramètres figés.`,
    '',
    '| ξ | Demi-vie (jours) | ridge | Brier 1X2 | Brier Plus/moins | Brier les deux marquent | Critère | Événements | Échecs |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...dc.developmentGrid.map(
      (r) =>
        `| ${r.xi} | ${r.halfLifeDays ? r.halfLifeDays.toFixed(0) : '∞'} | ${r.ridge} | ${num(r.perMarket['Match Winner'])} | ${num(r.perMarket['Goals Over/Under'])} | ${num(r.perMarket['Both Teams Score'])} | ${num(r.score)} | ${r.events} | ${r.failures + r.nonConverged} |`,
    ),
    '',
    dc.chosen
      ? `**Retenu avant lecture du test : ξ = ${dc.chosen.xi}, ridge = ${dc.chosen.ridge}.**${dc.chosen.xi === dc.grid.xi.at(-1) || [dc.grid.ridge[0], dc.grid.ridge.at(-1)].includes(dc.chosen.ridge) ? ' Ce point touche le bord de la grille ; la grille n’est pas étendue après coup.' : ''}`
      : '**Aucun point de grille évaluable en développement : aucune prédiction Dixon-Coles, rencontres exclues.**',
    '',
    `Passe finale : ${dc.stats.fits} ajustements, ${dc.stats.iterations} itérations (maximum ${dc.stats.maxIterations} pour un ajustement), ${dc.stats.nonConverged} non convergé(s), ${dc.stats.rhoAtBound} ajustement(s) avec |ρ| au bord ${dc.rhoBound} (optimum contraint), ${dc.stats.predictions} prédictions dont ${dc.stats.lowHistoryPredictions} avec une équipe sous ${dc.lowHistoryMatches} matchs de ligue antérieurs.`,
    '',
    'Différences appariées dixon-coles − Poisson : mêmes événements et mêmes tirages de journées ; négatif favorise Dixon-Coles. Verdict : « meilleur » si la différence de Brier est négative et que son IC 95 % exclut 0, « pire » dans le cas symétrique, sinon « indistinct ». ECE : moyenne des écarts |probabilité moyenne − fréquence| des classes de 0,1, pondérée par leur effectif.',
    '',
  ];
}

function dixonColesVerdicts(report) {
  const rows = Object.entries(report.test.allEvents).map(([market, group]) => {
    const b = group.intervals.dixonColesBrierDifference;
    return `| ${market} | ${num(group.poisson.brier)} | ${num(group.dixonColes.brier)} | ${num(b.estimate)} | ${interval(b)} | ${num(group.poisson.ece)} | ${num(group.dixonColes.ece)} | **${verdict(b)}** |`;
  });
  return [
    '## Verdict Dixon-Coles par marché (test figé, tous les événements évaluables)',
    '',
    '| Marché | Brier Poisson | Brier dixon-coles | Différence | IC 95 % | ECE Poisson | ECE dixon-coles | Verdict |',
    '| --- | ---: | ---: | ---: | --- | ---: | ---: | --- |',
    ...rows,
    '',
    'Verdict mécanique, sans décision de mise en production : modelValidated=false et realMoneyEligible=false ; statistics.js et policy.js inchangés.',
    '',
  ];
}

export function markdownReport(report) {
  const test = report.test,
    t = test.tickets;
  const conclusion = [
    report.kind === 'demonstration'
      ? 'Ce rapport utilise uniquement des résultats synthétiques : il ne prouve aucune performance réelle.'
      : 'Ce rapport décrit une évaluation chronologique sur des résultats historiques figés.',
    `Le test comprend ${test.matches} rencontres et ${t.count} tickets conditionnels ; ${test.noTicketDays} journées ne produisent aucun ticket.`,
    `Ces tickets passent dans ${pct(t.passRate)} des cas, contre ${pct(t.announced)} annoncés par la sensibilité prudente et ${pct(t.naive)} par la référence naïve sur les mêmes jambes.`,
    'Sans cotes ni preuves avant match, nous ne pouvons conclure ni sur les tickets complets de production, ni sur leur rendement, ni sur un avantage face au marché.',
    'Le modèle reste non validé ; une validation indépendante sur données réelles et une décision du responsable sont nécessaires.',
  ];
  const lines = [
    '# BIS-167 / BIS-183 — banc temporel sans cotes, Poisson et Dixon-Coles',
    '',
    `Nature : **${report.kind === 'demonstration' ? 'DÉMONSTRATION SYNTHÉTIQUE — aucune preuve prédictive' : 'historique API-Football'}**.`,
    '',
    `Modèle : ${report.modelVersion}. SHA-256 entrée : \`${report.inputSha256}\`. SHA-256 plan : \`${report.planSha256}\`.`,
    '',
    `Développement : ${report.plan.developmentStart} ≤ journée < ${report.plan.testStart}. Test : ${report.plan.testStart} ≤ journée < ${report.plan.testEnd}, GMT−5 fixe.`,
    '',
    `Durée locale : ${report.elapsedMs.toFixed(1)} ms ; RSS de pointe du processus : ${(report.maxRssKiB / 1024).toFixed(1)} MiB. Aucun appel réseau pendant le backtest.`,
    '',
    '## Couverture et protocole',
    '',
    `Entrée : ${report.coverage.input} rencontres, dont ${report.coverage.completed} FT. Toutes les rencontres du périmètre sont parcourues.`,
    '',
    'Brier et log-loss sont des scores binaires moyens par événement, y compris les issues qui se chevauchent en double chance. Les classes de calibration ont une largeur de 0,1 ; la dernière inclut 1. Le bornage de la log-loss est 10⁻¹².',
    '',
    'Un ticket au plus par journée de rencontres GMT−5. Référence naïve : fréquences passées de la ligue avec Laplace ; comparaison sur les mêmes événements et les mêmes jambes. Les résultats du jour ne sont appris qu’après toutes ses prédictions.',
    '',
    `IC percentile à 95 % : ${report.plan.bootstrapReplicates} réplications par journées complètes, graine ${report.plan.seed}. Différences appariées (Poisson − naïf) : une valeur négative favorise Poisson. Une seule journée ne permet pas d’IC. Un petit effectif peut donner un intervalle dégénéré.`,
    '',
    ...dixonColesProtocol(report),
    'Exclusions (phase : motif → rencontres) :',
    '',
    ...Object.entries(report.coverage.exclusions).map(([k, v]) => `- ${k} : ${v}`),
    '',
  ];
  for (const [name, phase] of [
    ['Développement', report.development],
    ['Test figé', report.test],
  ]) {
    lines.push(
      `## ${name}`,
      '',
      `${phase.matches} rencontres ; ${phase.days} journées ; ${phase.noTicketDays} journées sans ticket.`,
      '',
    );
    for (const [scope, metrics] of [
      ['Tous les événements évaluables', phase.allEvents],
      ['Sélections retenues dans les tickets', phase.selectedEvents],
    ]) {
      lines.push(
        `### ${scope}`,
        '',
        '| Marché | Référence | Événements | Matchs | Brier | IC Brier | Log-loss | IC log-loss | ECE |',
        '| --- | --- | ---: | ---: | ---: | --- | ---: | --- | ---: |',
      );
      for (const [market, group] of Object.entries(metrics))
        for (const label of Object.keys(LABELS)) {
          const s = group[label];
          lines.push(
            `| ${market} | ${LABELS[label]} | ${s.count} | ${s.matches} | ${num(s.brier)} | ${interval(group.intervals[`${label}_brier`])} | ${num(s.logLoss)} | ${interval(group.intervals[`${label}_logLoss`])} | ${num(s.ece)} |`,
          );
        }
      lines.push(
        '',
        '| Marché | Différence Brier Poisson − naïf | IC | Différence log-loss | IC |',
        '| --- | ---: | --- | ---: | --- |',
      );
      for (const [market, group] of Object.entries(metrics))
        lines.push(
          `| ${market} | ${num(group.intervals.brierDifference.estimate)} | ${interval(group.intervals.brierDifference)} | ${num(group.intervals.logLossDifference.estimate)} | ${interval(group.intervals.logLossDifference)} |`,
        );
      lines.push(
        '',
        '| Marché | Différence Brier dixon-coles − Poisson | IC | Différence log-loss | IC | Verdict |',
        '| --- | ---: | --- | ---: | --- | --- |',
      );
      for (const [market, group] of Object.entries(metrics)) {
        const b = group.intervals.dixonColesBrierDifference,
          l = group.intervals.dixonColesLogLossDifference;
        lines.push(
          `| ${market} | ${num(b.estimate)} | ${interval(b)} | ${num(l.estimate)} | ${interval(l)} | ${verdict(b)} |`,
        );
      }
      lines.push(
        '',
        'Calibration (cellules : probabilité moyenne / fréquence observée / effectif) :',
        '',
        '| Marché | Classe | Poisson | Prudent | Naïf | Dixon-Coles |',
        '| --- | --- | --- | --- | --- | --- |',
      );
      for (const [market, group] of Object.entries(metrics))
        for (let i = 0; i < 10; i++) {
          const cells = Object.keys(LABELS).map((k) => {
            const b = group[k].calibration[i];
            return `${num(b.predicted)} / ${num(b.observed)} / ${b.count}`;
          });
          lines.push(`| ${market} | ${i / 10}–${(i + 1) / 10} | ${cells.join(' | ')} |`);
        }
      lines.push('');
    }
    const s = phase.tickets;
    lines.push(
      '### Tickets conditionnels sans prix',
      '',
      `Tickets : ${s.count}, journées avec ticket : ${s.days}, tailles : ${JSON.stringify(s.bySize)}.`,
      '',
      '| Mesure | Valeur | IC 95 % |',
      '| --- | ---: | --- |',
      `| Passage observé | ${pct(s.passRate)} | ${interval(s.intervals.passRate)} |`,
      `| Annoncé prudent | ${pct(s.announced)} | ${interval(s.intervals.announced)} |`,
      `| Annoncé Poisson exploratoire | ${pct(s.exploratory)} | ${interval(s.intervals.exploratory)} |`,
      `| Annoncé naïf, mêmes jambes | ${pct(s.naive)} | ${interval(s.intervals.naive)} |`,
      `| Annoncé dixon-coles, mêmes jambes | ${pct(s.dixonColes)} | ${interval(s.intervals.dixonColes)} |`,
      `| Passage − prudent | ${num(s.gap)} | ${interval(s.intervals.gap)} |`,
      `| Passage − naïf | ${num(s.naiveGap)} | ${interval(s.intervals.naiveGap)} |`,
      `| Passage − dixon-coles | ${num(s.dixonColesGap)} | ${interval(s.intervals.dixonColesGap)} |`,
      `| Différence Brier tickets Poisson − naïf | ${num(s.intervals.brierDifference.estimate)} | ${interval(s.intervals.brierDifference)} |`,
      `| Différence Brier tickets dixon-coles − Poisson | ${num(s.intervals.dixonColesBrierDifference.estimate)} | ${interval(s.intervals.dixonColesBrierDifference)} |`,
      '',
    );
  }
  lines.push(...dixonColesVerdicts(report));
  lines.push(
    '## Comparaisons reportées et limites',
    '',
    `- Marché sans marge : ${report.deferred.marketComparison}`,
    `- Rendement : ${report.deferred.yield}`,
    ...report.limitations.map((x) => '- ' + x),
    '',
    'Options de source à décider par le responsable : autorisation contractuelle d’un fournisseur de cotes historiques, ou archivage prospectif de cotes avec droits adaptés. Aucun achat ni appel de cotes n’est autorisé. football-data.co.uk est exclu du banc.',
    '',
    '## Conclusion en cinq lignes',
    '',
    ...conclusion.map((x, i) => `${i + 1}. ${x}`),
    '',
    'Ingénieur données — aucune migration SQL, aucune écriture en production, modelValidated=false et realMoneyEligible=false.',
    '',
  );
  return lines.join('\n');
}

export function calibrationSvg(report) {
  const markets = Object.entries(report.test.allEvents);
  const panels = markets
    .map(([market, group], i) => {
      const x = 70 + (i % 2) * 400,
        y = 50 + Math.floor(i / 2) * 320;
      const curves = [
        ['poisson', '#2563eb'],
        ['prudent', '#7c3aed'],
        ['naive', '#b45309'],
        ['dixonColes', '#047857'],
      ]
        .map(([k, color]) => {
          const bins = group[k].calibration.filter((b) => b.count);
          return (
            `<polyline fill="none" stroke="${color}" points="${bins.map((b) => `${x + 250 * b.predicted},${y + 250 * (1 - b.observed)}`).join(' ')}"/>` +
            bins
              .map(
                (b) =>
                  `<circle cx="${x + 250 * b.predicted}" cy="${y + 250 * (1 - b.observed)}" r="4" fill="${color}"><title>${k}: n=${b.count}</title></circle>`,
              )
              .join('')
          );
        })
        .join('');
      return `<text x="${x}" y="${y - 12}">${market}</text><path d="M${x},${y} v250 h250" fill="none" stroke="#222"/><path d="M${x},${y + 250} l250,-250" stroke="#aaa" stroke-dasharray="4"/>${curves}<text x="${x + 90}" y="${y + 275}">Probabilité annoncée</text>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="850" height="710" viewBox="0 0 850 710"><rect width="850" height="710" fill="white"/><g font-family="sans-serif" font-size="14"><text x="30" y="20">Calibration du test — ${report.kind === 'demonstration' ? 'DÉMONSTRATION SYNTHÉTIQUE' : 'résultats historiques'}</text>${panels}<text x="30" y="690" fill="#2563eb">Poisson</text><text x="150" y="690" fill="#7c3aed">Prudent</text><text x="250" y="690" fill="#b45309">Naïf</text><text x="330" y="690" fill="#047857">Dixon-Coles</text><text x="480" y="690">Vertical : fréquence observée (0–1)</text></g></svg>\n`;
}
