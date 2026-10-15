export const POLICY = {
  minHistory: 8,
  minProbability: 0.7,
  minPrudentEdge: 0.02,
  maxOddsAgeMs: 24 * 60 * 60000,
  // Comparaison descriptive BIS-200 : deux relevés récents, même si admissibles à 24 h.
  maxMarketOddsAgeMs: 30 * 60000,
  maxRecentAgeDays: 45,
  maxSelections: 4,
  // Probabilité prudente combinée minimale d'un ticket (produit des sélections).
  minTicketProbability: 0.5,
};
export const MODEL_VERSION = 'poisson-sensitivity-v1';
