export function getMarketFeedHealth({ connected, lastQuoteAt, now = Date.now(), maxAgeMs = 90_000 }) {
  const timestamp = lastQuoteAt ? new Date(lastQuoteAt).getTime() : NaN;
  const ageMs = Number.isFinite(timestamp) ? now - timestamp : null;
  const fresh = ageMs !== null && ageMs >= -30_000 && ageMs <= maxAgeMs;

  return {
    status: fresh ? "fresh" : connected ? "connected_without_fresh_quote" : "disconnected",
    socketConnected: Boolean(connected),
    fresh,
    lastQuoteAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
    ageMs
  };
}

export function getM1ImportRetryDelayMs(result) {
  const matched = Number(result?.matched_candles ?? result?.matchedCandles ?? result?.imported);
  return result?.status === "chunk_imported" && Number.isFinite(matched) && matched === 0
    ? 5 * 60 * 1000
    : 0;
}
