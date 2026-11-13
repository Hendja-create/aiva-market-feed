import test from "node:test";
import assert from "node:assert/strict";
import { scoreEvidence } from "../src/evidence-scorecard.js";

function tradesFrom(outcomes, marketRegime = "bullish_trend") {
  return outcomes.map((pnl_points, index) => ({
    pnl_points,
    market_regime: index % 2 ? marketRegime : "range_or_transition"
  }));
}

test("keeps small samples blocked even when the observed win rate is 65 percent", () => {
  const rows = tradesFrom(Array.from({ length: 20 }, (_, index) => index < 13 ? 1 : -0.4));
  const result = scoreEvidence(rows);
  assert.equal(result.status, "INSUFFICIENT_SAMPLE");
  assert.equal(result.promotion_blocked, true);
  assert.ok(result.metrics.win_rate_confidence_95.lower < 0.65);
  assert.ok(result.warnings.includes("sample_too_small_for_strategy_promotion"));
  assert.ok(result.warnings.includes("observed_65_percent_win_rate_not_established_by_95_percent_interval"));
});

test("marks a sufficiently sampled positive candidate for human review, never automatic promotion", () => {
  const rows = Array.from({ length: 120 }, (_, index) => ({
    pnl_points: index < 84 ? 1 : -0.5,
    market_regime: index % 3 === 0 ? "bullish_trend" : "bearish_trend"
  }));
  const result = scoreEvidence(rows);
  assert.equal(result.status, "EVIDENCE_REVIEW_REQUIRED");
  assert.equal(result.eligible_for_human_review, true);
  assert.equal(result.promotion_blocked, false);
  assert.equal(result.metrics.trades, 120);
  assert.ok(result.metrics.profit_factor >= 1.2);
  assert.ok(result.additional_cost_stress.metrics.expectancy_points > 0);
  assert.equal(result.metrics.win_rate, 0.7);
  assert.equal(result.chronological_segments.length, 3);
  assert.ok(result.regime_analysis.bullish_trend.trades > 0);
  assert.ok(result.regime_analysis.bearish_trend.trades > 0);
  assert.match(result.interpretation, /does not validate or promote/);
});

test("rejects positive win rate when net expectancy and profit factor are poor", () => {
  const rows = Array.from({ length: 120 }, (_, index) => index < 78 ? 1 : -2);
  const result = scoreEvidence(rows);
  assert.equal(result.status, "NOT_ELIGIBLE");
  assert.ok(result.failures.includes("oos_profit_factor_below_minimum"));
  assert.ok(result.failures.includes("non_positive_oos_expectancy"));
  assert.ok(result.failures.includes("non_positive_oos_net_pnl"));
});

test("applies an additional cost stress without changing recorded base PnL", () => {
  const rows = Array.from({ length: 120 }, () => ({ pnl_points: 0.1, market_regime: "range_or_transition" }));
  const result = scoreEvidence(rows, { stressCostPerTrade: 0.2 });
  assert.equal(result.metrics.net_pnl_points, 12);
  assert.equal(result.additional_cost_stress.metrics.net_pnl_points, -12);
  assert.ok(result.failures.includes("fails_additional_cost_stress"));
});

test("rejects malformed trade data and invalid research settings", () => {
  assert.throws(() => scoreEvidence([{ pnl_points: "not-a-number" }]), /invalid pnl_points/);
  assert.throws(() => scoreEvidence([], { stressCostPerTrade: -0.1 }), /stressCostPerTrade/);
  assert.throws(() => scoreEvidence(null), /trades must be an array/);
});

test("returns a fail-closed empty report when there are no OOS trades", () => {
  const result = scoreEvidence([]);
  assert.equal(result.status, "INSUFFICIENT_SAMPLE");
  assert.equal(result.metrics.win_rate, null);
  assert.equal(result.metrics.profit_factor, null);
  assert.equal(result.metrics.win_rate_confidence_95, null);
  assert.deepEqual(result.failures.includes("insufficient_oos_sample"), true);
});
