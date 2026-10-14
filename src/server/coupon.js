import { POLICY, MODEL_VERSION } from './policy.js';

export const PREFERRED_BOOKMAKER = 'Bet365';
export const PREFERRED_TOLERANCE = 0.9;
const bookmakerKey = (name) =>
  typeof name === 'string' && name.trim().toLowerCase() === PREFERRED_BOOKMAKER.toLowerCase()
    ? PREFERRED_BOOKMAKER
    : name;

export const supportedMarkets = new Set([
  'Goals Over/Under',
  'Both Teams Score',
  'Double Chance',
  'Match Winner',
]);
export function supportedQuotes(records, now = Date.now()) {
  return (records || []).some((r) => {
    const age = now - Date.parse(r.update);
    return (
      Number.isFinite(age) &&
      age >= -300000 &&
      age <= POLICY.maxOddsAgeMs &&
      (r.bookmakers || []).some((b) =>
        (b.bets || []).some(
          (m) => supportedMarkets.has(m.name) && (m.values || []).some((v) => Number(v.odd) > 1),
        ),
      )
    );
  });
}
export function compactReport(report) {
  const books = new Map();
  for (const e of report.events || [])
    if (e.status === 'simulation_eligible') {
      const prev = books.get(e.bookmaker);
      if (
        !prev ||
        e.prudentProbability > prev.prudentProbability ||
        (e.prudentProbability === prev.prudentProbability && e.prudentEdge > prev.prudentEdge)
      )
        books.set(e.bookmaker, e);
    }
  return {
    ...report,
    events: [...books.values()],
    evaluatedEvents: report.events?.length || 0,
    firstRejection:
      report.common?.[0] ||
      report.events?.find((e) => e.status !== 'simulation_eligible')?.reasons?.[0] ||
      'Aucune cote exploitable.',
  };
}
export function blockedReport(f, reason) {
  return {
    matchId: f.fixture.id,
    match: f.teams.home.name + ' — ' + f.teams.away.name,
    country: f.league.country,
    league: f.league.name,
    kickoff: f.fixture.date,
    model: null,
    events: [],
    common: [reason],
    firstRejection: reason,
    evaluatedEvents: 0,
    retrievedAt: new Date().toISOString(),
    modelVersion: MODEL_VERSION,
    modelValidated: false,
  };
}
export function selectCoupon(reports, now = Date.now()) {
  return selectCouponDetailed(reports, now).selections;
}
export const NO_CANDIDATE_REASON = 'Aucun événement admissible : aucun ticket proposé.';
export const BELOW_THRESHOLD_REASON =
  'Aucune sélection n’atteint seule une probabilité prudente de ' +
  Math.round(POLICY.minTicketProbability * 100) +
  ' % : aucun ticket proposé.';
// Produit d'un champ de probabilité ; null si le ticket est vide ou si une valeur manque.
const product = (selections, field) =>
  selections.length && selections.every((e) => Number.isFinite(e[field]))
    ? selections.reduce((p, e) => p * e[field], 1)
    : null;
// Composition gloutonne et déterministe : candidats triés par probabilité prudente
// décroissante, ajoutés tant que le produit reste au-dessus du seuil, quatre au plus.
// Les candidats étant triés, le premier refus rend tous les suivants impossibles.
function composeTicket(candidates) {
  const ticket = [];
  let probability = 1;
  for (const e of candidates) {
    const next = probability * e.prudentProbability;
    if (ticket.length >= POLICY.maxSelections || next < POLICY.minTicketProbability) break;
    ticket.push(e);
    probability = next;
  }
  return ticket;
}
// Entre bookmakers : le plus grand ticket qui respecte le seuil, puis la probabilité combinée.
// scoreGap : perte relative de probabilité du ticket préféré face au meilleur,
// ou null si les tailles diffèrent ou si aucun ticket préféré n'est disponible.
// Le ticket préféré respecte déjà le seuil : la tolérance ne le fait jamais passer dessous.
// Sans sélection : bookmaker null, used false, unavailable true, scoreGap et
// probabilités null, noTicketReason renseigné.
export function selectCouponDetailed(reports, now = Date.now()) {
  const valid = (e) =>
    e.status === 'simulation_eligible' &&
    Number.isFinite(e.prudentProbability) &&
    e.prudentProbability > 0 &&
    e.prudentProbability <= 1 &&
    Date.parse(e.kickoff) > now &&
    now - Date.parse(e.updated) <= POLICY.maxOddsAgeMs &&
    now - Date.parse(e.updated) >= -300000;
  const byProbability = (a, b) =>
    b.prudentProbability - a.prudentProbability || b.prudentEdge - a.prudentEdge;
  const books = [
    ...new Set(
      reports.flatMap((r) => r.events.filter(valid).map((e) => bookmakerKey(e.bookmaker))),
    ),
  ];
  let best = [];
  let preferred = [];
  let candidatesSeen = false;
  for (const book of books) {
    const candidates = reports
      .flatMap((r) => {
        if (now - Date.parse(r.retrievedAt) > 15 * 60000) return [];
        return r.events
          .filter((e) => bookmakerKey(e.bookmaker) === book && valid(e))
          .sort(byProbability)
          .slice(0, 1);
      })
      .sort(byProbability);
    // Un match peut apparaître dans deux rapports : on garde sa meilleure sélection.
    const perMatch = new Map();
    for (const e of candidates) if (!perMatch.has(e.matchId)) perMatch.set(e.matchId, e);
    if (perMatch.size) candidatesSeen = true;
    const ticket = composeTicket([...perMatch.values()]);
    if (book === PREFERRED_BOOKMAKER) preferred = ticket;
    if (
      ticket.length > best.length ||
      (ticket.length === best.length &&
        ticket.length > 0 &&
        product(ticket, 'prudentProbability') > product(best, 'prudentProbability'))
    )
      best = ticket;
  }
  const comparable = preferred.length > 0 && preferred.length === best.length;
  // Ratio en logarithmes, comme la tolérance de la PR n° 6 : même arrondi à la borne de 90 %.
  const score = (x) => x.reduce((s, e) => s + Math.log(e.prudentProbability), 0);
  const ratio = comparable ? Math.exp(score(preferred) - score(best)) : null;
  const preferredBookmakerUsed = comparable && ratio + Number.EPSILON >= PREFERRED_TOLERANCE;
  const selections = preferredBookmakerUsed ? preferred : best;
  return {
    selections,
    bookmaker: selections.length ? bookmakerKey(selections[0].bookmaker) : null,
    preferredBookmakerUsed,
    preferredBookmakerUnavailable: !preferredBookmakerUsed,
    scoreGap: comparable ? Math.max(0, 1 - ratio) : null,
    ticketProbability: product(selections, 'prudentProbability'),
    ticketProbabilityExploratory: product(selections, 'probability'),
    minTicketProbability: POLICY.minTicketProbability,
    noTicketReason: selections.length
      ? null
      : candidatesSeen
        ? BELOW_THRESHOLD_REASON
        : NO_CANDIDATE_REASON,
    modelValidated: false,
    realMoneyEligible: false,
  };
}
