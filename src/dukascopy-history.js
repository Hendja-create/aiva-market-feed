import { getHistoricalRates } from "dukascopy-node";
import { planHistoryBackfillChunk, advanceHistoryBackfill, shouldRunIncrementalAfterBackfill } from "./history-backfill.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Public Dukascopy instrument IDs. Override or extend these through
// DUKASCOPY_INSTRUMENT_MAP (JSON) when a provider uses a different alias.
const DEFAULT_DUKASCOPY_INSTRUMENTS = Object.freeze({
  XAUUSD: "xauusd",
  US30: "usa30idxusd",
  NAS100: "usatechidxusd",
  SP500: "usa500idxusd",
  GER40: "deuidxeur",
  JP225: "jpnidxjpy"
});

export function resolveDukascopyInstrument(symbol) {
  const normalized = String(symbol || "").trim().toUpperCase();
  if (!normalized) throw new Error("A market symbol is required for Dukascopy history import.");

  let overrides = {};
  const rawOverrides = process.env.DUKASCOPY_INSTRUMENT_MAP;
  if (rawOverrides) {
    try {
      overrides = JSON.parse(rawOverrides);
    } catch {
      throw new Error("DUKASCOPY_INSTRUMENT_MAP must be valid JSON.");
    }
    if (!overrides || Array.isArray(overrides) || typeof overrides !== "object") {
      throw new Error("DUKASCOPY_INSTRUMENT_MAP must be a JSON object.");
    }
  }

  const configured = overrides[normalized] ?? overrides[normalized.toLowerCase()];
  const instrument = configured ?? DEFAULT_DUKASCOPY_INSTRUMENTS[normalized] ?? normalized.toLowerCase();
  if (typeof instrument !== "string" || !instrument.trim()) {
    throw new Error("No valid Dukascopy instrument configured for " + normalized + ".");
  }
  return instrument.trim().toLowerCase();
}

function validCandle(c) {
  return c && Number.isFinite(Number(c.timestamp)) &&
    ["open", "high", "low", "close"].every(k => Number.isFinite(Number(c[k])) && Number(c[k]) > 0);
}

async function fetchSide(symbol, from, to, priceType, timeframe) {
  return getHistoricalRates({
    instrument: resolveDukascopyInstrument(symbol),
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

async function saveImportState(db, state) {
  await db("aiva_history_import_state?on_conflict=symbol,timeframe", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ ...state, updated_at: new Date().toISOString() })
  });
}

async function importRows(db, symbol, timeframe, from, to) {
  const [bidRows, askRows] = await Promise.all([
    fetchSide(symbol, from, to, "bid", timeframe),
    fetchSide(symbol, from, to, "ask", timeframe)
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
  return { bidCandles: bids.size, askCandles: asks.size, matchedCandles: rows.length };
}

async function runBackfillChunk(db, symbol, timeframe, configuredStart) {
  const stateRows = await db("aiva_history_import_state?symbol=eq." + encodeURIComponent(symbol) +
    "&timeframe=eq." + timeframe + "&select=symbol,timeframe,mode,next_start,target_before&limit=1");

  let state = stateRows[0] || null;
  if (!state) {
    const earliest = await db("aiva_historical_m1?symbol=eq." + encodeURIComponent(symbol) +
      "&timeframe=eq." + timeframe + "&select=candle_at&order=candle_at.asc&limit=1");
    if (!earliest.length) {
      return { status: "backfill_waiting_for_seed_history", symbol, timeframe, imported: 0 };
    }
    const plan = planHistoryBackfillChunk({
      start: configuredStart,
      targetBefore: earliest[0].candle_at,
      now: new Date()
    });
    state = {
      symbol, timeframe,
      mode: plan.done ? "complete" : "backfill",
      next_start: plan.from,
      target_before: earliest[0].candle_at
    };
    await saveImportState(db, state);
  }

  if (state.mode !== "backfill") {
    return { status: "backfill_complete", symbol, timeframe, imported: 0 };
  }

  const plan = planHistoryBackfillChunk({
    start: state.next_start,
    targetBefore: state.target_before,
    now: new Date()
  });
  if (plan.done) {
    await saveImportState(db, { ...state, mode: "complete" });
    return { status: "backfill_complete", symbol, timeframe, imported: 0 };
  }

  const imported = await importRows(db, symbol, timeframe, plan.from, plan.to);
  const nextState = advanceHistoryBackfill(state, plan.to);
  await saveImportState(db, nextState);
  return {
    status: nextState.mode === "complete" ? "backfill_complete" : "backfill_chunk_imported",
    symbol, timeframe, from: plan.from, to: plan.to,
    ...imported, imported: imported.matchedCandles,
    next_start: nextState.next_start, target_before: nextState.target_before
  };
}

async function importDukascopyChunk(db, symbol, timeframe, startDate) {
  const backfillEnabled = process.env["DUKASCOPY_" + timeframe + "_BACKFILL_ENABLED"] === "true";
  const backfillStart = process.env["DUKASCOPY_" + timeframe + "_BACKFILL_START_DATE"] || "2016-01-01";
  let backfillResult = null;
  if (backfillEnabled) {
    backfillResult = await runBackfillChunk(db, symbol, timeframe, backfillStart);
    if (!shouldRunIncrementalAfterBackfill(backfillResult)) return backfillResult;
  }

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
  const imported = await importRows(db, symbol, timeframe, from, to);
  return {
    status: "chunk_imported", symbol, timeframe, from, to,
    bid_candles: imported.bidCandles, ask_candles: imported.askCandles,
    matched_candles: imported.matchedCandles, imported: imported.matchedCandles, next_start: to,
    ...(backfillResult?.status === "backfill_waiting_for_seed_history"
      ? { backfill_status: backfillResult.status }
      : {})
  };
}

export async function importDukascopyM1Chunk(db, symbol = "XAUUSD") {
  return importDukascopyChunk(db, symbol, "M1", process.env.DUKASCOPY_M1_START_DATE);
}

export async function importDukascopyM5Chunk(db, symbol = "XAUUSD") {
  return importDukascopyChunk(db, symbol, "M5", process.env.DUKASCOPY_M5_START_DATE);
}
