import test from "node:test";
import assert from "node:assert/strict";
import { getMarketFeedHealth, getM1ImportRetryDelayMs, shouldReconnectMarketFeed } from "../src/market-feed-health.js";

test("connected socket without a recent quote is reported stale", () => {
  const health = getMarketFeedHealth({
    connected: true,
    lastQuoteAt: "2026-11-13T21:45:01.130Z",
    now: Date.parse("2026-11-13T22:45:01.130Z")
  });
  assert.equal(health.socketConnected, true);
  assert.equal(health.fresh, false);
  assert.equal(health.status, "STALE");
  assert.equal(health.ageMs, 3_600_000);
});

test("a recent quote is reported connected and fresh", () => {
  const health = getMarketFeedHealth({
    connected: true,
    lastQuoteAt: "2026-11-13T22:44:30.000Z",
    now: Date.parse("2026-11-13T22:45:00.000Z")
  });
  assert.equal(health.fresh, true);
  assert.equal(health.status, "CONNECTED");
});

test("missing quote is not fresh even when socket is connected", () => {
  const health = getMarketFeedHealth({ connected: true, lastQuoteAt: null });
  assert.equal(health.fresh, false);
  assert.equal(health.status, "STALE");
});

test("feed watchdog reconnects after stale quotes", () => {
  const now = Date.parse("2026-11-14T10:00:00.000Z");
  assert.equal(shouldReconnectMarketFeed({
    connected: true, socketActive: true,
    lastQuoteAt: "2026-11-14T09:58:00.000Z", now
  }), true);
});

test("feed watchdog waits during cooldown and active reconnection", () => {
  const now = Date.parse("2026-11-14T10:00:00.000Z");
  assert.equal(shouldReconnectMarketFeed({
    connected: true, socketActive: true,
    lastQuoteAt: "2026-11-14T09:58:00.000Z",
    lastReconnectAt: now - 20_000, now
  }), false);
  assert.equal(shouldReconnectMarketFeed({
    connected: false, socketActive: true, now
  }), false);
});

test("feed watchdog retries a fully disconnected socket after cooldown", () => {
  const now = Date.parse("2026-11-14T10:00:00.000Z");
  assert.equal(shouldReconnectMarketFeed({
    connected: false, socketActive: false, now
  }), true);
});

test("empty M1 provider windows back off for five minutes", () => {
  assert.equal(getM1ImportRetryDelayMs({ status: "chunk_imported", matched_candles: 0 }), 300_000);
  assert.equal(getM1ImportRetryDelayMs({ status: "chunk_imported", matched_candles: 12 }), 0);
  assert.equal(getM1ImportRetryDelayMs({ status: "backfill_complete", imported: 0 }), 0);
});
