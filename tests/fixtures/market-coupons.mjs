export const MARKET_COUPON_NOW = Date.parse('2030-01-01T12:00:00Z');
export function marketReport(id, p = 0.82, options = {}) {
  const now = MARKET_COUPON_NOW;
  const bets = [
    {
      name: 'Both Teams Score',
      values: [
        { value: 'Yes', odd: 1 / p },
        { value: 'No', odd: 1 / (1 - p) },
      ],
    },
  ];
  return {
    matchId: id,
    match: `Club ${id} — Visiteur ${id}`,
    country: 'France',
    league: 'A',
    kickoff: new Date(now + 7200000).toISOString(),
    retrievedAt: new Date(now).toISOString(),
    common: [],
    events: [],
    model: null,
    marketCouponQuotes: [
      {
        fixture: { id },
        update: new Date(now).toISOString(),
        bookmakers: [
          { name: 'bet365', bets },
          { name: 'Pinnacle', bets },
        ],
      },
    ],
    ...options,
  };
}
