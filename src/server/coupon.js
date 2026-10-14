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
// scoreGap : perte relative de probabilité du coupon préféré face au meilleur,
// ou null si les tailles diffèrent ou si aucun coupon préféré n'est disponible.
// Sans sélection : bookmaker null, used false, unavailable true, scoreGap null.
export function selectCouponDetailed(reports, now = Date.now()) {
  const valid = (e) =>
    e.status === 'simulation_eligible' &&
    Date.parse(e.kickoff) > now &&
    now - Date.parse(e.updated) <= POLICY.maxOddsAgeMs &&
    now - Date.parse(e.updated) >= -300000;
  const books = [
    ...new Set(
      reports.flatMap((r) => r.events.filter(valid).map((e) => bookmakerKey(e.bookmaker))),
    ),
  ];
  let best = [];
  let preferred = [];
  const score = (x) => x.reduce((s, e) => s + Math.log(Math.max(e.prudentProbability, 1e-9)), 0);
  for (const book of books) {
    const choices = reports
      .flatMap((r) => {
        if (now - Date.parse(r.retrievedAt) > 15 * 60000) return [];
        return r.events
          .filter((e) => bookmakerKey(e.bookmaker) === book && valid(e))
          .sort(
            (a, b) => b.prudentProbability - a.prudentProbability || b.prudentEdge - a.prudentEdge,
          )
          .slice(0, 1);
      })
      .sort((a, b) => b.prudentProbability - a.prudentProbability || b.prudentEdge - a.prudentEdge)
      .slice(0, 4);
    if (book === PREFERRED_BOOKMAKER) preferred = choices;
    if (
      choices.length > best.length ||
      (choices.length === best.length && score(choices) > score(best))
    )
      best = choices;
  }
  const comparable = preferred.length > 0 && preferred.length === best.length;
  const ratio = comparable ? Math.exp(score(preferred) - score(best)) : null;
  const preferredBookmakerUsed = comparable && ratio + Number.EPSILON >= PREFERRED_TOLERANCE;
  const selections = preferredBookmakerUsed ? preferred : best;
  return {
    selections,
    bookmaker: selections.length ? bookmakerKey(selections[0].bookmaker) : null,
    preferredBookmakerUsed,
    preferredBookmakerUnavailable: !preferredBookmakerUsed,
    scoreGap: comparable ? Math.max(0, 1 - ratio) : null,
  };
}
