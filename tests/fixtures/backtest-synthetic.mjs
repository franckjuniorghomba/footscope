// Saisons synthétiques et fournisseur simulé pour les tests du banc (aucun réseau).

// Aller-retour par la méthode du cercle ; un match par heure le jour de chaque journée.
export function seasonFixtures(
  league,
  season,
  collectedAt,
  {
    teams = Array.from({ length: 8 }, (_, i) => league * 100 + i + 1),
    spacingDays = 14,
    firstId = league * 1e7 + season * 1000,
  } = {},
) {
  const n = teams.length;
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const order = [teams[0], ...teams.slice(1).map((_, i) => teams[1 + ((i + r) % (n - 1))])];
    rounds.push(Array.from({ length: n / 2 }, (_, i) => [order[i], order[n - 1 - i]]));
  }
  const all = [...rounds, ...rounds.map((xs) => xs.map(([h, a]) => [a, h]))];
  let seed = league * 7919 + season;
  const goal = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return [0, 0, 1, 1, 1, 2, 2, 3][seed % 8];
  };
  return all.flatMap((matches, round) =>
    matches.map(([home, away], i) => {
      const timestamp =
        (Date.UTC(season, 7, 5, 14) + round * spacingDays * 86400000 + i * 3600000) / 1000;
      const played = timestamp * 1000 < collectedAt;
      return {
        fixture: {
          id: firstId + round * Math.max(10, n) + i,
          date: new Date(timestamp * 1000).toISOString(),
          timestamp,
          status: { short: played ? 'FT' : 'NS' },
        },
        league: { id: league, season, name: 'Ligue synthétique', country: 'Démo' },
        teams: {
          home: { id: home, name: `Equipe fictive ${home}` },
          away: { id: away, name: `Equipe fictive ${away}` },
        },
        goals: played ? { home: goal(), away: goal() } : { home: null, away: null },
      };
    }),
  );
}

// Réponse API-Football simulée pour un couple (ligue, saison).
export const providerResponse = (response) => ({
  ok: true,
  json: async () => ({
    errors: [],
    response,
    results: response.length,
    paging: { current: 1, total: 1 },
  }),
});
