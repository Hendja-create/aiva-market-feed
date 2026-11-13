import test from "node:test";
import assert from "node:assert/strict";
import { buildEvidence, compactEvidenceForModel, metrics, runStrategyAgent, summarizeCandles, summarizeResearch } from "../src/strategy-agent.js";

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



test("strategy prompt compaction removes redundant raw state and bounds report sections", () => {
  const evidence = {
    latest_quotes: Array.from({ length: 100 }, (_, i) => ({ symbol: "XAUUSD", bid: i, ask: i + 1 })),
    learning_state: Array.from({ length: 20 }, (_, i) => ({ symbol: "XAUUSD", confidence_threshold: i })),
    inverse_demo_state: Array.from({ length: 20 }, (_, i) => ({ symbol: "XAUUSD", status: "RUNNING" })),
    backtests: { by_method: Array.from({ length: 30 }, (_, i) => ({
      method: "method-" + i, recent_warnings: ["one", "two", "three"]
    })) },
    analyses: { latest: Array.from({ length: 30 }, (_, i) => ({ decision: "NO_TRADE", created_at: String(i) })) }
  };
  const result = compactEvidenceForModel(evidence);
  assert.equal(result.evidence.latest_quotes.length, 1);
  assert.equal(result.evidence.learning_state.length, 3);
  assert.equal(result.evidence.inverse_demo_state.length, 3);
  assert.equal(result.evidence.backtests.by_method.length, 10);
  assert.equal(result.evidence.backtests.by_method[0].recent_warnings.length, 2);
  assert.equal(result.evidence.analyses.latest.length, 15);
  assert.equal(result.serialized, JSON.stringify(result.evidence));
});

test("strategy agent records actual OpenAI token usage with the saved report", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  let savedBody = null;
  let requestBody = null;
  const report = {
    executive_summary: "Résumé court", market_regime: "range",
    data_quality: [], mathematical_findings: [], strategy_reviews: [],
    recommendations: [], prohibited_conclusions: [], overall_confidence: "low"
  };
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(report) }] }],
      usage: { input_tokens: 1200, output_tokens: 450, total_tokens: 1650,
        input_tokens_details: { cached_tokens: 300 } }
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const result = await runStrategyAgent(async (path, options = {}) => {
      if (path === "aiva_strategy_agent_reports") {
        savedBody = JSON.parse(options.body);
        return [{ id: "report-1", created_at: "2026-11-13T00:00:00Z" }];
      }
      return [];
    }, "XAUUSD");
    assert.equal(requestBody.reasoning.effort, "low");
    assert.equal(requestBody.max_output_tokens, 3500);
    assert.equal(savedBody.report._usage.input_tokens, 1200);
    assert.equal(savedBody.report._usage.output_tokens, 450);
    assert.equal(savedBody.report._usage.cached_input_tokens, 300);
    assert.equal(result.usage.total_tokens, 1650);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test("strategy agent converts read-only DOM timeout errors into a typed timeout without saving", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  let saved = false;
  globalThis.fetch = async () => {
    throw new DOMException("The operation was aborted", "TimeoutError");
  };
  try {
    await assert.rejects(
      () => runStrategyAgent(async (path) => {
        if (path === "aiva_strategy_agent_reports") saved = true;
        return [];
      }, "XAUUSD"),
      error => error.code === "strategy_agent_timeout"
    );
    assert.equal(saved, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});
