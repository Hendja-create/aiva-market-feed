import { getHistoricalRates } from "dukascopy-node";

const DAY_MS = 24 * 60 * 60 * 1000;

function validCandle(c) {
  return c && Number.isFinite(Number(c.timestamp)) &&
    ["open", "high", "low", "close"].every(k => Number.isFinite(Number(c[k])) && Number(c[k]) > 0);
}

async function fetchSide(from, to, priceType, timeframe) {
  return getHistoricalRates({
    instrument: "xauusd",
    dates: { from, to },
    timeframe: timeframe.toLowerCase(),
    priceType,
    format: "json",
    volumes: true,
    ignoreFlats: false,
    batchSize: 5,
    pauseBetweenBatchesMs: 1200,
    retryCount: 3,
    retryOnEmpty: false,
    pauseBetweenRetriesMs: 1500,
    failAfterRetryCount: false,
    useCache: true,
    cacheFolderPath: process.env.DUKASCOPY_CACHE_PATH || "/tmp/dukascopy-cache"
  });
}

async function importDukascopyChunk(db, symbol, timeframe, startDate) {
  const intervalMs = timeframe === "M5" ? 5 * 60 * 1000 : 60 * 1000;
  const latest = await db("aiva_historical_m1?symbol=eq." + encodeURIComponent(symbol) +
    "&timeframe=eq." + timeframe + "&select=candle_at&order=candle_at.desc&limit=1");
  const configuredStart = startDate || process.env["DUKASCOPY_" + timeframe + "_START_DATE"] || "2026-08-01";
  const fromMs = latest.length
    ? new Date(latest[0].candle_at).getTime() + intervalMs
    : new Date(configuredStart + "T00:00:00.000Z").getTime();

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const endMs = todayStart.getTime();
  if (!Number.isFinite(fromMs) || fromMs >= endMs) {
    return { status: "current", symbol, timeframe, last_candle_at: latest[0]?.candle_at || null, imported: 0 };
  }

  const toMs = Math.min(fromMs + 7 * DAY_MS, endMs);
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();
  const [bidRows, askRows] = await Promise.all([
    fetchSide(from, to, "bid", timeframe),
    fetchSide(from, to, "ask", timeframe)
  ]);

  const bids = new Map((Array.isArray(bidRows) ? bidRows : [])
    .filter(validCandle).map(c => [Number(c.timestamp), c]));
  const asks = new Map((Array.isArray(askRows) ? askRows : [])
    .filter(validCandle).map(c => [Number(c.timestamp), c]));

  const rows = [];
  for (const [timestamp, bid] of bids) {
    const ask = asks.get(timestamp);
    if (!ask) continue;
    const spreads = {
      open: Number(ask.open) - Number(bid.open),
      high: Number(ask.high) - Number(bid.high),
      low: Number(ask.low) - Number(bid.low),
      close: Number(ask.close) - Number(bid.close)
    };
    if (Object.values(spreads).some(v => !Number.isFinite(v) || v < 0)) continue;
    rows.push({
      symbol, timeframe,
      candle_at: new Date(timestamp).toISOString(),
      bid_open: bid.open, bid_high: bid.high, bid_low: bid.low, bid_close: bid.close,
      ask_open: ask.open, ask_high: ask.high, ask_low: ask.low, ask_close: ask.close,
      spread_open: spreads.open, spread_high: spreads.high,
      spread_low: spreads.low, spread_close: spreads.close,
      bid_volume: bid.volume ?? null, ask_volume: ask.volume ?? null,
      source: "dukascopy"
    });
  }
  rows.sort((a, b) => a.candle_at.localeCompare(b.candle_at));

  for (let i = 0; i < rows.length; i += 400) {
    await db("aiva_historical_m1?on_conflict=symbol,timeframe,candle_at", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows.slice(i, i + 400))
    });
  }

  return {
    status: "chunk_imported", symbol, timeframe, from, to,
    bid_candles: bids.size, ask_candles: asks.size,
    matched_candles: rows.length, imported: rows.length, next_start: to
  };
}

export async function importDukascopyM1Chunk(db, symbol = "XAUUSD") {
  return importDukascopyChunk(db, symbol, "M1", process.env.DUKASCOPY_M1_START_DATE);
}

export async function importDukascopyM5Chunk(db, symbol = "XAUUSD") {
  return importDukascopyChunk(db, symbol, "M5", process.env.DUKASCOPY_M5_START_DATE);
}
