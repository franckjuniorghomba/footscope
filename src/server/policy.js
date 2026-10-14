export const POLICY = {
  minHistory: 8,
  minProbability: 0.7,
  minPrudentEdge: 0.02,
  maxOddsAgeMs: 1800000,
  maxRecentAgeDays: 45,
  maxSelections: 4,
  // Probabilité prudente combinée minimale d'un ticket (produit des sélections).
  minTicketProbability: 0.5,
};
export const MODEL_VERSION = 'poisson-sensitivity-v1';
