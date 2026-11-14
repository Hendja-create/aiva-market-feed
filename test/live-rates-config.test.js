import test from "node:test";
import assert from "node:assert/strict";
import { isLiveRatesConfigured } from "../src/live-rates-config.js";

test("Live-Rates is disabled when the provider key is missing", () => {
  assert.equal(isLiveRatesConfigured({}), false);
  assert.equal(isLiveRatesConfigured({ LIVE_RATES_API_KEY: "" }), false);
  assert.equal(isLiveRatesConfigured({ LIVE_RATES_API_KEY: "   " }), false);
});

test("Live-Rates is enabled when a non-empty provider key is configured", () => {
  assert.equal(isLiveRatesConfigured({ LIVE_RATES_API_KEY: "test-key" }), true);
});
