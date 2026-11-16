import test from "node:test";
import assert from "node:assert/strict";
import { shouldPersistHistoricalTick } from "../src/quote-sampling.js";

test("first quote for a symbol is persisted", () => {
  assert.equal(shouldPersistHistoricalTick(undefined, 1000, 5000), true);
});

test("ticks inside the sampling interval are skipped", () => {
  assert.equal(shouldPersistHistoricalTick(1000, 5999, 5000), false);
});

test("a tick is persisted when the sampling interval has elapsed", () => {
  assert.equal(shouldPersistHistoricalTick(1000, 6000, 5000), true);
});

test("invalid timestamps are rejected", () => {
  assert.equal(shouldPersistHistoricalTick(1000, NaN, 5000), false);
});
