import { fairProbability } from './market.js';
import { eventProbability } from './statistics.js';
import { POLICY } from './policy.js';

const bookKey = (name) => (typeof name === 'string' ? name.trim().toLowerCase() : '');
const supported = (market, selection) =>
  (market === 'Match Winner' && ['Home', 'Draw', 'Away'].includes(selection)) ||
  (market === 'Double Chance' && ['Home/Draw', 'Draw/Away', 'Home/Away'].includes(selection)) ||
  (market === 'Both Teams Score' && ['Yes', 'No'].includes(selection)) ||
  (market === 'Goals Over/Under' && ['Over 2.5', 'Under 2.5'].includes(selection));
const age = (updated, now) => (typeof updated === 'string' ? now - Date.parse(updated) : NaN);

// Un relevé complet par bookmaker : jamais de mélange entre heures ou bookmakers.
function references(report) {
  const books = new Map();
  for (const row of Array.isArray(report.marketCouponQuotes) ? report.marketCouponQuotes : []) {
    if (row?.fixture?.id !== report.matchId || !Number.isFinite(Date.parse(row.update))) continue;
    for (const book of Array.isArray(row.bookmakers) ? row.bookmakers : []) {
      const key = bookKey(book?.name);
      if (!key || !Array.isArray(book.bets)) continue;
      // Schéma à la frontière : les données malformées ne deviennent pas un repère.
      const valid = book.bets.every(
        (bet) =>
          typeof bet?.name === 'string' &&
          Array.isArray(bet.values) &&
          bet.values.every(
            (quote) =>
              typeof quote?.value === 'string' &&
              (typeof quote.odd === 'string' || typeof quote.odd === 'number'),
          ),
      );
      const previous = books.get(key);
      if (!previous || Date.parse(row.update) > Date.parse(previous.updated))
        books.set(key, { bookmaker: book.name, updated: row.update, bets: valid ? book.bets : [] });
    }
  }
  return books;
}

export function buildMarketCoupons(reports, now = Date.now()) {
  if (!Array.isArray(reports) || !Number.isFinite(now)) return [];
  const candidates = new Map();
  for (const report of reports) {
    if (
      !Number.isInteger(report?.matchId) ||
      report.matchId < 1 ||
      typeof report.match !== 'string' ||
      !(Date.parse(report.kickoff) > now)
    )
      continue;
    const books = references(report),
      bet365 = books.get('bet365');
    const quoteAge = age(bet365?.updated, now);
    if (!bet365 || !(quoteAge >= -300000 && quoteAge < POLICY.maxOddsAgeMs)) continue;
    const refs = books.has('pinnacle') ? [books.get('pinnacle')] : [...books.values()];
    for (const bet of bet365.bets) {
      if (!Array.isArray(bet?.values)) continue;
      for (const quote of bet.values) {
        if (!supported(bet.name, quote?.value)) continue;
        // Refus des doublons ambigus dans la cote jouable.
        if (
          bet365.bets.filter((b) => b.name === bet.name).length !== 1 ||
          bet.values.filter((q) => q?.value === quote.value).length !== 1
        )
          continue;
        if (
          typeof quote.odd !== 'number' &&
          !(typeof quote.odd === 'string' && /^\d+(?:\.\d+)?$/.test(quote.odd.trim()))
        )
          continue;
        const odd = Number(quote.odd);
        if (!(Number.isFinite(odd) && odd > 1)) continue;
        const probabilities = refs.flatMap((ref) => {
          const refAge = age(ref.updated, now);
          if (!(refAge >= -300000 && refAge < POLICY.maxOddsAgeMs)) return [];
          const p = fairProbability(ref, bet.name, quote.value, now, POLICY.maxOddsAgeMs);
          return Number.isFinite(p) && p > 0 && p < 1 ? [{ probability: p, age: refAge }] : [];
        });
        if (probabilities.length < (books.has('pinnacle') ? 1 : 2)) continue;
        const marketProbability =
          probabilities.reduce((s, p) => s + p.probability, 0) / probabilities.length;
        if (marketProbability > 0.9 || marketProbability < 0.7 || marketProbability > 0.85)
          continue;
        const model = report.model;
        const modelProbability =
          model &&
          Number.isFinite(model.homeGoals) &&
          model.homeGoals >= 0 &&
          Number.isFinite(model.awayGoals) &&
          model.awayGoals >= 0
            ? eventProbability(bet.name, quote.value, model.homeGoals, model.awayGoals)
            : null;
        if (modelProbability !== null && modelProbability - marketProbability > 0.03 + 1e-12)
          continue;
        const candidate = {
          matchId: report.matchId,
          match: report.match,
          kickoff: report.kickoff,
          market: bet.name,
          selection: quote.value,
          marketProbability,
          fairOdds: 1 / marketProbability,
          modelProbability,
          modelCheck: modelProbability === null ? 'non vérifié' : 'ok',
          odd,
          minOdds: Math.ceil((1 / marketProbability) * 100) / 100,
          oddsAgeMinutes: Math.max(0, quoteAge / 60000),
          valueVsMarket:
            quoteAge <= POLICY.maxMarketOddsAgeMs &&
            probabilities.every((p) => p.age <= POLICY.maxMarketOddsAgeMs)
              ? odd * marketProbability - 1
              : null,
        };
        const previous = candidates.get(report.matchId);
        if (!previous || compare(candidate, previous) < 0)
          candidates.set(report.matchId, candidate);
      }
    }
  }
  const ranked = [...candidates.values()].sort(compare),
    coupons = [];
  let offset = 0;
  for (const size of [1, 2, 3]) {
    const selections = ranked.slice(offset, offset + size);
    if (selections.length !== size) break;
    const confidence = selections.reduce((p, s) => p * s.marketProbability, 1);
    if (confidence < 0.5) break;
    offset += size;
    coupons.push({
      id: 'market-' + selections.map((s) => [s.matchId, s.market, s.selection].join(':')).join('|'),
      size,
      confidence,
      combinedOdds: selections.reduce((p, s) => p * s.odd, 1),
      bookmaker: 'bet365',
      selections,
    });
  }
  return coupons;
}
function compare(a, b) {
  const left = a.market + '|' + a.selection,
    right = b.market + '|' + b.selection;
  return (
    b.marketProbability - a.marketProbability ||
    a.matchId - b.matchId ||
    (left < right ? -1 : left > right ? 1 : 0)
  );
}
