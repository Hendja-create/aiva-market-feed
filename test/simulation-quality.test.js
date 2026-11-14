import test from "node:test";
import assert from "node:assert/strict";
import { isValidSimulationCandle, isContinuousWindow } from "../src/simulation-quality.js";

function candle(at, overrides = {}) {
  return { candle_at: at, bid_open: 100, bid_high: 102, bid_low: 99, bid_close: 101,
    ask_open: 100.2, ask_high: 102.2, ask_low: 99.2, ask_close: 101.2, spread_close: 0.2, ...overrides };
}

test("accepts valid Bid/Ask OHLC candle", () => {
  assert.equal(isValidSimulationCandle(candle("2026-01-01T00:00:00Z")), true);
});
test("rejects crossed quotes and impossible OHLC", () => {
  assert.equal(isValidSimulationCandle(candle("2026-01-01T00:00:00Z", { ask_close: 100.5 })), false);
  assert.equal(isValidSimulationCandle(candle("2026-01-01T00:00:00Z", { bid_high: 98 })), false);
});
test("requires every candle in a simulation window to be contiguous", () => {
  const candles = [0,1,3].map(m => candle(new Date(Date.UTC(2026,0,1,0,m)).toISOString()));
  assert.equal(isContinuousWindow(candles, 0, 1, 60000), true);
  assert.equal(isContinuousWindow(candles, 0, 2, 60000), false);
});
