import test from "node:test";
import assert from "node:assert/strict";
import { getResearchStatus } from "../src/research-mode.js";

test("research status reports paper-only mode and aggregates net results by horizon", async () => {
  const rows = [
    { id: "1", direction: "BUY", source_decision: "NO_TRADE", blocking_reasons: ["confidence"], status: "CLOSED",
      created_at: "2026-11-13T10:00:00Z", outcome_5m: { outcome: "WIN", net_pnl_points: 1.2 },
      outcome_15m: { outcome: "LOSS", net_pnl_points: -0.8 } },
    { id: "2", direction: "SELL", source_decision: "SELL", blocking_reasons: [], status: "OPEN",
      created_at: "2026-11-13T11:00:00Z", outcome_5m: { outcome: "LOSS", net_pnl_points: -0.4 } }
  ];
  const db = async path => path.includes("aiva_research_observations") ? rows : [];
  const status = await getResearchStatus(db, "XAUUSD");
  assert.equal(status.mode, "RESEARCH_PAPER_ONLY");
  assert.equal(status.real_orders_enabled, false);
  assert.equal(status.risk_limits_applied, false);
  assert.equal(status.observations, 2);
  assert.equal(status.open, 1);
  assert.equal(status.source_decisions.blocked_or_no_trade, 1);
  assert.equal(status.horizons["5m"].evaluated, 2);
  assert.equal(status.horizons["5m"].net_pnl_points, 0.8);
  assert.equal(status.horizons["15m"].evaluated, 1);
});

test("status with no observations remains empty and non-promotional", async () => {
  const status = await getResearchStatus(async () => [], "XAUUSD");
  assert.equal(status.observations, 0);
  assert.equal(status.horizons["60m"].win_rate, null);
  assert.match(status.warning, /not proof of profitability/i);
});
