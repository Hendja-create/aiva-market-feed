import test from "node:test";
import assert from "node:assert/strict";
import { buildQuoteSnapshot, calculateDemoPnl, getDemoExecutionCosts } from "../src/execution-accounting.js";

test("quote snapshots preserve provider and receive timestamps", () => {
  const snapshot = buildQuoteSnapshot({
    bid: "2000.1", ask: "2000.4", mid: "2000.25", spread: "0.3",
    provider_timestamp: "2026-11-13T10:00:00.000Z",
    received_at: "2026-11-13T10:00:00.050Z", source: "live-rates",
    connection_status: "connected"
  }, 50);
  assert.equal(snapshot.bid, 2000.1);
  assert.equal(snapshot.spread, 0.3);
  assert.equal(snapshot.provider_timestamp, "2026-11-13T10:00:00.000Z");
  assert.equal(snapshot.quote_age_ms, 50);
});

test("default demo costs are explicit and configurable", () => {
  assert.deepEqual(getDemoExecutionCosts({}), {
    slippage_each_side: 0.05,
    commission_round_trip: 0.2,
    model: "bid_ask_plus_slippage_commission_v1"
  });
  assert.deepEqual(getDemoExecutionCosts({
    DEMO_SLIPPAGE_POINTS_PER_SIDE: "0.1",
    DEMO_COMMISSION_POINTS_ROUND_TRIP: "0.4"
  }), {
    slippage_each_side: 0.1,
    commission_round_trip: 0.4,
    model: "bid_ask_plus_slippage_commission_v1"
  });
});

test("BUY net PnL includes bid exit, two slippage sides and commission", () => {
  const result = calculateDemoPnl("BUY", 100.05, 100, { bid: 101, ask: 101.3 }, {
    slippage_each_side: 0.05, commission_round_trip: 0.2
  });
  assert.equal(result.gross_quote_pnl_points, 1);
  assert.equal(result.slippage_total_points, 0.1);
  assert.equal(result.commission_round_trip_points, 0.2);
  assert.equal(result.net_pnl_points, 0.6);
});

test("SELL net PnL uses ask exit and deducts both slippage sides", () => {
  const result = calculateDemoPnl("SELL", 99.95, 100, { bid: 99, ask: 99.3 }, {
    slippage_each_side: 0.05, commission_round_trip: 0.2
  });
  assert.equal(result.gross_quote_pnl_points, 0.7);
  assert.equal(result.net_pnl_points, 0.4);
});

test("legacy zero-cost accounting does not fabricate historical costs", () => {
  const result = calculateDemoPnl("BUY", 100, 100, { bid: 99.8, ask: 100.1 }, {});
  assert.equal(result.net_pnl_points, -0.2);
  assert.equal(result.slippage_total_points, 0);
  assert.equal(result.commission_round_trip_points, 0);
});
