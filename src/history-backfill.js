const DAY_MS = 24 * 60 * 60 * 1000;

function toTimestamp(value) {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) throw new Error("Invalid historical backfill date");
  return timestamp;
}

export function planHistoryBackfillChunk({ start, targetBefore, now = new Date(), chunkDays = 7 }) {
  const fromMs = toTimestamp(start);
  const targetMs = toTimestamp(targetBefore);
  const endMs = toTimestamp(now);
  if (!Number.isInteger(chunkDays) || chunkDays < 1 || chunkDays > 31) {
    throw new Error("chunkDays must be an integer between 1 and 31");
  }
  if (fromMs >= targetMs || fromMs >= endMs) {
    return { done: true, from: new Date(fromMs).toISOString(), to: new Date(fromMs).toISOString() };
  }
  const toMs = Math.min(fromMs + chunkDays * DAY_MS, targetMs, endMs);
  return {
    done: false,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString()
  };
}

export function advanceHistoryBackfill(state, nextStart) {
  const nextMs = toTimestamp(nextStart);
  const targetMs = toTimestamp(state.target_before);
  return {
    ...state,
    next_start: new Date(nextMs).toISOString(),
    mode: nextMs >= targetMs ? "complete" : "backfill"
  };
}
