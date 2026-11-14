export function getMarketFeedHealth({ connected, lastQuoteAt, connectedAt = null, reconnecting = false, now = Date.now(), maxAgeMs = 90_000 }) {
  const reference = lastQuoteAt || (connected ? connectedAt : null);
  const timestamp = reference ? new Date(reference).getTime() : NaN;
  const ageMs = Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : null;
  const fresh = Boolean(lastQuoteAt) && Number.isFinite(timestamp) && ageMs <= maxAgeMs;

  let status = "disconnected";
  if (fresh) status = "fresh";
  else if (reconnecting) status = "reconnecting";
  else if (connected) status = "stale";

  return {
    status,
    socketConnected: Boolean(connected),
    fresh,
    lastQuoteAt: Number.isFinite(lastQuoteAt ? new Date(lastQuoteAt).getTime() : NaN)
      ? new Date(lastQuoteAt).toISOString() : null,
    ageMs
  };
}

export function shouldReconnectMarketFeed({
  connected, socketActive = false, lastQuoteAt, connectedAt = null,
  lastReconnectAt = 0, now = Date.now(), maxAgeMs = 90_000, cooldownMs = 60_000
}) {
  if (now - lastReconnectAt < cooldownMs) return false;
  if (connected && socketActive) {
    const quoteTimestamp = lastQuoteAt ? new Date(lastQuoteAt).getTime() : NaN;
    const connectionTimestamp = connectedAt ? new Date(connectedAt).getTime() : NaN;
    const referenceTimestamp = Math.max(
      Number.isFinite(quoteTimestamp) ? quoteTimestamp : 0,
      Number.isFinite(connectionTimestamp) ? connectionTimestamp : 0
    );
    return referenceTimestamp > 0 && now - referenceTimestamp > maxAgeMs;
  }
  return !connected && !socketActive;
}

export function getM1ImportRetryDelayMs(result) {
  const matched = Number(result?.matched_candles ?? result?.matchedCandles ?? result?.imported);
  return result?.status === "chunk_imported" && Number.isFinite(matched) && matched === 0
    ? 5 * 60 * 1000
    : 0;
}
