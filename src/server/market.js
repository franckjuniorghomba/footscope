import { POLICY } from './policy.js';

// Repère descriptif seulement : les trois issues doivent provenir du même
// relevé/bookmaker. Jamais de regroupement, ni de normalisation Double Chance.
export function marketReference(records, now = Date.now()) {
  const references = [];
  if (!Array.isArray(records) || !Number.isFinite(now)) return references;
  for (const record of records) {
    const age = typeof record?.update === 'string' ? now - Date.parse(record.update) : NaN;
    if (!Number.isFinite(age) || age < -300000 || age > POLICY.maxOddsAgeMs) continue;
    if (!Array.isArray(record.bookmakers)) continue;
    for (const book of record.bookmakers) {
      if (typeof book?.name !== 'string' || !book.name.trim() || !Array.isArray(book.bets))
        continue;
      for (const market of book.bets) {
        if (market?.name !== 'Match Winner' || !Array.isArray(market.values)) continue;
        if (market.values.length !== 3) continue;
        const odds = {};
        for (const quote of market.values) {
          if (!['Home', 'Draw', 'Away'].includes(quote?.value)) break;
          if (Object.hasOwn(odds, quote.value)) break;
          const raw = quote.odd;
          if (typeof raw !== 'number' && typeof raw !== 'string') break;
          if (typeof raw === 'string' && !/^\d+(?:\.\d+)?$/.test(raw.trim())) break;
          const odd = Number(raw);
          if (!Number.isFinite(odd) || odd <= 1) break;
          odds[quote.value] = odd;
        }
        if (Object.keys(odds).length !== 3) continue;
        const impliedSum = Object.values(odds).reduce((sum, odd) => sum + 1 / odd, 0);
        references.push({
          bookmaker: book.name,
          updated: record.update,
          name: 'Match Winner',
          method: 'proportional',
          odds,
          probabilities: Object.fromEntries(
            Object.entries(odds).map(([selection, odd]) => [selection, 1 / odd / impliedSum]),
          ),
          overround: impliedSum - 1,
          explanation:
            'Marge implicite = somme des inverses des trois cotes moins 1. Probabilités sans marge par normalisation proportionnelle ; repère descriptif, sans effet sur les décisions.',
        });
      }
    }
  }
  return references;
}
