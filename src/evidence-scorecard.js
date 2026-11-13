const DEFAULTS = Object.freeze({
  minimumTrades: 100,
  minimumProfitFactor: 1.2,
  stressCostPerTrade: 0.2,
  confidenceLevel: 0.95
});

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : null;
}

function wilsonInterval(wins, total, confidenceLevel = DEFAULTS.confidenceLevel) {
  if (!total) return null;
  const zByLevel = { 0.9: 1.6448536269514722, 0.95: 1.959963984540054, 0.99: 2.5758293035489004 };
  const z = zByLevel[confidenceLevel] || zByLevel[0.95];
  const p = wins / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) / total) + (z2 / (4 * total * total))) / denominator;
  return { lower: round(Math.max(0, center - margin)), upper: round(Math.min(1, center + margin)) };
}

function calculateMetrics(trades, confidenceLevel) {
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let consecutiveLosses = 0;
  let maxConsecutiveLosses = 0;

  for (const trade of trades) {
    const pnl = trade.pnl_points;
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (pnl > 0) {
      grossProfit += pnl;
      consecutiveLosses = 0;
    } else if (pnl < 0) {
      grossLoss += Math.abs(pnl);
      consecutiveLosses += 1;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, consecutiveLosses);
    }
  }

  const wins = trades.filter(trade => trade.pnl_points > 0).length;
  const losses = trades.filter(trade => trade.pnl_points < 0).length;
  const count = trades.length;

  return {
    trades: count,
    wins,
    losses,
    win_rate: count ? round(wins / count) : null,
    win_rate_confidence_95: wilsonInterval(wins, count, confidenceLevel),
    net_pnl_points: round(equity),
    profit_factor: grossLoss > 0 ? round(grossProfit / grossLoss) : null,
    expectancy_points: count ? round(equity / count) : null,
    max_drawdown_points: round(maxDrawdown),
    max_consecutive_losses: maxConsecutiveLosses
  };
}

function splitChronologicalSegments(trades) {
  if (!trades.length) return [];
  const segments = [];
  for (let index = 0; index < 3; index += 1) {
    const start = Math.floor(trades.length * index / 3);
    const end = Math.floor(trades.length * (index + 1) / 3);
    if (end > start) segments.push({ segment: index + 1, trades: trades.slice(start, end) });
  }
  return segments;
}

/**
 * Research-only evidence assessment for chronologically ordered out-of-sample trades.
 * It never selects a strategy or changes execution/risk settings.
 */
export function scoreEvidence(trades, options = {}) {
  if (!Array.isArray(trades)) throw new TypeError("trades must be an array");

  const settings = { ...DEFAULTS, ...options };
  for (const [key, minimum] of [
    ["minimumTrades", 1],
    ["minimumProfitFactor", 0],
    ["stressCostPerTrade", 0]
  ]) {
    if (!Number.isFinite(Number(settings[key])) || Number(settings[key]) < minimum) {
      throw new TypeError(key + " must be a finite number greater than or equal to " + minimum);
    }
  }

  const cleanTrades = trades.map((trade, index) => {
    const pnl = Number(trade?.pnl_points);
    if (!Number.isFinite(pnl)) {
      throw new TypeError("trade " + index + " has an invalid pnl_points value");
    }
    return { ...trade, pnl_points: pnl };
  });

  const metrics = calculateMetrics(cleanTrades, settings.confidenceLevel);
  const stressedTrades = cleanTrades.map(trade => ({
    ...trade,
    pnl_points: trade.pnl_points - settings.stressCostPerTrade
  }));
  const stressMetrics = calculateMetrics(stressedTrades, settings.confidenceLevel);

  const failures = [];
  if (metrics.trades < settings.minimumTrades) failures.push("insufficient_oos_sample");
  if (metrics.profit_factor === null || metrics.profit_factor < settings.minimumProfitFactor) {
    failures.push("oos_profit_factor_below_minimum");
  }
  if (metrics.expectancy_points === null || metrics.expectancy_points <= 0) {
    failures.push("non_positive_oos_expectancy");
  }
  if (metrics.net_pnl_points === null || metrics.net_pnl_points <= 0) {
    failures.push("non_positive_oos_net_pnl");
  }
  if (stressMetrics.expectancy_points === null || stressMetrics.expectancy_points <= 0) {
    failures.push("fails_additional_cost_stress");
  }

  const chronologicalSegments = splitChronologicalSegments(cleanTrades).map(({ segment, trades: batch }) => ({
    segment,
    ...calculateMetrics(batch, settings.confidenceLevel)
  }));

  const regimes = {};
  for (const trade of cleanTrades) {
    const name = typeof trade.market_regime === "string" && trade.market_regime.trim()
      ? trade.market_regime.trim()
      : "unclassified";
    if (!regimes[name]) regimes[name] = [];
    regimes[name].push(trade);
  }
  const regimeAnalysis = Object.fromEntries(
    Object.entries(regimes).sort(([left], [right]) => left.localeCompare(right))
      .map(([name, rows]) => [name, calculateMetrics(rows, settings.confidenceLevel)])
  );

  const warnings = [];
  if (metrics.win_rate !== null && metrics.win_rate >= 0.65 &&
      (metrics.win_rate_confidence_95?.lower ?? 0) < 0.65) {
    warnings.push("observed_65_percent_win_rate_not_established_by_95_percent_interval");
  }
  if (metrics.trades >= 150 && chronologicalSegments.some(segment => segment.expectancy_points <= 0)) {
    warnings.push("at_least_one_chronological_third_has_non_positive_expectancy");
  }
  if (metrics.trades < settings.minimumTrades) {
    warnings.push("sample_too_small_for_strategy_promotion");
  }

  const status = metrics.trades < settings.minimumTrades
    ? "INSUFFICIENT_SAMPLE"
    : failures.length
      ? "NOT_ELIGIBLE"
      : "EVIDENCE_REVIEW_REQUIRED";

  return {
    version: "aiva_evidence_scorecard_v1",
    status,
    eligible_for_human_review: status === "EVIDENCE_REVIEW_REQUIRED",
    // Human review is not authorization. Keep promotion blocked in every scorecard state.
    promotion_blocked: true,
    criteria: {
      minimum_oos_trades: Number(settings.minimumTrades),
      minimum_profit_factor: Number(settings.minimumProfitFactor),
      additional_cost_stress_per_trade_points: Number(settings.stressCostPerTrade)
    },
    metrics,
    additional_cost_stress: {
      applied_extra_cost_per_trade_points: Number(settings.stressCostPerTrade),
      metrics: stressMetrics
    },
    chronological_segments: chronologicalSegments,
    regime_analysis: regimeAnalysis,
    failures,
    warnings,
    interpretation: "Research diagnostic only. Passing this scorecard requests human review; it does not validate or promote a strategy."
  };
}
