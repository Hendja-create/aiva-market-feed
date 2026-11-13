import test from "node:test";
import assert from "node:assert/strict";
import { advanceHistoryBackfill, planHistoryBackfillChunk } from "../src/history-backfill.js";

test("backfill advances in seven-day chunks and stops at the existing history boundary", () => {
  const plan = planHistoryBackfillChunk({
    start: "2016-01-01T00:00:00.000Z",
    targetBefore: "2016-01-20T00:00:00.000Z",
    now: "2026-11-13T00:00:00.000Z"
  });
  assert.equal(plan.from, "2016-01-01T00:00:00.000Z");
  assert.equal(plan.to, "2016-01-08T00:00:00.000Z");
  assert.equal(plan.done, false);
});

test("final backfill chunk is capped at the earliest existing candle", () => {
  const plan = planHistoryBackfillChunk({
    start: "2016-01-15T00:00:00.000Z",
    targetBefore: "2016-01-20T12:00:00.000Z",
    now: "2026-11-13T00:00:00.000Z"
  });
  assert.equal(plan.to, "2016-01-20T12:00:00.000Z");
  const next = advanceHistoryBackfill({
    symbol: "XAUUSD", timeframe: "M5", mode: "backfill",
    next_start: plan.from, target_before: "2016-01-20T12:00:00.000Z"
  }, plan.to);
  assert.equal(next.mode, "complete");
});

test("backfill does not request future dates or run after completion", () => {
  const plan = planHistoryBackfillChunk({
    start: "2026-11-14T00:00:00.000Z",
    targetBefore: "2026-11-15T00:00:00.000Z",
    now: "2026-11-13T00:00:00.000Z"
  });
  assert.equal(plan.done, true);
});

test("invalid dates and chunk sizes fail closed", () => {
  assert.throws(() => planHistoryBackfillChunk({
    start: "not-a-date", targetBefore: "2020-01-01", now: "2026-11-13"
  }), /Invalid historical backfill date/);
  assert.throws(() => planHistoryBackfillChunk({
    start: "2016-01-01", targetBefore: "2020-01-01", chunkDays: 0
  }), /chunkDays/);
});
