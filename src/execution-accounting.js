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

export function calculateDemoPnl(direction, entryFillPrice, entryReferencePrice, exitQuote, costs = {}) {
  if (!["BUY", "SELL"].includes(direction)) throw new Error("direction must be BUY or SELL");
  const rawExitPrice = Number(direction === "BUY" ? exitQuote?.bid : exitQuote?.ask);
  const entryFill = Number(entryFillPrice);
  const entryReference = Number(entryReferencePrice);
  const slippage = Math.max(0, Number(costs.slippage_each_side || 0));
  const commission = Math.max(0, Number(costs.commission_round_trip || 0));
  if (![rawExitPrice, entryFill, entryReference, slippage, commission].every(Number.isFinite)) {
    throw new Error("execution prices and costs must be finite numbers");
  }
  const effectiveExitPrice = direction === "BUY" ? rawExitPrice - slippage : rawExitPrice + slippage;
  const side = direction === "BUY" ? 1 : -1;
  const grossQuotePnlPoints = side * (rawExitPrice - entryReference);
  const netPnlPoints = side * (effectiveExitPrice - entryFill) - commission;
  return {
    raw_exit_price: rawExitPrice,
    effective_exit_price: effectiveExitPrice,
    gross_quote_pnl_points: Number(grossQuotePnlPoints.toFixed(4)),
    slippage_total_points: Number((2 * slippage).toFixed(4)),
    commission_round_trip_points: Number(commission.toFixed(4)),
    net_pnl_points: Number(netPnlPoints.toFixed(4))
  };
}
