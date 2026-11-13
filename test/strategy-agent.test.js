import test from "node:test";
import assert from "node:assert/strict";
import { buildEvidence, metrics, runStrategyAgent, summarizeCandles, summarizeResearch } from "../src/strategy-agent.js";

test("strategy agent computes net expectancy, profit factor and drawdown", () => {
  const result = metrics([{ pnl: 3 }, { pnl: -1 }, { pnl: 2 }, { pnl: -4 }], "pnl");
  assert.equal(result.observations, 4);
  assert.equal(result.net, 0);
  assert.equal(result.expectancy, 0);
  assert.equal(result.profit_factor, 1);
  assert.equal(result.max_drawdown, 4);
  assert.equal(result.max_consecutive_losses, 1);
});

test("strategy agent summarizes candle returns and spread quantiles", () => {
  const result = summarizeCandles([
    { candle_at: "2026-01-01T00:00:00Z", bid_close: 100, spread_close: 0.2 },
    { candle_at: "2026-01-01T00:01:00Z", bid_close: 102, spread_close: 0.4 },
    { candle_at: "2026-01-01T00:02:00Z", bid_close: 101, spread_close: 0.6 }
  ]);
  assert.equal(result.candles, 3);
  assert.equal(result.positive_close_ratio, 0.5);
  assert.equal(result.spread_median, 0.4);
  assert.equal(result.spread_max, 0.6);
});

test("research summary separates invalid observations and horizons", () => {
  const result = summarizeResearch([
    { outcome_5m: { outcome: "WIN", net_pnl_points: 1.2 } },
    { outcome_5m: { outcome: "LOSS", net_pnl_points: -0.7 } },
    { outcome_5m: { outcome: "INVALID" } }
  ]);
  assert.equal(result["5m"].evaluated, 2);
  assert.equal(result["5m"].invalid, 1);
  assert.equal(result["5m"].net, 0.5);
  assert.equal(result["5m"].win_rate, 0.5);
});

test("strategy agent loads evidence tables concurrently and reports coverage caps", async () => {
  const started = [];
  let active = 0;
  let peak = 0;
  const db = async (path) => {
    const table = path.split("?")[0];
    started.push(table);
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return [];
  };
  const evidence = await buildEvidence(db, "XAUUSD");
  assert.equal(started.length, 13);
  assert.ok(peak > 1, "database reads should run concurrently");
  assert.equal(evidence.completeness.ticks.rows_read, 0);
  assert.equal(evidence.quote_ticks.rows_read, 0);
  assert.match(evidence.coverage_warning, /Every row returned/);
});

test("strategy agent identifies incomplete OpenAI output without saving a report", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  let saved = false;
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: []
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    await assert.rejects(
      () => runStrategyAgent(async (path) => {
        if (path === "aiva_strategy_agent_reports") saved = true;
        return [];
      }, "XAUUSD"),
      error => error.code === "strategy_agent_incomplete_output"
    );
    assert.equal(saved, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});
