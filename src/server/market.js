import { POLICY } from './policy.js';

// Cote décimale stricte : nombre fini > 1, ou chaîne décimale à point ; sinon null.
function parseOdd(raw) {
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'string' && !/^\d+(?:\.\d+)?$/.test(raw.trim())) return null;
  const odd = Number(raw);
  return Number.isFinite(odd) && odd > 1 ? odd : null;
}
const fresh = (updated, now) => {
  const age = typeof updated === 'string' ? now - Date.parse(updated) : NaN;
  return Number.isFinite(age) && age >= -300000 && age <= POLICY.maxMarketOddsAgeMs;
};

// Repère descriptif seulement : les trois issues doivent provenir du même
// relevé/bookmaker. Jamais de regroupement, ni de normalisation Double Chance.
export function marketReference(records, now = Date.now()) {
  const references = [];
  if (!Array.isArray(records) || !Number.isFinite(now)) return references;
  for (const record of records) {
    const age = typeof record?.update === 'string' ? now - Date.parse(record.update) : NaN;
    if (!Number.isFinite(age) || age < -300000 || age > POLICY.maxMarketOddsAgeMs) continue;
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
          const odd = parseOdd(quote.odd);
          if (odd === null) break;
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

// BIS-200 : valeur face au marché, descriptive seulement. Le repère sharp est Pinnacle,
// la cote comparée est celle de bet365, sur le même match et avec deux relevés frais.
export const SHARP_BOOKMAKER = 'Pinnacle';
const isBook = (name, wanted) =>
  typeof name === 'string' && name.trim().toLowerCase() === wanted.toLowerCase();

// Dernier relevé Pinnacle du match, conservé brut (marchés pris en charge seulement) pour
// que l'âge soit jugé au moment de la comparaison. Un relevé dont l'identifiant de match
// diffère n'est retenu que s'il n'en existe aucun du bon match : il sera refusé ensuite.
export function sharpReference(records, matchId) {
  if (!Array.isArray(records)) return null;
  let best = null;
  for (const record of records) {
    if (typeof record?.update !== 'string' || !Number.isFinite(Date.parse(record.update))) continue;
    const recordMatch = record.fixture?.id ?? matchId;
    for (const book of Array.isArray(record.bookmakers) ? record.bookmakers : []) {
      if (!isBook(book?.name, SHARP_BOOKMAKER) || !Array.isArray(book.bets)) continue;
      const candidate = {
        bookmaker: book.name,
        matchId: recordMatch,
        updated: record.update,
        bets: book.bets
          .filter((m) => typeof m?.name === 'string' && Array.isArray(m.values))
          .map((m) => ({
            name: m.name,
            values: m.values.map((v) => ({ value: v?.value, odd: v?.odd })),
          })),
      };
      const sameMatch = (x) => x.matchId === matchId;
      if (
        !best ||
        (sameMatch(candidate) && !sameMatch(best)) ||
        (sameMatch(candidate) === sameMatch(best) &&
          Date.parse(candidate.updated) > Date.parse(best.updated))
      )
        best = candidate;
    }
  }
  return best;
}

export const MARKET_VALUE_REASONS = {
  NO_REFERENCE: 'Pas de repère Pinnacle.',
  NOT_BET365: 'Sélection hors bet365 : pas de comparaison.',
  OTHER_MATCH: 'Repère Pinnacle d’un autre match.',
  STALE_QUOTE: 'Cote bet365 périmée (plus de 30 minutes).',
  STALE_REFERENCE: 'Repère Pinnacle périmé (plus de 30 minutes).',
  INCOMPLETE_MARKET: 'Marché Pinnacle incomplet.',
  UNSUPPORTED: 'Marché non comparé.',
  EVENT_MISSING: 'Événement absent de la réponse du fournisseur.',
};
const DOUBLE_CHANCE = {
  'Home/Draw': ['Home', 'Draw'],
  'Draw/Away': ['Draw', 'Away'],
  'Home/Away': ['Home', 'Away'],
};

// Probabilité sans marge de deux issues complémentaires, exactement une cote chacune.
function twoWay(bet, first, second) {
  const odds = {};
  for (const quote of bet?.values || []) {
    if (quote.value !== first && quote.value !== second) continue;
    if (Object.hasOwn(odds, quote.value)) return null;
    const odd = parseOdd(quote.odd);
    if (odd === null) return null;
    odds[quote.value] = odd;
  }
  if (!odds[first] || !odds[second]) return null;
  return 1 / odds[first] / (1 / odds[first] + 1 / odds[second]);
}

// Probabilité juste Pinnacle d'une sélection : 1X2 par marketReference (BIS-172),
// double chance comme somme de deux issues 1X2 justes (jamais normalisée directement),
// plus/moins et « les deux marquent » normalisés à deux issues. undefined : non pris en charge.
function fairProbability(reference, market, selection, now) {
  const bets = (name) => reference.bets.filter((m) => m.name === name);
  const single = (name) => (bets(name).length === 1 ? bets(name)[0] : null);
  if (market === 'Match Winner' || market === 'Double Chance') {
    const sides = market === 'Match Winner' ? [selection] : DOUBLE_CHANCE[selection];
    if (!sides || !sides.every((x) => ['Home', 'Draw', 'Away'].includes(x))) return undefined;
    const winner = single('Match Winner');
    if (!winner) return null;
    const [ref] = marketReference(
      [{ update: reference.updated, bookmakers: [{ name: reference.bookmaker, bets: [winner] }] }],
      now,
    );
    return ref ? sides.reduce((sum, x) => sum + ref.probabilities[x], 0) : null;
  }
  if (market === 'Both Teams Score') {
    if (!['Yes', 'No'].includes(selection)) return undefined;
    const p = twoWay(single(market), 'Yes', 'No');
    return p === null ? null : selection === 'Yes' ? p : 1 - p;
  }
  if (market === 'Goals Over/Under') {
    const line = /^(Over|Under) (\d+\.5)$/.exec(selection);
    if (!line) return undefined;
    const p = twoWay(single(market), 'Over ' + line[2], 'Under ' + line[2]);
    return p === null ? null : line[1] === 'Over' ? p : 1 - p;
  }
  return undefined;
}

// valeurMarche = cote bet365 / cote juste Pinnacle − 1, ou null avec sa raison.
// Ne modifie ni l'événement ni le verdict ; jamais transmis au LLM.
export function marketValue(event, reference, now = Date.now()) {
  const base = {
    matchId: event?.matchId ?? null,
    match: event?.missing !== true && typeof event?.match === 'string' ? event.match : null,
    marketName: typeof event?.market === 'string' ? event.market : null,
    selection: typeof event?.selection === 'string' ? event.selection : null,
    bookmaker: typeof event?.bookmaker === 'string' ? event.bookmaker : null,
    odd: Number.isFinite(event?.odd) ? event.odd : null,
    updated: event?.missing !== true && typeof event?.updated === 'string' ? event.updated : null,
    referenceBookmaker: reference?.bookmaker ?? null,
    referenceUpdated: reference?.updated ?? null,
    fairProbability: null,
    fairOdd: null,
    marketValue: null,
    hasValue: null,
    atFairOdd: null,
  };
  const refuse = (code) => ({ ...base, reasonCode: code, reason: MARKET_VALUE_REASONS[code] });
  // Sélection non retrouvée côté serveur : aucune donnée du client n'est comparée.
  if (event?.missing === true)
    return {
      ...base,
      odd: null,
      bookmaker: null,
      reasonCode: 'EVENT_MISSING',
      reason: MARKET_VALUE_REASONS.EVENT_MISSING,
    };
  if (!Number.isFinite(now) || !reference || !Array.isArray(reference.bets))
    return refuse('NO_REFERENCE');
  if (!isBook(base.bookmaker, 'bet365') || base.odd === null || base.odd <= 1)
    return refuse('NOT_BET365');
  if (base.matchId === null || reference.matchId !== base.matchId) return refuse('OTHER_MATCH');
  if (!fresh(event.updated, now)) return refuse('STALE_QUOTE');
  if (!fresh(reference.updated, now)) return refuse('STALE_REFERENCE');
  const p = fairProbability(reference, base.marketName, base.selection, now);
  if (p === undefined) return refuse('UNSUPPORTED');
  if (!(p > 0 && p < 1)) return refuse('INCOMPLETE_MARKET');
  const value = base.odd * p - 1;
  return {
    ...base,
    fairProbability: p,
    fairOdd: 1 / p,
    marketValue: value,
    // Marge d'arrondi : une cote égale à la cote juste n'a pas de valeur.
    hasValue: value > 1e-9,
    atFairOdd: Math.abs(value) <= 1e-9,
    reasonCode: null,
    reason: null,
  };
}

// Objet racine « market » du résultat : buildLlmInput le retire, le ticket l'ignore.
// Seuls les événements serveur sont comparés ; le repère vient du rapport du même match.
export function marketValueSummary(reports, groups, now = Date.now()) {
  const references = new Map((reports || []).map((r) => [r.matchId, r.sharpReference ?? null]));
  const checks = [];
  for (const [role, events] of Object.entries(groups))
    // index : position dans le groupe (selections, reviews ou candidats), clé d'affichage
    // stable même quand l'événement est absent du fournisseur.
    (events || []).forEach((event, index) =>
      checks.push({ role, index, ...marketValue(event, references.get(event?.matchId), now) }),
    );
  const ticket = checks.filter((x) => x.role === 'selection' || x.role === 'review');
  return {
    referenceBookmaker: SHARP_BOOKMAKER,
    comparedBookmaker: 'Bet365',
    method: 'proportional',
    checks,
    allSelectionsHaveValue: ticket.length ? ticket.every((x) => x.hasValue === true) : null,
    explanation:
      'Valeur face au marché = cote bet365 / cote juste Pinnacle − 1. Cote juste sans marge : 1X2 proportionnel, plus/moins et « les deux marquent » à deux issues, double chance par somme du 1X2 juste. Repère descriptif, sans effet sur les verdicts ni le ticket ; ce n’est pas une promesse de gain.',
  };
}
