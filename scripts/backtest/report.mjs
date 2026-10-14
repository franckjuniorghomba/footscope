const num = (v) => (v === null || v === undefined ? 'non défini' : v.toFixed(4));
const pct = (v) => (v === null || v === undefined ? 'non défini' : (100 * v).toFixed(1) + ' %');
const interval = (v) =>
  v?.interval95 ? `[${num(v.interval95[0])} ; ${num(v.interval95[1])}]` : 'non défini';

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
    '# BIS-167 — banc temporel sans cotes',
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
        '| Marché | Référence | Événements | Matchs | Brier | IC Brier | Log-loss | IC log-loss |',
        '| --- | --- | ---: | ---: | ---: | --- | ---: | --- |',
      );
      for (const [market, group] of Object.entries(metrics))
        for (const label of ['poisson', 'prudent', 'naive']) {
          const s = group[label];
          lines.push(
            `| ${market} | ${label} | ${s.count} | ${s.matches} | ${num(s.brier)} | ${interval(group.intervals[`${label}_brier`])} | ${num(s.logLoss)} | ${interval(group.intervals[`${label}_logLoss`])} |`,
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
        'Calibration (cellules : probabilité moyenne / fréquence observée / effectif) :',
        '',
        '| Marché | Classe | Poisson | Prudent | Naïf |',
        '| --- | --- | --- | --- | --- |',
      );
      for (const [market, group] of Object.entries(metrics))
        for (let i = 0; i < 10; i++) {
          const cells = ['poisson', 'prudent', 'naive'].map((k) => {
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
      `| Passage − prudent | ${num(s.gap)} | ${interval(s.intervals.gap)} |`,
      `| Passage − naïf | ${num(s.naiveGap)} | ${interval(s.intervals.naiveGap)} |`,
      `| Différence Brier tickets Poisson − naïf | ${num(s.intervals.brierDifference.estimate)} | ${interval(s.intervals.brierDifference)} |`,
      '',
    );
  }
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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="850" height="710" viewBox="0 0 850 710"><rect width="850" height="710" fill="white"/><g font-family="sans-serif" font-size="14"><text x="30" y="20">Calibration du test — ${report.kind === 'demonstration' ? 'DÉMONSTRATION SYNTHÉTIQUE' : 'résultats historiques'}</text>${panels}<text x="30" y="690" fill="#2563eb">Poisson</text><text x="150" y="690" fill="#7c3aed">Prudent</text><text x="280" y="690" fill="#b45309">Naïf</text><text x="400" y="690">Vertical : fréquence observée (0–1)</text></g></svg>\n`;
}
