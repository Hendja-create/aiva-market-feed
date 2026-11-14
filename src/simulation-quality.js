export function isValidSimulationCandle(candle) {
  const fields = ["bid_open","bid_high","bid_low","bid_close","ask_open","ask_high","ask_low","ask_close","spread_close"];
  if (!candle || !fields.every(key => Number.isFinite(Number(candle[key])))) return false;
  const n = key => Number(candle[key]);
  if (!Number.isFinite(Date.parse(candle.candle_at))) return false;
  if (fields.slice(0,8).some(key => n(key) <= 0) || n("spread_close") <= 0) return false;
  if (n("bid_high") < Math.max(n("bid_open"),n("bid_close"),n("bid_low")) ||
      n("bid_low") > Math.min(n("bid_open"),n("bid_close"),n("bid_high")) ||
      n("ask_high") < Math.max(n("ask_open"),n("ask_close"),n("ask_low")) ||
      n("ask_low") > Math.min(n("ask_open"),n("ask_close"),n("ask_high"))) return false;
  if (["open","high","low","close"].some(side => n("ask_"+side) < n("bid_"+side))) return false;
  return true;
}

export function isContinuousWindow(candles, startIndex, endIndex, intervalMs) {
  if (!Array.isArray(candles) || startIndex < 0 || endIndex >= candles.length || startIndex > endIndex) return false;
  for (let i = startIndex + 1; i <= endIndex; i++) {
    const gap = Date.parse(candles[i].candle_at) - Date.parse(candles[i-1].candle_at);
    if (gap !== intervalMs) return false;
  }
  return true;
}
