import test from "node:test";
import assert from "node:assert/strict";
import { getMarketFeedHealth, getM1ImportRetryDelayMs } from "../src/market-feed-health.js";

test("connected socket without a recent quote is not reported as a fresh feed", () => {
  const health = getMarketFeedHealth({
    connected: true,
    lastQuoteAt: "2026-11-13T21:45:01.130Z",
    now: Date.parse("2026-11-13T22:45:01.130Z")
  });
  assert.equal(health.socketConnected, true);
  assert.equal(health.fresh, false);
  assert.equal(health.status, "connected_without_fresh_quote");
  assert.equal(health.ageMs, 3_600_000);
});

test("a recent quote is reported as fresh", () => {
  const health = getMarketFeedHealth({
    connected: true,
    lastQuoteAt: "2026-11-13T22:44:30.000Z",
    now: Date.parse("2026-11-13T22:45:00.000Z")
  });
  assert.equal(health.fresh, true);
  assert.equal(health.status, "fresh");
});

test("missing quote is not fresh even when the socket is connected", () => {
  const health = getMarketFeedHealth({ connected: true, lastQuoteAt: null });
  assert.equal(health.fresh, false);
  assert.equal(health.status, "connected_without_fresh_quote");
});

test("empty M1 provider windows back off for five minutes", () => {
  assert.equal(getM1ImportRetryDelayMs({ status: "chunk_imported", matched_candles: 0 }), 300_000);
  assert.equal(getM1ImportRetryDelayMs({ status: "chunk_imported", matched_candles: 12 }), 0);
  assert.equal(getM1ImportRetryDelayMs({ status: "backfill_complete", imported: 0 }), 0);
});
