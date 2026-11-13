export function buildQuoteSnapshot(q, quoteAgeMs = null) {
  if (!q) return null;
  return {
    bid: Number(q.bid),
    ask: Number(q.ask),
    mid: Number(q.mid),
    spread: Number(q.spread ?? (Number(q.ask) - Number(q.bid))),
    provider_timestamp: q.provider_timestamp || null,
    received_at: q.received_at || null,
    source: q.source || null,
    connection_status: q.connection_status || null,
    quote_age_ms: Number.isFinite(Number(quoteAgeMs)) ? Math.round(Number(quoteAgeMs)) : null
  };
}

export function getDemoExecutionCosts(env = process.env) {
  const nonNegative = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    slippage_each_side: nonNegative(env.DEMO_SLIPPAGE_POINTS_PER_SIDE, 0.05),
    commission_round_trip: nonNegative(env.DEMO_COMMISSION_POINTS_ROUND_TRIP, 0.20),
    model: "bid_ask_plus_slippage_commission_v1"
  };
}
