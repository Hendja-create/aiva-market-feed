import http from "node:http";
import { io } from "socket.io-client";
import { importDukascopyM1Chunk, importDukascopyM5Chunk } from "./dukascopy-history.js";
import { runM1ScalpingBacktest } from "./scalping-backtest.js";
import { runVolatilityReversalBacktest } from "./volatility-reversal-backtest.js";
import { runLiquiditySweepBacktest } from "./liquidity-sweep-backtest.js";
import { runStrategyTournament } from "./strategy-tournament.js";
import { runInverseKeltnerBacktest, runInverseKeltnerDemoCycle, getInverseKeltnerDemoStatus } from "./inverse-keltner-demo.js";
import { buildQuoteSnapshot, calculateDemoPnl, getDemoExecutionCosts } from "./execution-accounting.js";

const required = ["LIVE_RATES_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_PUBLISHABLE_KEY"];
for (const key of required) {
  if (!process.env[key]) {
    console.error("Missing required environment variable:", key);
    process.exit(1);
  }
}

const symbols = (process.env.SYMBOLS || "XAUUSD").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
const host = process.env.LIVE_RATES_SOCKET_HOST || "eu-wss.live-rates.com";
const baseUrl = process.env.SUPABASE_URL.replace(/\/$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
let connected = false, lastQuoteAt = null, lastError = null, received = 0;
const analysisRateLimit = new Map();
let adaptiveConfidenceThreshold = 0.65;
let autonomousCycleRunning = false;
async function loadAdaptiveState(symbol) {
  const rows = await db("aiva_learning_state?symbol=eq." + encodeURIComponent(symbol) +
    "&select=confidence_threshold&limit=1");
  if (rows.length) {
    const stored = Number(rows[0].confidence_threshold);
    if (Number.isFinite(stored) && stored >= 0.50 && stored <= 0.85) {
      adaptiveConfidenceThreshold = stored;
    }
  }
}


async function db(path, options = {}) {
  const response = await fetch(baseUrl + "/rest/v1/" + path, {
    ...options,
    headers: {
      apikey: serviceKey,
      Authorization: "Bearer " + serviceKey,
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error("Supabase " + response.status + ": " + (await response.text()).slice(0, 250));
  if (response.status === 204) return null;
  const responseText = await response.text();
  if (!responseText.trim()) return null;
  try { return JSON.parse(responseText); }
  catch { throw new Error("Supabase returned invalid JSON"); }
}

function send(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": res.getHeader("access-control-allow-origin") || process.env.DASHBOARD_ORIGIN || "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
    "vary": "Origin"
  });
  res.end(JSON.stringify(body));
}

async function verifyUserToken(token) {
  if (!token) return false;
  const response = await fetch(baseUrl + "/auth/v1/user", {
    headers: { apikey: publishableKey, Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) return false;
  const user = await response.json();
  return Boolean(user && user.id);
}



// Historical daily closes are a separate market-regime/context layer.
// They do not authorize or block intraday scalping entries until independently validated.
const historicalContextCache = new Map();
let historicalImportRunning = false;
let historicalM1ImportRunning = false;
let historicalM1LastRun = null;
let historicalM5ImportRunning = false;
let historicalM5LastRun = null;

function utcDateString(date) { return date.toISOString().slice(0, 10); }
function addUtcDays(dateString, days) {
  const d = new Date(dateString + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + days);
  return utcDateString(d);
}
function parseHistoricalSeries(payload) {
  const rows = [];
  const datePattern = /^\d{4}-\d{2}-\d{2}/;
  const numeric = value => {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const walk = value => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (!value || typeof value !== "object") return;
    const dateValue = value.date ?? value.day ?? value.datetime ?? value.timestamp ?? value.time;
    if (typeof dateValue === "string" && datePattern.test(dateValue)) {
      let close = null;
      for (const key of ["close", "rate", "price", "value", "USD", "XAUUSD"]) {
        close = numeric(value[key]);
        if (close !== null) break;
      }
      if (close === null && value.rates && typeof value.rates === "object") {
        close = numeric(value.rates.USD ?? value.rates.XAUUSD ?? value.rates["XAU/USD"]);
      }
      if (close !== null) rows.push({ session_date: dateValue.slice(0, 10), close });
    }
    for (const [key, child] of Object.entries(value)) {
      if (datePattern.test(key)) {
        const close = numeric(child && typeof child === "object"
          ? (child.USD ?? child.close ?? child.rate ?? child.price ?? child.value ?? child.XAUUSD)
          : child);
        if (close !== null) rows.push({ session_date: key.slice(0, 10), close });
      }
      if (child && typeof child === "object") walk(child);
    }
  };
  walk(payload);
  return [...new Map(rows.map(row => [row.session_date, row])).values()]
    .sort((x, y) => x.session_date.localeCompare(y.session_date));
}
async function getHistoricalContext(symbol) {
  const cached = historicalContextCache.get(symbol);
  if (cached && Date.now() - cached.at < 15 * 60 * 1000) return cached.value;
  const rows = await db("aiva_historical_daily?symbol=eq." + encodeURIComponent(symbol) +
    "&select=session_date,close&order=session_date.desc&limit=4000");
  const daily = rows.slice().reverse().map(row => ({
    date: row.session_date, close: Number(row.close)
  })).filter(row => Number.isFinite(row.close) && row.close > 0);
  if (daily.length < 30) {
    return { available: false, observations: daily.length,
      message: "Historique quotidien en cours de constitution ; contexte historique non utilisé." };
  }
  const returns = [];
  for (let i = 1; i < daily.length; i++) returns.push((daily[i].close - daily[i - 1].close) / daily[i - 1].close);
  const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const std = values => {
    if (values.length < 2) return 0;
    const m = mean(values);
    return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
  };
  const last5 = returns.slice(-5);
  const last20 = returns.slice(-20);
  const momentum5d = last5.reduce((sum, value) => sum + value, 0);
  const momentum20d = last20.reduce((sum, value) => sum + value, 0);
  const volatility20d = std(last20);
  const baselineVolatility = std(returns.slice(-Math.min(250, returns.length)));
  const regime = volatility20d > baselineVolatility * 1.5 ? "high_volatility"
    : momentum20d > volatility20d * 1.5 ? "bullish"
    : momentum20d < -volatility20d * 1.5 ? "bearish" : "range_or_mixed";

  // Compare the latest five-session return sequence with older sequences.
  // Leave a five-session gap and five future sessions to prevent target leakage.
  const candidates = [];
  const scale = Math.max(std(returns), 1e-8);
  for (let end = 25; end <= returns.length - 10; end++) {
    const sequence = returns.slice(end - 5, end);
    let distance = 0;
    for (let j = 0; j < 5; j++) distance += ((sequence[j] - last5[j]) / scale) ** 2;
    const forward5d = returns.slice(end, end + 5).reduce((sum, value) => sum + value, 0);
    candidates.push({ distance, forward5d });
  }
  candidates.sort((x, y) => x.distance - y.distance);
  const matches = candidates.slice(0, 30);
  const positive = matches.filter(item => item.forward5d > 0).length;
  const negative = matches.filter(item => item.forward5d < 0).length;
  const avgForward5d = mean(matches.map(item => item.forward5d));
  const result = {
    available: true, source: "Live-Rates historical daily close",
    first_date: daily[0].date, last_date: daily[daily.length - 1].date,
    observations: daily.length,
    momentum_5d_pct: Number((momentum5d * 100).toFixed(3)),
    momentum_20d_pct: Number((momentum20d * 100).toFixed(3)),
    volatility_20d_pct: Number((volatility20d * 100).toFixed(3)),
    regime,
    similar_patterns: matches.length,
    similar_patterns_up_5d: positive,
    similar_patterns_down_5d: negative,
    similar_patterns_flat_5d: matches.length - positive - negative,
    historical_up_frequency: matches.length ? Number((positive / matches.length).toFixed(4)) : null,
    average_forward_5d_pct: Number((avgForward5d * 100).toFixed(3)),
    use_in_live_decision: false,
    note: "Contexte quotidien informatif uniquement ; aucun filtre de scalping n'est modifié."
  };
  historicalContextCache.set(symbol, { at: Date.now(), value: result });
  return result;
}
async function importHistoricalDaily(symbol) {
  if (!process.env.LIVE_RATES_API_KEY || historicalImportRunning) return;
  historicalImportRunning = true;
  try {
    const existing = await db("aiva_historical_daily?symbol=eq." + encodeURIComponent(symbol) +
      "&select=session_date&order=session_date.desc&limit=1");
    const yesterday = addUtcDays(utcDateString(new Date()), -1);
    let cursor = existing.length ? addUtcDays(existing[0].session_date, 1) : "2016-01-01";
    if (cursor > yesterday) {
      console.log("Historical daily data already current", JSON.stringify({ symbol, through: existing[0]?.session_date || null }));
      return;
    }
    let imported = 0, requests = 0;
    while (cursor <= yesterday) {
      const chunkEndCandidate = addUtcDays(cursor, 29);
      const chunkEnd = chunkEndCandidate < yesterday ? chunkEndCandidate : yesterday;
      const endpoint = new URL("https://www.live-rates.com/historical/series");
      endpoint.searchParams.set("base", "XAU");
      endpoint.searchParams.set("symbols", "USD");
      endpoint.searchParams.set("start", cursor);
      endpoint.searchParams.set("end", chunkEnd);
      endpoint.searchParams.set("key", process.env.LIVE_RATES_API_KEY);
      let response;
      for (let attempt = 0; attempt < 8; attempt++) {
        response = await fetch(endpoint, { signal: AbortSignal.timeout(20000) });
        if (response.status !== 429) break;
        const retryHeader = Number(response.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryHeader) && retryHeader > 0
          ? Math.min(300000, retryHeader * 1000)
          : Math.min(300000, 60000 * (attempt + 1));
        console.warn("Historical provider rate limit; resuming same batch after cooldown", JSON.stringify({
          symbol, start: cursor, end: chunkEnd, attempt: attempt + 1, wait_ms: waitMs
        }));
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
      if (!response?.ok) throw new Error("Live-Rates historical HTTP " + (response?.status || "network_error"));
      const payload = await response.json();
      if (payload?.error) throw new Error("Live-Rates historical: " + String(payload.error).slice(0, 160));
      const parsed = parseHistoricalSeries(payload);
      if (!parsed.length && !(Array.isArray(payload) && payload.length === 0)) {
        throw new Error("Format de série historique non reconnu pour " + cursor + " → " + chunkEnd +
          " ; clés reçues: " + Object.keys(payload || {}).slice(0, 12).join(","));
      }
      if (parsed.length) {
        const batch = parsed.map(row => ({
          symbol, session_date: row.session_date, close: row.close,
          source: "live-rates-historical", fetched_at: new Date().toISOString()
        }));
        await db("aiva_historical_daily?on_conflict=symbol,session_date", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(batch)
        });
        imported += batch.length;
      }
      requests++;
      console.log("Historical daily batch processed", JSON.stringify({
        symbol, start: cursor, end: chunkEnd, rows: parsed.length, total_imported: imported
      }));
      cursor = addUtcDays(chunkEnd, 1);
      if (cursor <= yesterday) await new Promise(resolve => setTimeout(resolve, 6500));
    }
    historicalContextCache.delete(symbol);
    console.log("Historical daily import complete", JSON.stringify({ symbol, imported, requests, through: yesterday }));
  } catch (error) {
    console.error("Historical daily import failed", error instanceof Error ? error.message : String(error));
  } finally {
    historicalImportRunning = false;
  }
}

async function runHistoricalM1Import(symbol) {
  if (historicalM1ImportRunning) return;
  historicalM1ImportRunning = true;
  try {
    const result = await importDukascopyM1Chunk(db, symbol);
    historicalM1LastRun = { ...result, completed_at: new Date().toISOString() };
    console.log("Dukascopy M1 import cycle", JSON.stringify(historicalM1LastRun));
  } catch (error) {
    historicalM1LastRun = {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
      completed_at: new Date().toISOString()
    };
    console.error("Dukascopy M1 import failed", historicalM1LastRun.message);
  } finally {
    historicalM1ImportRunning = false;
  }
}

async function runHistoricalM5Import(symbol) {
  if (historicalM5ImportRunning) return;
  historicalM5ImportRunning = true;
  try {
    const result = await importDukascopyM5Chunk(db, symbol);
    historicalM5LastRun = { ...result, completed_at: new Date().toISOString() };
    console.log("Dukascopy M5 import cycle", JSON.stringify(historicalM5LastRun));
  } catch (error) {
    historicalM5LastRun = {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
      completed_at: new Date().toISOString()
    };
    console.error("Dukascopy M5 import failed", historicalM5LastRun.message);
  } finally {
    historicalM5ImportRunning = false;
  }
}

async function runHistoricalDailyValidation(symbol) {
  const rows = await db("aiva_historical_daily?symbol=eq." + encodeURIComponent(symbol) +
    "&select=session_date,close&order=session_date.asc&limit=4000");
  const daily = rows.map(row => ({ date: row.session_date, close: Number(row.close) }))
    .filter(row => Number.isFinite(row.close) && row.close > 0);
  if (daily.length < 180) {
    return { available: false, observations: daily.length, required_observations: 180,
      message: "Historique insuffisant pour une validation walk-forward fiable." };
  }
  const returns = daily.slice(1).map((row, i) => (row.close - daily[i].close) / daily[i].close);
  const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const std = values => {
    if (values.length < 2) return 1e-8;
    const m = mean(values);
    return Math.max(1e-8, Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1)));
  };
  const baseline = [], analogue = [];
  // Each test date only sees analogues whose complete five-session outcome
  // was already known before that test date. No future leakage.
  for (let end = 180; end <= returns.length - 5; end++) {
    const query = returns.slice(end - 5, end);
    const scale = std(returns.slice(0, end));
    const candidates = [];
    for (let priorEnd = 10; priorEnd <= end - 5; priorEnd++) {
      const sequence = returns.slice(priorEnd - 5, priorEnd);
      let distance = 0;
      for (let j = 0; j < 5; j++) distance += ((sequence[j] - query[j]) / scale) ** 2;
      const forward = returns.slice(priorEnd, priorEnd + 5);
      if (forward.length !== 5) continue;
      candidates.push({ distance, outcome: forward.reduce((sum, value) => sum + value, 0) });
    }
    if (candidates.length < 30) continue;
    candidates.sort((a, b) => a.distance - b.distance);
    const nearest = candidates.slice(0, 30);
    const analogueScore = mean(nearest.map(item => item.outcome));
    const baselineScore = query.reduce((sum, value) => sum + value, 0);
    const actual = returns.slice(end, end + 5).reduce((sum, value) => sum + value, 0);
    if (Math.abs(actual) < 1e-8) continue;
    baseline.push({ predicted: Math.sign(baselineScore), actual: Math.sign(actual) });
    analogue.push({ predicted: Math.sign(analogueScore), actual: Math.sign(actual) });
  }
  const metrics = items => {
    const directional = items.filter(item => item.predicted !== 0);
    const correct = directional.filter(item => item.predicted === item.actual).length;
    const up = directional.filter(item => item.actual > 0);
    const down = directional.filter(item => item.actual < 0);
    const recallUp = up.length ? up.filter(item => item.predicted > 0).length / up.length : null;
    const recallDown = down.length ? down.filter(item => item.predicted < 0).length / down.length : null;
    return {
      evaluated: items.length, directional_predictions: directional.length,
      coverage: items.length ? Number((directional.length / items.length).toFixed(4)) : null,
      accuracy: directional.length ? Number((correct / directional.length).toFixed(4)) : null,
      balanced_accuracy: recallUp !== null && recallDown !== null
        ? Number(((recallUp + recallDown) / 2).toFixed(4)) : null
    };
  };
  const base = metrics(baseline), similar = metrics(analogue);
  return {
    available: baseline.length >= 100,
    symbol, horizon: "5 sessions", method: "walk_forward_nearest_30_patterns_vs_5d_momentum",
    first_date: daily[0].date, last_date: daily[daily.length - 1].date,
    observations: daily.length, baseline: base, historical_analogues: similar,
    accuracy_delta: base.accuracy !== null && similar.accuracy !== null
      ? Number((similar.accuracy - base.accuracy).toFixed(4)) : null,
    leakage_control: "Each analogue's five-session outcome ends before the evaluated date.",
    limitations: ["Daily directional research only; not a scalping backtest.",
      "No spread, slippage, commission or execution simulation.",
      "Historical accuracy does not establish future profitability.",
      ...(baseline.length < 100 ? ["Fewer than 100 walk-forward test cases; evidence remains weak."] : [])]
  };
}

async function getAnalysis(symbol) {
  const rows = await db("market_quote_ticks?symbol=eq." + encodeURIComponent(symbol) +
    "&select=bid,ask,mid,spread,received_at&order=received_at.desc&limit=300");
  const ticks = rows.slice().reverse();
  if (!ticks.length) throw new Error("Aucune cotation historique disponible");
  const latestTickAt = new Date(ticks[ticks.length - 1].received_at).getTime();
  const quoteAgeMs = Date.now() - latestTickAt;
  if (!Number.isFinite(latestTickAt) || quoteAgeMs > 90000 || quoteAgeMs < -30000) {
    throw new Error("Cotation trop ancienne ou horodatage invalide : analyse bloquée.");
  }
  const current = Number(ticks[ticks.length - 1].mid);
  const spread = Number(ticks[ticks.length - 1].spread);
  const prices = ticks.map(t => Number(t.mid)).filter(Number.isFinite);
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0) returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  const mean = returns.length ? returns.reduce((a,b) => a+b,0) / returns.length : 0;
  const variance = returns.length > 1 ? returns.reduce((a,b) => a + (b-mean)**2,0) / (returns.length-1) : 0;
  const sigma = Math.sqrt(variance);
  const horizon = 30;
  const blockLength = 3;
  const simulations = [];
  let up = 0, down = 0, flat = 0, sumMove = 0, adverse = 0;
  if (returns.length >= 2) {
    for (let s = 0; s < 100; s++) {
      let price = current, pathHigh = current, pathLow = current;
      for (let step = 0; step < horizon;) {
        const startIndex = Math.floor(Math.random() * returns.length);
        for (let j = 0; j < blockLength && step < horizon; j++, step++) {
          const sampled = returns[(startIndex + j) % returns.length];
          price *= 1 + sampled;
          pathHigh = Math.max(pathHigh, price);
          pathLow = Math.min(pathLow, price);
        }
      }
      const move = price - current;
      const maxAdverseMove = move >= 0 ? current - pathLow : pathHigh - current;
      const maxFavorableMove = move >= 0 ? pathHigh - current : current - pathLow;
      sumMove += move;
      if (move > spread) up++;
      else if (move < -spread) down++;
      else flat++;
      if (maxAdverseMove > Math.max(spread * 8, current * sigma * Math.sqrt(horizon) * 2.5)) adverse++;
      simulations.push({
        id: s + 1,
        terminal_price: Number(price.toFixed(3)),
        move: Number(move.toFixed(3)),
        max_adverse_move: Number(maxAdverseMove.toFixed(3)),
        max_favorable_move: Number(maxFavorableMove.toFixed(3)),
        outcome: move > spread ? "UP" : move < -spread ? "DOWN" : "FLAT"
      });
    }
  }
  const probabilityUp = up / 100;
  const probabilityDown = down / 100;
  const probabilityFlat = flat / 100;
  const expectedMove = sumMove / 100;
  const confidence = Math.max(probabilityUp, probabilityDown);
  const expectedRange = current * sigma * Math.sqrt(horizon);
  const spreadRatio = expectedRange > 0 ? spread / expectedRange : 1;
  const riskScore = Math.min(1, (adverse / 100) * 0.6 + Math.min(1, spreadRatio) * 0.4);
  const recentMomentum = returns.slice(-10).reduce((a,b) => a+b, 0);
  let decision = "NO_TRADE";
  let rationale = "";
  const candidateDirection = probabilityUp >= probabilityDown ? "BUY" : "SELL";
  const candidateProbability = candidateDirection === "BUY" ? probabilityUp : probabilityDown;
  const probabilityGap = Math.abs(probabilityUp - probabilityDown);
  const expectedMoveAligned = candidateDirection === "BUY" ? expectedMove : -expectedMove;
  const momentumAligned = candidateDirection === "BUY" ? recentMomentum > 0 : recentMomentum < 0;
  const decisionChecks = {
    enough_history: returns.length >= 30,
    acceptable_spread: spreadRatio <= 0.5,
    confidence: candidateProbability >= adaptiveConfidenceThreshold,
    directional_dominance: probabilityGap >= 0.25,
    expected_move_covers_spread: expectedMoveAligned > spread * 1.5,
    acceptable_risk: riskScore < 0.55,
    momentum_confirmation: momentumAligned
  };
  const blockingReasons = Object.entries(decisionChecks)
    .filter(([, passed]) => !passed)
    .map(([key]) => key);
  const decisionDiagnostics = {
    candidate_direction: candidateDirection,
    candidate_probability: Number(candidateProbability.toFixed(4)),
    probability_gap: Number(probabilityGap.toFixed(4)),
    confidence_threshold: adaptiveConfidenceThreshold,
    spread_ratio: Number(spreadRatio.toFixed(4)),
    expected_move_aligned: Number(expectedMoveAligned.toFixed(4)),
    required_move: Number((spread * 1.5).toFixed(4)),
    risk_score: Number(riskScore.toFixed(4)),
    recent_momentum_10: Number(recentMomentum.toFixed(8)),
    checks: decisionChecks,
    blocking_reasons: blockingReasons
  };
  if (blockingReasons.length === 0) {
    decision = candidateDirection;
    rationale = candidateDirection === "BUY"
      ? "Les trajectoires haussières dominent et tous les filtres de validation sont satisfaits."
      : "Les trajectoires baissières dominent et tous les filtres de validation sont satisfaits.";
  } else {
    const labels = {
      enough_history: "historique insuffisant",
      acceptable_spread: "spread trop élevé",
      confidence: "confiance sous le seuil",
      directional_dominance: "écart directionnel insuffisant",
      expected_move_covers_spread: "mouvement attendu insuffisant face au spread",
      acceptable_risk: "risque estimé trop élevé",
      momentum_confirmation: "momentum non confirmé"
    };
    rationale = "NO_TRADE : " + blockingReasons.map(key => labels[key]).join(", ") + ".";
  }
  const historicalContext = await getHistoricalContext(symbol).catch(error => ({ available: false, message: "Contexte historique indisponible: " + String(error).slice(0, 120) }));
  const result = {
    symbol, decision, simulations: 100, confidence: Number(confidence.toFixed(4)),
    probability_up: Number(probabilityUp.toFixed(4)), probability_down: Number(probabilityDown.toFixed(4)), probability_flat: Number(probabilityFlat.toFixed(4)),
    expected_move: Number(expectedMove.toFixed(4)), risk_score: Number(riskScore.toFixed(4)),
    rationale, features: { samples: prices.length, returns: returns.length, current_price: current, spread, mean_return: mean, volatility_per_tick: sigma, horizon_steps: horizon, block_length: blockLength, confidence_threshold: adaptiveConfidenceThreshold, recent_momentum_10: Number(recentMomentum.toFixed(8)), decision_diagnostics: decisionDiagnostics, historical_context: historicalContext, model: "block_bootstrap_monte_carlo_v2" },
    scenarios: simulations, generated_at: new Date().toISOString()
  };
  const saved = await db("market_analysis_runs", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      symbol, decision, simulations: 100, confidence: result.confidence,
      probability_up: result.probability_up, probability_down: result.probability_down,
      expected_move: result.expected_move, risk_score: result.risk_score,
      rationale, features: result.features, scenarios: simulations
    })
  });
  result.id = saved?.[0]?.id || null;
  return result;
}

async function evaluatePendingAnalyses(symbol) {
  const pending = await db("market_analysis_runs?symbol=eq." + encodeURIComponent(symbol) +
    "&evaluated_at=is.null&select=id,decision,features,created_at&order=created_at.asc&limit=25");
  let evaluated = 0;
  for (const run of pending) {
    const startPrice = Number(run.features?.current_price);
    const spread = Number(run.features?.spread || 0);
    if (!Number.isFinite(startPrice) || startPrice <= 0) continue;
    const ticks = await db("market_quote_ticks?symbol=eq." + encodeURIComponent(symbol) +
      "&received_at=gt." + encodeURIComponent(run.created_at) +
      "&select=mid&order=received_at.asc&limit=30");
    if (ticks.length < 30) continue;
    const endPrice = Number(ticks[29].mid);
    if (!Number.isFinite(endPrice)) continue;
    const actualMove = endPrice - startPrice;
    const actualDirection = actualMove > spread ? "UP" : actualMove < -spread ? "DOWN" : "FLAT";
    const predictionCorrect = run.decision === "BUY"
      ? actualDirection === "UP"
      : run.decision === "SELL"
        ? actualDirection === "DOWN"
        : null;
    await db("market_analysis_runs?id=eq." + encodeURIComponent(run.id), {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        evaluated_at: new Date().toISOString(),
        actual_move: Number(actualMove.toFixed(4)),
        actual_direction: actualDirection,
        prediction_correct: predictionCorrect,
        evaluation_ticks: 30
      })
    });
    evaluated++;
  }

  const history = await db("market_analysis_runs?symbol=eq." + encodeURIComponent(symbol) +
    "&evaluated_at=not.is.null&decision=in.(BUY,SELL)&select=decision,prediction_correct&order=evaluated_at.desc&limit=100");
  const reviewed = history.length;
  const accuracy = reviewed ? history.filter(row => row.prediction_correct === true).length / reviewed : null;
  if (reviewed >= 50 && accuracy !== null) {
    if (accuracy < 0.50) adaptiveConfidenceThreshold = 0.75;
    else if (accuracy < 0.57) adaptiveConfidenceThreshold = 0.72;
    else if (accuracy > 0.65) adaptiveConfidenceThreshold = 0.65;
    else adaptiveConfidenceThreshold = 0.68;
  }
  return { evaluated, reviewedDirectional: reviewed, accuracy, confidenceThreshold: adaptiveConfidenceThreshold };
}


function localDateKey(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Kinshasa", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function isoWeekKey(date) {
  // Group by the calendar date shown to users in Kinshasa, not the UTC date.
  // Using UTC noon avoids shifting the local date around midnight boundaries.
  const localDay = localDateKey(date);
  const d = new Date(localDay + "T12:00:00.000Z");
  const weekday = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - weekday + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return d.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
}
function periodKey(date, period) {
  const day = localDateKey(date);
  return period === "monthly" ? day.slice(0, 7) : period === "weekly" ? isoWeekKey(date) : day;
}
function kinshasaDayStartUtc(now = new Date()) {
  const key = localDateKey(now);
  const [year, month, day] = key.split("-").map(Number);
  // Africa/Kinshasa is UTC+1; convert local midnight to UTC.
  return new Date(Date.UTC(year, month - 1, day) - 60 * 60 * 1000).toISOString();
}

async function getDemoRiskState(symbol) {
  const maxDailyLoss = Math.max(1, Number(process.env.DEMO_MAX_DAILY_LOSS_POINTS || 15));
  const maxConsecutiveLosses = Math.max(1, Math.floor(Number(process.env.DEMO_MAX_CONSECUTIVE_LOSSES || 3)));
  const since = kinshasaDayStartUtc();
  const [todayRows, recentRows] = await Promise.all([
    db("aiva_demo_trades?symbol=eq." + encodeURIComponent(symbol) +
      "&status=eq.CLOSED&closed_at=gte." + encodeURIComponent(since) +
      "&select=pnl_points&limit=500"),    db("aiva_demo_trades?symbol=eq." + encodeURIComponent(symbol) +
      "&status=eq.CLOSED&closed_at=gte." + encodeURIComponent(since) +
      "&select=pnl_points,closed_at&order=closed_at.desc&limit=" + maxConsecutiveLosses)
  ]);
  const dailyPnl = todayRows.reduce((sum, row) => sum + Number(row.pnl_points || 0), 0);
  let consecutiveLosses = 0;
  for (const row of recentRows) {
    const pnl = Number(row.pnl_points || 0);
    if (pnl < 0) consecutiveLosses++;
    else break;
  }
  return {
    dailyPnl: Number(dailyPnl.toFixed(4)),
    maxDailyLoss,
    consecutiveLosses,
    maxConsecutiveLosses,
    blockedByDailyLoss: dailyPnl <= -maxDailyLoss,
    blockedByLosingStreak: consecutiveLosses >= maxConsecutiveLosses
  };
}

async function manageDemoTrade(symbol, analysis) {
  if (String(process.env.DEMO_TRADING_ENABLED || "true").toLowerCase() !== "true") {
    return { mode: "disabled" };
  }

  const stopLossPoints = Math.max(0.1, Number(process.env.DEMO_STOP_LOSS_POINTS || 5));
  const takeProfitPoints = Math.max(0.1, Number(process.env.DEMO_TAKE_PROFIT_POINTS || 8));
  const maxDailyLossPoints = Math.max(1, Number(process.env.DEMO_MAX_DAILY_LOSS_POINTS || 15));
  const maxConsecutiveLosses = Math.max(1, Math.floor(Number(process.env.DEMO_MAX_CONSECUTIVE_LOSSES || 3)));

  const openRows = await db("aiva_demo_trades?symbol=eq." + encodeURIComponent(symbol) +
    "&status=eq.OPEN&select=id,direction,entry_price,opened_at,context&order=opened_at.asc&limit=1");

  const quotes = await db("market_quotes?symbol=eq." + encodeURIComponent(symbol) +
    "&select=bid,ask,mid,spread,provider_timestamp,received_at,source,connection_status&limit=1");
  const q = quotes[0];
  const quoteTimestamp = q?.provider_timestamp || q?.received_at;
  const quoteAge = quoteTimestamp ? Date.now() - new Date(quoteTimestamp).getTime() : Infinity;
  const freshQuote = Boolean(q && Number.isFinite(quoteAge) && quoteAge >= -30000 && quoteAge <= 90000);
  const quote = q ? buildQuoteSnapshot(q, quoteAge) : null;

  if (openRows.length) {
    const trade = openRows[0];
    if (!freshQuote) {
      return { mode: "demo", open: true, trade_id: trade.id, risk_monitoring: "waiting_for_fresh_quote", quote_snapshot: quote };
    }

    const entryPrice = Number(trade.entry_price);
    const context = trade.context && typeof trade.context === "object" ? trade.context : {};
    // Legacy trades have no persisted entry quote or cost model; do not invent costs for them.
    const costs = context.execution_cost_model || { slippage_each_side: 0, commission_round_trip: 0 };
    const entryReferencePrice = Number(context.entry_quote?.fill_reference_price ?? entryPrice);
    const pnlDetails = calculateDemoPnl(
      trade.direction, entryPrice, entryReferencePrice, q, costs
    );
    const rawExitPrice = pnlDetails.raw_exit_price;
    const markPrice = pnlDetails.effective_exit_price;
    const pnl = pnlDetails.net_pnl_points;
    const sl = Math.max(0.1, Number(context.stop_loss_points || stopLossPoints));
    const tp = Math.max(0.1, Number(context.take_profit_points || takeProfitPoints));

    let closeReason = null;
    if (pnl <= -sl) closeReason = "Stop-loss virtuel atteint";
    else if (pnl >= tp) closeReason = "Take-profit virtuel atteint";

    let ticks = [];
    if (!closeReason) {
      ticks = await db("market_quote_ticks?symbol=eq." + encodeURIComponent(symbol) +
        "&received_at=gt." + encodeURIComponent(trade.opened_at) +
        "&select=bid,ask,mid,received_at&order=received_at.asc&limit=30");
      if (ticks.length >= 30) closeReason = "Horizon de 30 cotations atteint";
    }

    if (closeReason) {
      const exitPrice = markPrice;
      const finalPnl = Number(pnl.toFixed(4));
      await db("aiva_demo_trades?id=eq." + encodeURIComponent(trade.id), {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          exit_price: exitPrice,
          pnl_points: finalPnl,
          status: "CLOSED",
          closed_at: new Date().toISOString(),
          close_reason: closeReason,
          context: {
            ...context,
            exit_quote: { ...quote, fill_reference_price: rawExitPrice,
              fill_side: trade.direction === "BUY" ? "BID" : "ASK" },
            pnl_accounting: {
              gross_quote_pnl_points: pnlDetails.gross_quote_pnl_points,
              slippage_total_points: pnlDetails.slippage_total_points,
              commission_round_trip_points: pnlDetails.commission_round_trip_points,
              net_pnl_points: finalPnl,
              basis: context.execution_cost_model ? "bid_ask_plus_slippage_commission" : "legacy_no_explicit_cost_model"
            }
          }
        })
      });
      console.log("Demo trade closed", JSON.stringify({
        symbol, direction: trade.direction, pnl_points: finalPnl, close_reason: closeReason
      }));
      return { mode: "demo", closed: true, trade_id: trade.id, pnl_points: finalPnl, pnl_basis: context.execution_cost_model ? "net_after_costs" : "legacy_gross_no_explicit_costs", close_reason: closeReason, quote_snapshot: quote };
    }

    return {
      mode: "demo", open: true, trade_id: trade.id, pnl_points: Number(pnl.toFixed(4)),
      stop_loss_remaining: Number(Math.max(0, sl + pnl).toFixed(4)),
      take_profit_remaining: Number(Math.max(0, tp - pnl).toFixed(4)),
      waiting_ticks: Math.max(0, 30 - ticks.length),
      quote_snapshot: quote
    };
  }

  const risk = await getDemoRiskState(symbol);
  if (risk.blockedByDailyLoss || risk.blockedByLosingStreak) {
    return {
      mode: "demo", opened: false, reason: risk.blockedByDailyLoss ? "daily_loss_limit" : "consecutive_losses_limit",
      risk, quote_snapshot: quote
    };
  }
  if (!analysis || !["BUY", "SELL"].includes(analysis.decision)) {
    return { mode: "demo", opened: false, reason: "NO_TRADE", risk, quote_snapshot: quote };
  }
  if (!freshQuote) {
    return { mode: "demo", opened: false, reason: "stale_quote", quote_snapshot: quote };
  }

  const executionCosts = getDemoExecutionCosts();
  const rawEntryPrice = Number(analysis.decision === "BUY" ? q.ask : q.bid);
  const entry = analysis.decision === "BUY"
    ? rawEntryPrice + executionCosts.slippage_each_side
    : rawEntryPrice - executionCosts.slippage_each_side;
  const entryQuote = {
    ...quote,
    fill_reference_price: rawEntryPrice,
    fill_side: analysis.decision === "BUY" ? "ASK" : "BID"
  };
  const saved = await db("aiva_demo_trades", {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      symbol,
      direction: analysis.decision,
      entry_price: entry,
      quantity: 1,
      analysis_id: analysis.id || null,
      context: {
        confidence: analysis.confidence,
        risk_score: analysis.risk_score,
        simulations: analysis.simulations,
        model: analysis.features?.model || "unknown",
        entry_quote: entryQuote,
        execution_cost_model: executionCosts,
        stop_loss_points: stopLossPoints,
        take_profit_points: takeProfitPoints,
        max_daily_loss_points: maxDailyLossPoints,
        max_consecutive_losses: maxConsecutiveLosses
      }
    })
  });
  console.log("Demo trade opened", JSON.stringify({
    symbol, direction: analysis.decision, entry_price: entry,
    stop_loss_points: stopLossPoints, take_profit_points: takeProfitPoints,
    trade_id: saved?.[0]?.id
  }));
  return {
    mode: "demo", opened: true, direction: analysis.decision,
    entry_price: entry, stop_loss_points: stopLossPoints,
    take_profit_points: takeProfitPoints, trade_id: saved?.[0]?.id || null,
    quote_snapshot: entryQuote, pnl_basis: "bid_ask_plus_slippage_commission"
  };
}
async function getDemoHistory(period, symbol) {
  const now = new Date();
  const days = period === "monthly" ? 370 : period === "weekly" ? 100 : 31;
  const from = new Date(now.getTime() - days * 86400000).toISOString();  const [closed, opened, analyses] = await Promise.all([
    db("aiva_demo_trades?symbol=eq." + encodeURIComponent(symbol) + "&status=eq.CLOSED&opened_at=gte." + encodeURIComponent(from) +
      "&select=direction,entry_price,exit_price,pnl_points,opened_at,closed_at,context&order=closed_at.desc&limit=2000"),
    db("aiva_demo_trades?symbol=eq." + encodeURIComponent(symbol) + "&status=eq.OPEN&select=id,direction,entry_price,opened_at&order=opened_at.desc&limit=100"),
    db("market_analysis_runs?symbol=eq." + encodeURIComponent(symbol) + "&created_at=gte." + encodeURIComponent(from) +
      "&select=decision,created_at&order=created_at.desc&limit=2000")
  ]);
  const buckets = new Map();
  const ensure = key => {
    if (!buckets.has(key)) buckets.set(key, { period: key, decisions: 0, trades: 0, wins: 0, losses: 0, breakeven: 0, pnl_points: 0, cost_adjusted_trades: 0, legacy_cost_basis_trades: 0 });
    return buckets.get(key);
  };
  for (const a of analyses) ensure(periodKey(new Date(a.created_at), period)).decisions++;
  for (const t of closed) {
    const b = ensure(periodKey(new Date(t.closed_at || t.opened_at), period));
    const pnl = Number(t.pnl_points || 0);
    b.trades++; b.pnl_points += pnl;
    if (t.context?.execution_cost_model) b.cost_adjusted_trades++;
    else b.legacy_cost_basis_trades++;
    if (pnl > 0) b.wins++; else if (pnl < 0) b.losses++; else b.breakeven++;
  }
  const rows = [...buckets.values()].sort((a,b) => a.period.localeCompare(b.period)).map(b => ({
    ...b, pnl_points: Number(b.pnl_points.toFixed(4)),
    win_rate: b.trades ? Number((b.wins / b.trades).toFixed(4)) : null
  }));
  const totalTrades = closed.length;
  const totalPnl = closed.reduce((sum,t) => sum + Number(t.pnl_points || 0), 0);
  const chronological = closed.slice().sort((a,b) => new Date(a.closed_at || a.opened_at) - new Date(b.closed_at || b.opened_at));
  const performance = summarizeBacktestTrades(chronological.map(t => ({ pnl_points: Number(t.pnl_points || 0) })));
  const decisionCounts = analyses.reduce((counts, row) => {
    counts[row.decision] = (counts[row.decision] || 0) + 1;
    return counts;
  }, {});
  const costAdjustedTrades = closed.filter(t => Boolean(t.context?.execution_cost_model)).length;
  const legacyCostBasisTrades = totalTrades - costAdjustedTrades;
  return {
    mode: "DEMO", symbol, period, timezone: "Africa/Kinshasa",
    summary: {
      decisions: analyses.length, decision_counts: decisionCounts,
      closed_trades: totalTrades, open_trades: opened.length,
      wins: closed.filter(t => Number(t.pnl_points) > 0).length,
      losses: closed.filter(t => Number(t.pnl_points) < 0).length,
      win_rate: totalTrades ? Number((closed.filter(t => Number(t.pnl_points) > 0).length / totalTrades).toFixed(4)) : null,
      pnl_points: Number(totalPnl.toFixed(4)),
      profit_factor: performance.profit_factor,
      expectancy_points: performance.expectancy_points,
      max_drawdown_points: performance.max_drawdown_points,
      max_consecutive_losses: performance.max_consecutive_losses,
      cost_adjusted_trades: costAdjustedTrades,
      legacy_cost_basis_trades: legacyCostBasisTrades,
      pnl_basis: legacyCostBasisTrades > 0
        ? "mixed_legacy_gross_and_new_net_after_costs"
        : "net_after_bid_ask_slippage_commission"
    },
    open_positions: opened,
    history: rows
  };
}

async function runAutonomousCycle() {
  if (autonomousCycleRunning) return;
  autonomousCycleRunning = true;
  try {
    for (const symbol of symbols) {
      await loadAdaptiveState(symbol);
      const learning = await evaluatePendingAnalyses(symbol);
      // Position protection must keep running even if a fresh analysis cannot be generated.
      let analysis = null;
      let analysisFailure = null;
      try {
        analysis = await getAnalysis(symbol);
      } catch (analysisError) {
        analysisFailure = analysisError instanceof Error ? analysisError.message : String(analysisError);
        console.warn("Analysis skipped; continuing demo risk management", analysisFailure);
      }
      const demo = await manageDemoTrade(symbol, analysis);
      // Every analysis decision, including NO_TRADE and risk/feed blocks, gets an execution outcome.
      if (analysis?.id) {
        const outcome = demo?.closed ? "CLOSED"
          : demo?.opened ? "OPENED"
          : demo?.open ? "POSITION_MONITORED"
          : "NOT_OPENED";
        await db("market_analysis_runs?id=eq." + encodeURIComponent(analysis.id), {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            features: {
              ...(analysis.features || {}),
              execution_audit: {
                recorded_at: new Date().toISOString(),
                decision: analysis.decision,
                outcome,
                reason: demo?.reason || demo?.risk_monitoring || null,
                trade_id: demo?.trade_id || null,
                pnl_points: demo?.pnl_points ?? null,
                pnl_basis: demo?.pnl_basis || null,
                quote_snapshot: demo?.quote_snapshot || null
              }
            }
          })
        });
      }
      await db("aiva_learning_state?on_conflict=symbol", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          symbol,
          confidence_threshold: adaptiveConfidenceThreshold,
          evaluated_directional: learning.reviewedDirectional,
          directional_accuracy: learning.accuracy,
          updated_at: new Date().toISOString(),
          last_cycle_at: new Date().toISOString(),
          last_decision: analysis?.decision || "ANALYSIS_ERROR",
          last_error: analysisFailure
        })
      });
      console.log("Autonomous cycle", JSON.stringify({
        symbol,
        decision: analysis?.decision || "ANALYSIS_ERROR",
        simulations: analysis?.simulations || 0,
        learning,
        demo,
        analysisError: analysisFailure,
        generatedAt: analysis?.generated_at || null
      }));
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    console.error("Autonomous cycle failed", lastError);
  } finally {
    autonomousCycleRunning = false;
  }
}


function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function summarizeBacktestTrades(trades) {
  let equity = 0, peak = 0, maxDrawdown = 0, currentLossStreak = 0, maxLossStreak = 0;
  let grossProfit = 0, grossLoss = 0;
  for (const trade of trades) {
    equity += trade.pnl_points;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (trade.pnl_points > 0) {
      grossProfit += trade.pnl_points;
      currentLossStreak = 0;
    } else if (trade.pnl_points < 0) {      grossLoss += Math.abs(trade.pnl_points);
      currentLossStreak++;
      maxLossStreak = Math.max(maxLossStreak, currentLossStreak);
    } else {
      currentLossStreak = 0;
    }
  }
  const wins = trades.filter(t => t.pnl_points > 0).length;
  const losses = trades.filter(t => t.pnl_points < 0).length;
  const net = trades.reduce((sum, t) => sum + t.pnl_points, 0);
  return {
    trades: trades.length,
    wins,
    losses,
    breakeven: trades.length - wins - losses,
    win_rate: trades.length ? Number((wins / trades.length).toFixed(4)) : null,
    net_pnl_points: Number(net.toFixed(4)),
    gross_profit_points: Number(grossProfit.toFixed(4)),
    gross_loss_points: Number(grossLoss.toFixed(4)),
    profit_factor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(4)) : null,
    expectancy_points: trades.length ? Number((net / trades.length).toFixed(4)) : null,
    max_drawdown_points: Number(maxDrawdown.toFixed(4)),
    max_consecutive_losses: maxLossStreak
  };
}

async function loadBacktestTicks(symbol, maxRows = 10000) {
  // Fetch the newest window first. Ascending pagination used to keep the
  // oldest 10k rows forever once the table grew beyond maxRows.
  const all = [];
  const pageSize = 1000;
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const page = await db("market_quote_ticks?symbol=eq." + encodeURIComponent(symbol) +
      "&select=bid,ask,mid,spread,received_at&order=received_at.desc&limit=" + pageSize + "&offset=" + offset);
    all.push(...page);
    if (page.length < pageSize) break;
  }
  return all
    .filter(t =>
      Number.isFinite(Number(t.bid)) && Number.isFinite(Number(t.ask)) &&
      Number.isFinite(Number(t.mid)) && Number(t.ask) >= Number(t.bid) &&
      Number.isFinite(new Date(t.received_at).getTime())
    )
    .sort((a, b) => new Date(a.received_at).getTime() - new Date(b.received_at).getTime())
    .slice(-maxRows);
}

function runHistoricalBacktest(ticks, confidenceThreshold = 0.65) {
  const stopLoss = Math.max(0.1, Number(process.env.DEMO_STOP_LOSS_POINTS || 5));
  const takeProfit = Math.max(0.1, Number(process.env.DEMO_TAKE_PROFIT_POINTS || 8));
  const horizon = 30, blockLength = 3, signalInterval = 60, trainBoundary = Math.floor(ticks.length * 0.7);
  const maxDailyLoss = Math.max(1, Number(process.env.DEMO_MAX_DAILY_LOSS_POINTS || 15));
  const maxConsecutiveLosses = Math.max(1, Math.floor(Number(process.env.DEMO_MAX_CONSECUTIVE_LOSSES || 3)));
  const trades = [];
  let skippedSignals = 0, riskBlockedSignals = 0, currentDay = null, dailyPnl = 0, dailyLossStreak = 0;
  let i = 300;

  while (i + horizon + 1 < ticks.length) {
    const window = ticks.slice(Math.max(0, i - 299), i + 1);
    const prices = window.map(t => Number(t.mid));
    const returns = [];
    for (let k = 1; k < prices.length; k++) {
      if (prices[k - 1] > 0) returns.push((prices[k] - prices[k - 1]) / prices[k - 1]);
    }
    if (returns.length < 30) { i += signalInterval; continue; }

    const current = Number(ticks[i].mid);
    const spread = Number(ticks[i].ask) - Number(ticks[i].bid);
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance = returns.length > 1
      ? returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1)
      : 0;
    const sigma = Math.sqrt(variance);
    const random = seededRandom((i * 2654435761) >>> 0);
    let up = 0, down = 0, flat = 0, sumMove = 0, adverse = 0;
    for (let s = 0; s < 100; s++) {
      let price = current, pathHigh = current, pathLow = current;
      for (let step = 0; step < horizon;) {
        const startIndex = Math.floor(random() * returns.length);
        for (let j = 0; j < blockLength && step < horizon; j++, step++) {
          price *= 1 + returns[(startIndex + j) % returns.length];
          pathHigh = Math.max(pathHigh, price);
          pathLow = Math.min(pathLow, price);
        }
      }
      const move = price - current;
      const maxAdverse = move >= 0 ? current - pathLow : pathHigh - current;
      sumMove += move;
      if (move > spread) up++;
      else if (move < -spread) down++;
      else flat++;
      if (maxAdverse > Math.max(spread * 8, current * sigma * Math.sqrt(horizon) * 2.5)) adverse++;
    }
    const probabilityUp = up / 100, probabilityDown = down / 100;
    const expectedMove = sumMove / 100;
    const expectedRange = current * sigma * Math.sqrt(horizon);
    const spreadRatio = expectedRange > 0 ? spread / expectedRange : 1;
    const riskScore = Math.min(1, (adverse / 100) * 0.6 + Math.min(1, spreadRatio) * 0.4);
    const momentum = returns.slice(-10).reduce((sum, value) => sum + value, 0);
    let direction = null;
    if (spreadRatio <= 0.5 && riskScore < 0.55 &&
        probabilityUp >= confidenceThreshold && probabilityUp - probabilityDown >= 0.25 &&
        expectedMove > spread * 1.5 && momentum > 0) direction = "BUY";
    else if (spreadRatio <= 0.5 && riskScore < 0.55 &&
        probabilityDown >= confidenceThreshold && probabilityDown - probabilityUp >= 0.25 &&
        expectedMove < -spread * 1.5 && momentum < 0) direction = "SELL";

    if (!direction) { skippedSignals++; i += signalInterval; continue; }

    const signalDay = localDateKey(new Date(ticks[i].received_at));
    if (signalDay !== currentDay) {
      currentDay = signalDay;
      dailyPnl = 0;
      dailyLossStreak = 0;
    }
    if (dailyPnl <= -maxDailyLoss || dailyLossStreak >= maxConsecutiveLosses) {
      riskBlockedSignals++;
      i += signalInterval;
      continue;
    }

    const entryIndex = i + 1;
    const entry = Number(direction === "BUY" ? ticks[entryIndex].ask : ticks[entryIndex].bid);
    let exitIndex = entryIndex + horizon;
    let exitPrice = Number(direction === "BUY" ? ticks[exitIndex].bid : ticks[exitIndex].ask);
    let exitReason = "Horizon de 30 cotations";
    for (let j = entryIndex + 1; j <= entryIndex + horizon; j++) {
      const executable = Number(direction === "BUY" ? ticks[j].bid : ticks[j].ask);
      const pnl = (direction === "BUY" ? 1 : -1) * (executable - entry);
      if (pnl <= -stopLoss) {
        exitIndex = j; exitPrice = executable; exitReason = "Stop-loss"; break;
      }
      if (pnl >= takeProfit) {
        exitIndex = j; exitPrice = executable; exitReason = "Take-profit"; break;
      }
    }
    const pnl = (direction === "BUY" ? 1 : -1) * (exitPrice - entry);
    const roundedPnl = Number(pnl.toFixed(4));
    trades.push({
      direction,
      entry_time: ticks[entryIndex].received_at,
      exit_time: ticks[exitIndex].received_at,
      entry_price: Number(entry.toFixed(4)),
      exit_price: Number(exitPrice.toFixed(4)),
      pnl_points: roundedPnl,
      exit_reason: exitReason,
      sample: entryIndex < trainBoundary ? "in_sample" : "out_of_sample"
    });
    dailyPnl += roundedPnl;
    dailyLossStreak = roundedPnl < 0 ? dailyLossStreak + 1 : 0;
    i = Math.max(i + signalInterval, exitIndex);
  }

  const inSample = trades.filter(t => t.sample === "in_sample");
  const outOfSample = trades.filter(t => t.sample === "out_of_sample");
  const first = ticks[0]?.received_at || null;
  const last = ticks[ticks.length - 1]?.received_at || null;
  return {
    method: "chronological_70_30_holdout_block_bootstrap_monte_carlo",
    model: "block_bootstrap_monte_carlo_v2",
    symbol: "XAUUSD",
    data_points: ticks.length,
    first_tick_at: first,
    last_tick_at: last,
    train_boundary_at: ticks[trainBoundary]?.received_at || null,
    split: "70% chronologique / 30% chronologique",
    assumptions: {
      simulations_per_signal: 100,
      confidence_threshold: confidenceThreshold,
      signal_interval_ticks: signalInterval,
      horizon_ticks: horizon,
      stop_loss_points: stopLoss,
      take_profit_points: takeProfit,
      max_daily_loss_points: maxDailyLoss,
      max_consecutive_losses_per_day: maxConsecutiveLosses,
      entry_exit_use_bid_ask: true,
      spread_included: true,
      commissions: "non incluses",
      slippage: "non inclus",
      random_seed: "déterministe par index de cotation"
    },
    signals_without_entry: skippedSignals,
    signals_blocked_by_risk_limits: riskBlockedSignals,
    overall: summarizeBacktestTrades(trades),
    in_sample: summarizeBacktestTrades(inSample),
    out_of_sample: summarizeBacktestTrades(outOfSample),
    trades: trades.slice(-100)
  };
}

let scheduledBacktestRunning = false;
let scheduledScalpingBacktestRunning = false;
async function runScheduledBacktest(symbol) {
  if (scheduledBacktestRunning) return;
  scheduledBacktestRunning = true;
  try {
    const ticks = await loadBacktestTicks(symbol, 10000);
    if (ticks.length < 500) {
      console.log("Scheduled backtest skipped: insufficient history", JSON.stringify({ symbol, available: ticks.length, required: 500 }));
      return;
    }
    const result = runHistoricalBacktest(ticks, 0.65);
    // Compare thresholds on the same chronological data without changing the live trading threshold.
    const thresholdSensitivity = [0.55, 0.60, 0.65, 0.70, 0.75].map(threshold => {
      const candidate = threshold === 0.65 ? result : runHistoricalBacktest(ticks, threshold);
      return {
        confidence_threshold: threshold,
        overall: candidate.overall,
        out_of_sample: candidate.out_of_sample
      };
    });
    const warnings = [];
    if (ticks.length < 5000) warnings.push("Historique court : résultats exploratoires uniquement.");
    if (thresholdSensitivity.every(item => item.out_of_sample.trades < 10)) {
      warnings.push("Comparaison des seuils non concluante : moins de 10 transactions hors échantillon pour chaque seuil.");
    }
    if (result.overall.trades < 30) warnings.push("Moins de 30 trades : échantillon trop faible pour conclure.");
    if (result.out_of_sample.trades < 10) warnings.push("Moins de 10 trades hors échantillon : validation indépendante insuffisante.");
    const row = {
      symbol,
      method: result.method,
      data_points: result.data_points,
      first_tick_at: result.first_tick_at,
      last_tick_at: result.last_tick_at,
      train_boundary_at: result.train_boundary_at,
      overall: result.overall,
      in_sample: result.in_sample,
      out_of_sample: result.out_of_sample,
      assumptions: { ...result.assumptions, threshold_sensitivity: thresholdSensitivity },
      warnings,
      trade_details: result.trades
    };
    const saved = await db("aiva_backtest_runs", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(row)
    });
    console.log("Scheduled backtest saved", JSON.stringify({
      symbol, data_points: result.data_points, overall: result.overall,
      out_of_sample: result.out_of_sample, warnings, run_id: saved?.[0]?.id
    }));
  } catch (error) {
    console.error("Scheduled backtest failed", error instanceof Error ? error.message : String(error));
  } finally {
    scheduledBacktestRunning = false;
  }
}

async function getScalpingCommonRange(symbol) {
  const ranges = {};
  for (const timeframe of ["M1", "M5"]) {
    const base = "aiva_historical_m1?symbol=eq." + encodeURIComponent(symbol) +
      "&timeframe=eq." + timeframe + "&select=candle_at&limit=1&order=";
    const [first, last] = await Promise.all([
      db(base + "candle_at.asc"),
      db(base + "candle_at.desc")
    ]);
    ranges[timeframe] = { first: first[0]?.candle_at || null, last: last[0]?.candle_at || null };
  }
  if (!ranges.M1.first || !ranges.M1.last || !ranges.M5.first || !ranges.M5.last) return null;
  const start = new Date(Math.max(new Date(ranges.M1.first).getTime(), new Date(ranges.M5.first).getTime())).toISOString();
  const end = new Date(Math.min(new Date(ranges.M1.last).getTime(), new Date(ranges.M5.last).getTime())).toISOString();
  if (new Date(start) >= new Date(end)) return null;
  return { start, end, source_ranges: ranges };
}

async function saveScalpingBacktestResult(symbol, result) {
  if (!result.available) {
    console.log(result.timeframe + " scalping backtest skipped", JSON.stringify(result));
    return null;
  }
  const row = {
    symbol, method: result.method, data_points: result.data_points,
    first_tick_at: result.first_tick_at, last_tick_at: result.last_tick_at,
    train_boundary_at: result.train_boundary_at,
    overall: result.overall, in_sample: result.in_sample,
    out_of_sample: result.out_of_sample,
    assumptions: { ...result.assumptions, filter_experiments: result.filter_experiments || [] },
    warnings: result.warnings, trade_details: result.trades
  };
  const saved = await db("aiva_backtest_runs", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row)
  });
  console.log(result.timeframe + " scalping backtest saved", JSON.stringify({
    symbol, data_points: result.data_points, overall: result.overall,
    out_of_sample: result.out_of_sample, warnings: result.warnings,
    run_id: saved?.[0]?.id
  }));
  return saved?.[0]?.id || null;
}

let scheduledStrategyTournamentRunning = false;
async function runScheduledStrategyTournament(symbol) {
  if (scheduledStrategyTournamentRunning) return;
  scheduledStrategyTournamentRunning = true;
  try {
    const result = await runStrategyTournament(db, symbol, "M5", 80000);
    if (!result.available) {
      console.log("Strategy tournament waiting for history", JSON.stringify(result));
      return;
    }
    for (const item of result.results) {
      const saved = await db("aiva_backtest_runs", {
        method: "POST", headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          symbol, method: item.method, data_points: result.data_points,
          first_tick_at: result.first_tick_at, last_tick_at: result.last_tick_at,
          train_boundary_at: result.train_boundary_at,
          overall: item.overall, in_sample: item.in_sample, out_of_sample: item.out_of_sample,
          assumptions: { ...item.assumptions, config: item.config, experiment_group: "independent_strategy_tournament_v1",
            tournament_method: result.method, configurations_tested: result.configurations_tested },
          warnings: item.warnings, trade_details: item.trades
        })
      });
      console.log("Strategy tournament result saved", JSON.stringify({
        symbol, strategy: item.name, overall: item.overall, out_of_sample: item.out_of_sample,
        by_direction: item.by_direction, run_id: saved?.[0]?.id || null
      }));
    }
    console.log("Strategy tournament completed", JSON.stringify({
      symbol, configurations_tested: result.configurations_tested,
      ranking: result.results.map(x => ({name:x.name,oos:x.out_of_sample}))
    }));
  } catch (error) {
    console.error("Strategy tournament failed", error instanceof Error ? error.message : String(error));
  } finally {
    scheduledStrategyTournamentRunning = false;
  }
}

let scheduledLiquiditySweepRunning = false;
async function runScheduledLiquiditySweep(symbol) {
  if (scheduledLiquiditySweepRunning) return;
  scheduledLiquiditySweepRunning = true;
  try {
    const result = await runLiquiditySweepBacktest(db, symbol, "M5", 80000);
    if (!result.available) {
      console.log("Liquidity sweep research waiting for history", JSON.stringify(result));
      return;
    }
    const saved = await db("aiva_backtest_runs", {
      method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        symbol, method: result.method, data_points: result.data_points,
        first_tick_at: result.first_tick_at, last_tick_at: result.last_tick_at,
        train_boundary_at: result.train_boundary_at, overall: result.overall,
        in_sample: result.in_sample, out_of_sample: result.out_of_sample,
        assumptions: { ...result.assumptions, experiment_group: "liquidity_sweep_research_v1" },
        warnings: result.warnings, trade_details: result.trades
      })
    });
    console.log("Liquidity sweep research saved", JSON.stringify({
      symbol, overall: result.overall, out_of_sample: result.out_of_sample,
      by_direction: result.by_direction, warnings: result.warnings, run_id: saved?.[0]?.id || null
    }));
  } catch (error) {
    console.error("Liquidity sweep research failed", error instanceof Error ? error.message : String(error));
  } finally {
    scheduledLiquiditySweepRunning = false;
  }
}

let scheduledVolatilityReversalRunning = false;
async function runScheduledVolatilityReversal(symbol) {
  if (scheduledVolatilityReversalRunning) return;
  scheduledVolatilityReversalRunning = true;
  const experiments = [
    { name: "baseline_control", overrides: {} },
    { name: "liquid_hours_07_20_utc", overrides: { sessionStartHourUtc: 7, sessionEndHourUtc: 20 } },
    { name: "london_ny_overlap_12_16_utc", overrides: { sessionStartHourUtc: 12, sessionEndHourUtc: 16 } },
    { name: "stronger_confirmation_050", overrides: { minConfirmationBodyRatio: 0.50 } }
  ];
  try {
    for (const experiment of experiments) {
      const result = await runVolatilityReversalBacktest(db, symbol, "M5", 80000, null, experiment.overrides);
      if (!result.available) {
        console.log("Volatility reversal research waiting for history", JSON.stringify({ experiment: experiment.name, ...result }));
        continue;
      }
      const method = result.method + "_" + experiment.name;
      const saved = await db("aiva_backtest_runs", {
        method: "POST", headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          symbol, method, data_points: result.data_points,
          first_tick_at: result.first_tick_at, last_tick_at: result.last_tick_at,
          train_boundary_at: result.train_boundary_at, overall: result.overall,
          in_sample: result.in_sample, out_of_sample: result.out_of_sample,
          assumptions: { ...result.assumptions, experiment: experiment.name, experiment_group: "volatility_reversal_filter_research_v1" },
          warnings: [...result.warnings, "Comparaison exploratoire de filtres ; aucun paramètre n'est activé dans le moteur autonome."],
          trade_details: result.trades
        })
      });
      console.log("Volatility reversal filter experiment saved", JSON.stringify({
        symbol, experiment: experiment.name, overall: result.overall,
        out_of_sample: result.out_of_sample, warnings: result.warnings,
        run_id: saved?.[0]?.id || null
      }));
    }
  } catch (error) {
    console.error("Volatility reversal research failed", error instanceof Error ? error.message : String(error));
  } finally {
    scheduledVolatilityReversalRunning = false;
  }
}

async function runScheduledScalpingBacktest(symbol) {
  if (scheduledScalpingBacktestRunning) return;
  scheduledScalpingBacktestRunning = true;
  try {
    const commonRange = await getScalpingCommonRange(symbol);
    if (!commonRange) {
      console.log("Scalping comparison waiting for overlapping M1/M5 history", symbol);
      return;
    }
    for (const timeframe of ["M1", "M5"]) {
      const maxRows = timeframe === "M1" ? 120000 : 80000;
      const result = await runM1ScalpingBacktest(db, symbol, 0.65, maxRows, timeframe, commonRange);
      await saveScalpingBacktestResult(symbol, result);
    }
    console.log("M1/M5 common comparison period", JSON.stringify(commonRange));
  } catch (error) {
    console.error("Scalping comparison failed", error instanceof Error ? error.message : String(error));
  } finally {
    scheduledScalpingBacktestRunning = false;
  }
}

const server = http.createServer(async (req, res) => {
  const allowedOrigins = (process.env.DASHBOARD_ORIGINS || process.env.DASHBOARD_ORIGIN || "*")
    .split(",").map(origin => origin.trim()).filter(Boolean);
  const requestOrigin = req.headers.origin;
  const corsOrigin = allowedOrigins.includes("*") ? "*" :
    (requestOrigin && allowedOrigins.includes(requestOrigin) ? requestOrigin : "null");
  res.setHeader("access-control-allow-origin", corsOrigin);
  res.setHeader("vary", "Origin");
  if (req.method === "OPTIONS") return send(res, 204, {});
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/" || url.pathname === "/health") {
      return send(res, 200, {
        service: "aiva-market-feed",
        status: "alive",
        connected,
        symbols,
        lastQuoteAt,
        received,
        lastError
      });
    }
    if (url.pathname === "/ready") {
      return send(res, connected ? 200 : 503, {
        service: "aiva-market-feed",
        status: connected ? "ready" : "waiting_for_market_feed",
        connected,
        lastQuoteAt,
        lastError
      });
    }    if (url.pathname === "/api/volatility-reversal-backtest") {
      const symbol = (url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
      const timeframe = (url.searchParams.get("timeframe") || "M5").toUpperCase();
      if (!symbols.includes(symbol)) return send(res, 400, { error: "unsupported_symbol" });
      if (!["M1", "M5"].includes(timeframe)) return send(res, 400, { error: "invalid_timeframe" });
      const authHeader = String(req.headers.authorization || "");
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (!(await verifyUserToken(bearer))) return send(res, 401, { error: "authentication_required" });
      const clientIp = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
      const rateKey = "volatility-reversal:" + clientIp;
      const previousRequest = analysisRateLimit.get(rateKey) || 0;
      const elapsed = Date.now() - previousRequest;
      if (elapsed < 900000) return send(res, 429, { error: "strategy_test_rate_limited", retry_after_ms: 900000 - elapsed });
      analysisRateLimit.set(rateKey, Date.now());
      const result = await runVolatilityReversalBacktest(db, symbol, timeframe, timeframe === "M1" ? 120000 : 80000);
      if (!result.available) return send(res, 422, result);
      const saved = await db("aiva_backtest_runs", {
        method: "POST", headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          symbol, method: result.method, data_points: result.data_points,
          first_tick_at: result.first_tick_at, last_tick_at: result.last_tick_at,
          train_boundary_at: result.train_boundary_at, overall: result.overall,
          in_sample: result.in_sample, out_of_sample: result.out_of_sample,
          assumptions: result.assumptions, warnings: result.warnings, trade_details: result.trades
        })
      });
      return send(res, 200, { ...result, run_id: saved?.[0]?.id || null });
    }
    if (url.pathname === "/api/strategy-tournament") {
      const symbol = (url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
      if (!symbols.includes(symbol)) return send(res, 400, { error: "unsupported_symbol" });
      const timeframe = (url.searchParams.get("timeframe") || "M5").toUpperCase();
      if (timeframe !== "M5") return send(res, 400, { error: "research_timeframe_must_be_M5" });
      const authHeader = String(req.headers.authorization || "");
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (!(await verifyUserToken(bearer))) return send(res, 401, { error: "authentication_required" });
      const clientIp = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
      const rateKey = "strategy-tournament:" + clientIp;
      const previousRequest = analysisRateLimit.get(rateKey) || 0;
      const elapsed = Date.now() - previousRequest;
      if (elapsed < 900000) return send(res, 429, { error: "strategy_test_rate_limited", retry_after_ms: 900000 - elapsed });
      analysisRateLimit.set(rateKey, Date.now());
      const result = await runStrategyTournament(db, symbol, timeframe, 80000);
      if (!result.available) return send(res, 422, result);
      for (const item of result.results) {
        const saved = await db("aiva_backtest_runs", {
          method: "POST", headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            symbol, method: item.method, data_points: result.data_points,
            first_tick_at: result.first_tick_at, last_tick_at: result.last_tick_at,
            train_boundary_at: result.train_boundary_at,
            overall: item.overall, in_sample: item.in_sample, out_of_sample: item.out_of_sample,
            assumptions: { ...item.assumptions, config: item.config, experiment_group: "independent_strategy_tournament_v1",
              tournament_method: result.method, configurations_tested: result.configurations_tested },
            warnings: item.warnings, trade_details: item.trades
          })
        });
        item.run_id = saved?.[0]?.id || null;
      }
      return send(res, 200, result);
    }
    if (url.pathname === "/api/liquidity-sweep-backtest") {
      const symbol = (url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
      if (!symbols.includes(symbol)) return send(res, 400, { error: "unsupported_symbol" });
      const timeframe = (url.searchParams.get("timeframe") || "M5").toUpperCase();
      if (timeframe !== "M5") return send(res, 400, { error: "research_timeframe_must_be_M5" });
      const authHeader = String(req.headers.authorization || "");
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (!(await verifyUserToken(bearer))) return send(res, 401, { error: "authentication_required" });
      const clientIp = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
      const rateKey = "liquidity-sweep:" + clientIp;
      const previousRequest = analysisRateLimit.get(rateKey) || 0;
      const elapsed = Date.now() - previousRequest;
      if (elapsed < 900000) return send(res, 429, { error: "strategy_test_rate_limited", retry_after_ms: 900000 - elapsed });
      analysisRateLimit.set(rateKey, Date.now());
      const result = await runLiquiditySweepBacktest(db, symbol, timeframe, 80000);
      if (!result.available) return send(res, 422, result);
      const saved = await db("aiva_backtest_runs", {
        method: "POST", headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          symbol, method: result.method, data_points: result.data_points,
          first_tick_at: result.first_tick_at, last_tick_at: result.last_tick_at,
          train_boundary_at: result.train_boundary_at, overall: result.overall,
          in_sample: result.in_sample, out_of_sample: result.out_of_sample,
          assumptions: result.assumptions, warnings: result.warnings, trade_details: result.trades
        })
      });
      return send(res, 200, { ...result, run_id: saved?.[0]?.id || null });
    }
    if (url.pathname === "/api/scalping-history-status") {
      const symbol = (url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
      if (!symbols.includes(symbol)) return send(res, 400, { error: "unsupported_symbol" });
      const [earliest, latest] = await Promise.all([
        db("aiva_historical_m1?symbol=eq." + encodeURIComponent(symbol) +
          "&timeframe=eq.M1&select=candle_at&order=candle_at.asc&limit=1"),
        db("aiva_historical_m1?symbol=eq." + encodeURIComponent(symbol) +
          "&timeframe=eq.M1&select=candle_at,bid_close,ask_close,spread_close&order=candle_at.desc&limit=1")
      ]);
      return send(res, 200, {
        symbol,
        timeframe: "M1",
        source: "Dukascopy historical Bid/Ask candles",
        first_candle_at: earliest[0]?.candle_at || null,
        last_candle: latest[0] || null,
        backfill_running: historicalM1ImportRunning,
        last_import: historicalM1LastRun,
        note: "Historique séparé du flux Live-Rates. Pas encore utilisé pour les décisions de trading."
      });
    }
    if (url.pathname === "/api/historical-validation") {
      const symbol = (url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
      if (!symbols.includes(symbol)) return send(res, 400, { error: "unsupported_symbol" });
      return send(res, 200, await runHistoricalDailyValidation(symbol));
    }
    if (url.pathname === "/api/historical-status") {
      const symbol = (url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
      if (!symbols.includes(symbol)) return send(res, 400, { error: "unsupported_symbol" });
      const [latest, earliest, context] = await Promise.all([
        db("aiva_historical_daily?symbol=eq." + encodeURIComponent(symbol) + "&select=session_date,close&order=session_date.desc&limit=1"),
        db("aiva_historical_daily?symbol=eq." + encodeURIComponent(symbol) + "&select=session_date&order=session_date.asc&limit=1"),
        getHistoricalContext(symbol)
      ]);
      return send(res, 200, {
        symbol, source: "Live-Rates historical daily close",
        first_date: earliest[0]?.session_date || null,
        last_date: latest[0]?.session_date || null,
        latest_close: latest[0] ? Number(latest[0].close) : null,
        context, backfill_running: historicalImportRunning
      });
    }
    if (url.pathname === "/api/autonomous-status") {
      const symbol = (url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
      if (!symbols.includes(symbol)) return send(res, 400, { error: "unsupported_symbol" });
      const [rows, recentAnalyses] = await Promise.all([
        db("aiva_learning_state?symbol=eq." + encodeURIComponent(symbol) +
          "&select=symbol,confidence_threshold,evaluated_directional,directional_accuracy,updated_at,last_cycle_at,last_decision&limit=1"),
        db("market_analysis_runs?symbol=eq." + encodeURIComponent(symbol) +
          "&select=id,decision,confidence,probability_up,probability_down,expected_move,risk_score,rationale,features,created_at&order=created_at.desc&limit=30")
      ]);
      const latestAnalysis = recentAnalyses[0] || null;
      const blockerCounts = {};
      for (const run of recentAnalyses.filter(item => item.decision === "NO_TRADE")) {
        for (const reason of run.features?.decision_diagnostics?.blocking_reasons || []) {
          blockerCounts[reason] = (blockerCounts[reason] || 0) + 1;
        }
      }
      const state = rows[0] || {
        symbol,
        confidence_threshold: adaptiveConfidenceThreshold,
        evaluated_directional: 0,
        directional_accuracy: null,
        last_cycle_at: null,
        last_decision: null
      };
      return send(res, 200, {
        ...state,
        latest_analysis: latestAnalysis ? {
          id: latestAnalysis.id,
          decision: latestAnalysis.decision,
          confidence: latestAnalysis.confidence,
          probability_up: latestAnalysis.probability_up,
          probability_down: latestAnalysis.probability_down,
          expected_move: latestAnalysis.expected_move,          risk_score: latestAnalysis.risk_score,
          rationale: latestAnalysis.rationale,
          diagnostics: latestAnalysis.features?.decision_diagnostics || null,
          created_at: latestAnalysis.created_at
        } : null,
        recent_no_trade_count: recentAnalyses.filter(item => item.decision === "NO_TRADE").length,
        recent_analysis_count: recentAnalyses.length,
        blocker_counts: blockerCounts
      });
    }
    if (url.pathname === "/api/demo-history") {
      const symbol = (url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
      const period = (url.searchParams.get("period") || "daily").toLowerCase();
      if (!symbols.includes(symbol)) return send(res, 400, { error: "unsupported_symbol" });
      if (!["daily", "weekly", "monthly"].includes(period)) return send(res, 400, { error: "invalid_period" });
      return send(res, 200, await getDemoHistory(period, symbol));
    }
    if (url.pathname === "/api/demo-status") {
      const symbol = (url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
      if (!symbols.includes(symbol)) return send(res, 400, { error: "unsupported_symbol" });
      const rows = await db("aiva_demo_trades?symbol=eq." + encodeURIComponent(symbol) + "&status=eq.OPEN&select=id,direction,entry_price,opened_at,quantity&order=opened_at.desc");
      return send(res, 200, { mode: "DEMO", enabled: String(process.env.DEMO_TRADING_ENABLED || "true").toLowerCase() === "true", open_positions: rows });
    }
    if (url.pathname === "/api/quote") {
      const symbol = (url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
      if (!symbols.includes(symbol)) return send(res, 400, { error: "unsupported_symbol" });
      const rows = await db("market_quotes?symbol=eq." + encodeURIComponent(symbol) + "&select=symbol,bid,ask,mid,spread,provider_timestamp,received_at,source,connection_status,latency_ms&limit=1");
      return send(res, 200, rows[0] || { error: "quote_not_found" });
    }
    if (url.pathname === "/api/scalping-backtest") {
      const symbol = (url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
      if (!symbols.includes(symbol)) return send(res, 400, { error: "unsupported_symbol" });
      const authHeader = String(req.headers.authorization || "");
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (!(await verifyUserToken(bearer))) return send(res, 401, { error: "authentication_required" });
      const clientIp = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
      const rateKey = "scalping-backtest:" + clientIp;
      const previousRequest = analysisRateLimit.get(rateKey) || 0;
      const elapsed = Date.now() - previousRequest;
      if (elapsed < 60000) return send(res, 429, { error: "backtest_rate_limited", retry_after_ms: 60000 - elapsed });
      analysisRateLimit.set(rateKey, Date.now());
      const result = await runM1ScalpingBacktest(db, symbol, 0.65, 120000);
      if (!result.available) return send(res, 422, result);
      const row = {
        symbol, method: result.method, data_points: result.data_points,
        first_tick_at: result.first_tick_at, last_tick_at: result.last_tick_at,
        train_boundary_at: result.train_boundary_at,
        overall: result.overall, in_sample: result.in_sample, out_of_sample: result.out_of_sample,
        assumptions: result.assumptions, warnings: result.warnings, trade_details: result.trades
      };
      const saved = await db("aiva_backtest_runs", {
        method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row)
      });
      return send(res, 200, { ...result, run_id: saved?.[0]?.id || null });
    }
    if (url.pathname === "/api/scalping-history-status") {
      const symbol = (url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
      if (!symbols.includes(symbol)) return send(res, 400, { error: "unsupported_symbol" });
      const [m1, m5] = await Promise.all([
        db("aiva_historical_m1?symbol=eq." + encodeURIComponent(symbol) + "&timeframe=eq.M1&select=candle_at&order=candle_at.asc&limit=1"),
        db("aiva_historical_m1?symbol=eq." + encodeURIComponent(symbol) + "&timeframe=eq.M5&select=candle_at&order=candle_at.asc&limit=1")
      ]);
      const [m1Last, m5Last, m1Count, m5Count] = await Promise.all([
        db("aiva_historical_m1?symbol=eq." + encodeURIComponent(symbol) + "&timeframe=eq.M1&select=candle_at&order=candle_at.desc&limit=1"),
        db("aiva_historical_m1?symbol=eq." + encodeURIComponent(symbol) + "&timeframe=eq.M5&select=candle_at&order=candle_at.desc&limit=1"),
        db("aiva_historical_m1?symbol=eq." + encodeURIComponent(symbol) + "&timeframe=eq.M1&select=candle_at&limit=1&count=exact"),
        db("aiva_historical_m1?symbol=eq." + encodeURIComponent(symbol) + "&timeframe=eq.M5&select=candle_at&limit=1&count=exact")
      ]);
      return send(res, 200, {
        symbol,
        M1: { first: m1[0]?.candle_at || null, last: m1Last[0]?.candle_at || null, importing: historicalM1ImportRunning, last_import: historicalM1LastRun },
        M5: { first: m5[0]?.candle_at || null, last: m5Last[0]?.candle_at || null, importing: historicalM5ImportRunning, last_import: historicalM5LastRun }
      });
    }
    if (url.pathname === "/api/scalping-comparison") {
      const symbol = (url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
      if (!symbols.includes(symbol)) return send(res, 400, { error: "unsupported_symbol" });
      const authHeader = String(req.headers.authorization || "");
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (!(await verifyUserToken(bearer))) return send(res, 401, { error: "authentication_required" });
      const clientIp = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
      const rateKey = "scalping-comparison:" + clientIp;
      const previousRequest = analysisRateLimit.get(rateKey) || 0;
      const elapsed = Date.now() - previousRequest;
      if (elapsed < 60000) return send(res, 429, { error: "backtest_rate_limited", retry_after_ms: 60000 - elapsed });
      analysisRateLimit.set(rateKey, Date.now());

      const commonRange = await getScalpingCommonRange(symbol);
      if (!commonRange) return send(res, 422, { error: "insufficient_overlapping_history", message: "Il faut des historiques M1 et M5 qui se chevauchent." });
      const results = {};
      for (const timeframe of ["M1", "M5"]) {
        const maxRows = timeframe === "M1" ? 120000 : 80000;
        results[timeframe] = await runM1ScalpingBacktest(db, symbol, 0.65, maxRows, timeframe, commonRange);
        if (results[timeframe].available) {
          results[timeframe].run_id = await saveScalpingBacktestResult(symbol, results[timeframe]);
        }
      }
      const comparable = results.M1.available && results.M5.available;
      return send(res, 200, {
        symbol, comparison_valid: comparable, comparison_period: commonRange,
        comparison_note: comparable
          ? "Les deux backtests utilisent la même fenêtre calendaire. Les horizons et la granularité diffèrent : M1 et M5 restent des stratégies distinctes."
          : "Au moins un historique est insuffisant ; ne pas comparer les performances directement.",
        results
      });
    }
    if (url.pathname === "/api/scalping-robustness") {
      const symbol = (url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
      if (!symbols.includes(symbol)) return send(res, 400, { error: "unsupported_symbol" });
      const authHeader = String(req.headers.authorization || "");
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (!(await verifyUserToken(bearer))) return send(res, 401, { error: "authentication_required" });
      const clientIp = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
      const rateKey = "scalping-robustness:" + clientIp;
      const previousRequest = analysisRateLimit.get(rateKey) || 0;
      const elapsed = Date.now() - previousRequest;
      if (elapsed < 900000) return send(res, 429, { error: "robustness_rate_limited", retry_after_ms: 900000 - elapsed });
      analysisRateLimit.set(rateKey, Date.now());

      const commonRange = await getScalpingCommonRange(symbol);
      if (!commonRange) return send(res, 422, { error: "insufficient_overlapping_history" });
      const startMs = new Date(commonRange.start).getTime();
      const endMs = new Date(commonRange.end).getTime();
      const span = endMs - startMs;
      const windows = [
        { name: "window_1_oldest", start: new Date(startMs).toISOString(), end: new Date(startMs + Math.floor(span / 3)).toISOString() },
        { name: "window_2_middle", start: new Date(startMs + Math.floor(span / 3)).toISOString(), end: new Date(startMs + Math.floor(2 * span / 3)).toISOString() },
        { name: "window_3_latest", start: new Date(startMs + Math.floor(2 * span / 3)).toISOString(), end: commonRange.end }
      ];
      const configurations = [
        { stopLoss: 3, takeProfit: 6 },
        { stopLoss: 5, takeProfit: 8 },
        { stopLoss: 7, takeProfit: 10 }
      ];
      const results = [];
      for (const window of windows) {
        for (const config of configurations) {
          const result = await runM1ScalpingBacktest(
            db, symbol, 0.65, 80000, "M5",
            { start: window.start, end: window.end },
            config
          );
          if (result.available) {
            result.experiment = { window: window.name, ...config, confidence_threshold: 0.65 };
            result.run_id = await saveScalpingBacktestResult(symbol, result);
          }
          results.push({
            window: window.name,
            period_start: window.start,
            period_end: window.end,
            stop_loss: config.stopLoss,
            take_profit: config.takeProfit,
            available: Boolean(result.available),
            data_points: result.data_points,
            overall: result.overall || null,
            in_sample: result.in_sample || null,
            out_of_sample: result.out_of_sample || null,
            warnings: result.warnings || [result.warning],
            run_id: result.run_id || null
          });
        }
      }
      return send(res, 200, {
        symbol,
        timeframe: "M5",
        confidence_threshold: 0.65,
        method: "three chronological windows; fixed 70/30 split inside each window",
        windows,
        configurations,
        results,
        interpretation: "Exploratory parameter sensitivity only. These windows are not independent if market regimes overlap conceptually; no parameter is promoted automatically."
      });
    }
    if (url.pathname === "/api/inverse-keltner-backtest") {
      const symbol = (url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
      if (!symbols.includes(symbol)) return send(res, 400, { error: "unsupported_symbol" });
      const authHeader = String(req.headers.authorization || "");
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (!(await verifyUserToken(bearer))) return send(res, 401, { error: "authentication_required" });
      const clientIp = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
      const rateKey = "inverse-keltner-backtest:" + clientIp;
      const previousRequest = analysisRateLimit.get(rateKey) || 0;
      const elapsed = Date.now() - previousRequest;
      if (elapsed < 900000) return send(res, 429, { error: "backtest_rate_limited", retry_after_ms: 900000 - elapsed });
      analysisRateLimit.set(rateKey, Date.now());
      const result = await runInverseKeltnerBacktest(db, symbol, 80000);
      if (!result.available) return send(res, 422, result);
      const saved = await db("aiva_backtest_runs", {
        method: "POST", headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          symbol, method: "aiva_inverse_keltner_1_5_atr_v1",
          data_points: result.data_points, first_tick_at: result.first_candle_at,
          last_tick_at: result.last_candle_at, train_boundary_at: result.trades.find(t => t.sample === "out_of_sample")?.signal_time || null,
          overall: result.overall, in_sample: result.in_sample, out_of_sample: result.out_of_sample,
          assumptions: { ...result.assumptions, experiment_group: "inverse_keltner_demo_research_v1",
            strategy: result.strategy, by_direction: result.by_direction },
          warnings: result.warnings, trade_details: result.trades
        })
      });
      result.run_id = saved?.[0]?.id || null;
      return send(res, 200, result);
    }
    if (url.pathname === "/api/inverse-keltner-demo-status") {
      const symbol = (url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
      if (!symbols.includes(symbol)) return send(res, 400, { error: "unsupported_symbol" });
      const authHeader = String(req.headers.authorization || "");
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (!(await verifyUserToken(bearer))) return send(res, 401, { error: "authentication_required" });
      const result = await getInverseKeltnerDemoStatus(db, symbol);
      return send(res, 200, result);
    }
    if (url.pathname === "/api/backtest-history") {
      const authHeader = String(req.headers.authorization || "");
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (!(await verifyUserToken(bearer))) return send(res, 401, { error: "authentication_required" });
      const symbol = (url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
      if (!symbols.includes(symbol)) return send(res, 400, { error: "unsupported_symbol" });
      const rows = await db("aiva_backtest_runs?symbol=eq." + encodeURIComponent(symbol) +
        "&select=id,symbol,method,data_points,first_tick_at,last_tick_at,train_boundary_at,overall,in_sample,out_of_sample,assumptions,warnings,trade_details,created_at&order=created_at.desc&limit=20");
      return send(res, 200, { symbol, runs: rows });
    }
    if (url.pathname === "/api/backtest") {
      const symbol = (url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
      if (!symbols.includes(symbol)) return send(res, 400, { error: "unsupported_symbol" });
      const authHeader = String(req.headers.authorization || "");
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (!(await verifyUserToken(bearer))) return send(res, 401, { error: "authentication_required" });
      const clientIp = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
      const rateKey = "backtest:" + clientIp;
      const previousRequest = analysisRateLimit.get(rateKey) || 0;
      const elapsed = Date.now() - previousRequest;
      if (elapsed < 60000) return send(res, 429, { error: "backtest_rate_limited", retry_after_ms: 60000 - elapsed });
      analysisRateLimit.set(rateKey, Date.now());
      const ticks = await loadBacktestTicks(symbol, 10000);
      if (ticks.length < 500) {
        return send(res, 422, {
          error: "insufficient_history",
          required_ticks: 500,
          available_ticks: ticks.length,
          message: "Il faut au moins 500 cotations pour lancer ce backtest exploratoire."
        });
      }
      const result = runHistoricalBacktest(ticks);
      result.symbol = symbol;
      result.warning = ticks.length < 5000
        ? "Historique encore court : résultats exploratoires, pas une validation statistique."
        : "Backtest historique indicatif : vérifier sur une période indépendante plus longue.";
      return send(res, 200, result);
    }
    if (url.pathname === "/api/analysis") {
      const symbol = (url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
      if (!symbols.includes(symbol)) return send(res, 400, { error: "unsupported_symbol" });
      const authHeader = String(req.headers.authorization || "");
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (!(await verifyUserToken(bearer))) return send(res, 401, { error: "authentication_required" });
      const clientIp = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
      const now = Date.now();
      const previousRequest = analysisRateLimit.get(clientIp) || 0;
      const elapsed = now - previousRequest;
      if (elapsed < 15000) return send(res, 429, { error: "rate_limited", retry_after_ms: 15000 - elapsed });
      analysisRateLimit.set(clientIp, now);
      if (analysisRateLimit.size > 2000) {
        for (const [ip, timestamp] of analysisRateLimit) if (now - timestamp > 60000) analysisRateLimit.delete(ip);
      }
      const result = await getAnalysis(symbol);
      return send(res, 200, result);
    }
    return send(res, 404, { error: "not_found" });
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    console.error("HTTP/API error", lastError);
    return send(res, 500, { error: "internal_error", message: lastError });
  }
});
server.listen(Number(process.env.PORT || 3000), "0.0.0.0", () => {
  console.log("HTTP server listening", JSON.stringify(server.address()));
  console.log("Health and API endpoints ready");
});

function parse(raw) {
  if (typeof raw === "string") { try { return JSON.parse(raw); } catch { return null; } }
  return raw && typeof raw === "object" ? raw : null;
}
function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
}
async function saveQuote(q) {
  const symbol = String(q.currency || q.symbol || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (!symbols.includes(symbol)) return;
  const bid = num(q.bid), ask = num(q.ask);
  if (!bid || !ask || bid <= 0 || ask < bid) { console.warn("Rejected invalid quote", symbol); return; }
  const rawTs = num(q.timestamp);
  const providerDate = rawTs ? new Date(rawTs < 1e12 ? rawTs * 1000 : rawTs) : null;
  if (providerDate && Number.isNaN(providerDate.getTime())) return;
  const now = Date.now();
  const row = {
    symbol, bid, ask, mid: (bid + ask) / 2, spread: ask - bid,
    provider_timestamp: providerDate?.toISOString() ?? null,
    received_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
    source: "live-rates", connection_status: "connected",
    latency_ms: providerDate ? Math.max(0, now - providerDate.getTime()) : null
  };
  await db("market_quotes?on_conflict=symbol", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(row)
  });
  await db("market_quote_ticks", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ symbol, bid, ask, mid: row.mid, spread: row.spread, provider_timestamp: row.provider_timestamp, received_at: row.received_at, source: "live-rates" })
  });
  received++; lastQuoteAt = row.received_at; lastError = null;
  if (received === 1 || received % 20 === 0) console.log("Quote stored", symbol, "bid", bid, "ask", ask, "latency", row.latency_ms);
}

const socket = io("https://" + host, { autoConnect: false, transports: ["websocket"], reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 30000, timeout: 20000 });
socket.on("connect", () => {
  connected = true; lastError = null;
  console.log("Socket connected", host, "symbols", symbols.join(","));
  socket.emit("instruments", symbols.join(","));
  socket.emit("key", process.env.LIVE_RATES_API_KEY);
});
socket.on("disconnect", reason => { connected = false; console.warn("Socket disconnected", reason); });
socket.on("connect_error", error => { connected = false; lastError = error.message; console.error("Socket error", error.message); });
socket.on("rates", async raw => {
  const data = parse(raw);
  if (!data) { lastError = "Invalid provider payload"; return; }
  if (data.error) { lastError = String(data.error); console.error("Provider error", lastError); return; }
  if (data.info) { console.log("Provider info", data.info); return; }
  try { await saveQuote(data); }
  catch (error) { lastError = error instanceof Error ? error.message : String(error); console.error(lastError); }
});
function stop(signal) {
  console.log("Stopping on", signal); connected = false; socket.disconnect();
  server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

const feedConnectDelayMs = Math.max(5000, Math.min(30000, Number(process.env.LIVE_RATES_CONNECT_DELAY_MS || 15000)));
setTimeout(() => {
  console.log("Starting Live-Rates connection after deployment grace period", feedConnectDelayMs, "ms");
  socket.connect();
}, feedConnectDelayMs).unref();

const autonomousIntervalMs = Math.max(30000, Math.min(300000, Number(process.env.AUTO_ANALYSIS_INTERVAL_MS || 60000)));
setTimeout(() => { runAutonomousCycle(); }, 20000);
setInterval(runAutonomousCycle, autonomousIntervalMs);
console.log("Autonomous analysis scheduler enabled", autonomousIntervalMs, "ms");
const backtestIntervalMs = Math.max(3600000, Number(process.env.BACKTEST_INTERVAL_MS || 21600000));
setTimeout(() => { for (const symbol of symbols) runScheduledBacktest(symbol); }, 90000).unref();
setInterval(() => { for (const symbol of symbols) runScheduledBacktest(symbol); }, backtestIntervalMs);
console.log("Scheduled historical backtest enabled", backtestIntervalMs, "ms");
const historicalImportIntervalMs = 24 * 60 * 60 * 1000;
setTimeout(() => { for (const symbol of symbols) importHistoricalDaily(symbol); }, 45000).unref();
setInterval(() => { for (const symbol of symbols) importHistoricalDaily(symbol); }, historicalImportIntervalMs);
console.log("Historical daily import scheduler enabled", historicalImportIntervalMs, "ms");
const historicalM1ImportIntervalMs = Math.max(60000, Number(process.env.DUKASCOPY_M1_IMPORT_INTERVAL_MS || 60000));
setTimeout(() => { for (const symbol of symbols) runHistoricalM1Import(symbol); }, 60000).unref();
setInterval(() => { for (const symbol of symbols) runHistoricalM1Import(symbol); }, historicalM1ImportIntervalMs);
console.log("Dukascopy M1 history importer enabled", historicalM1ImportIntervalMs, "ms");
const historicalM5ImportIntervalMs = Math.max(60000, Number(process.env.DUKASCOPY_M5_IMPORT_INTERVAL_MS || 120000));
setTimeout(() => { for (const symbol of symbols) runHistoricalM5Import(symbol); }, 90000).unref();
setInterval(() => { for (const symbol of symbols) runHistoricalM5Import(symbol); }, historicalM5ImportIntervalMs);
console.log("Dukascopy M5 history importer enabled", historicalM5ImportIntervalMs, "ms");
const scalpingBacktestIntervalMs = Math.max(30 * 60 * 1000, Number(process.env.SCALPING_BACKTEST_INTERVAL_MS || 21600000));
setTimeout(() => { for (const symbol of symbols) runScheduledScalpingBacktest(symbol); }, 90 * 1000).unref();
setInterval(() => { for (const symbol of symbols) runScheduledScalpingBacktest(symbol); }, scalpingBacktestIntervalMs);
console.log("M1/M5 scalping comparison scheduler enabled", scalpingBacktestIntervalMs, "ms");
const volatilityReversalIntervalMs = Math.max(60 * 60 * 1000, Number(process.env.VOLATILITY_REVERSAL_INTERVAL_MS || 21600000));
setTimeout(() => { for (const symbol of symbols) runScheduledVolatilityReversal(symbol); }, 15000).unref();
setInterval(() => { for (const symbol of symbols) runScheduledVolatilityReversal(symbol); }, volatilityReversalIntervalMs);
console.log("Experimental volatility reversal research scheduler enabled", volatilityReversalIntervalMs, "ms");
let inverseKeltnerBacktestRunning = false;
async function runScheduledInverseKeltnerBacktest(symbol) {
  if (inverseKeltnerBacktestRunning) return;
  inverseKeltnerBacktestRunning = true;
  try {
    const result = await runInverseKeltnerBacktest(db, symbol, 80000);
    if (!result.available) {
      console.log("Inverse Keltner backtest waiting for history", JSON.stringify(result));
      return;
    }
    const saved = await db("aiva_backtest_runs", {
      method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        symbol, method: "aiva_inverse_keltner_1_5_atr_v1",
        data_points: result.data_points, first_tick_at: result.first_candle_at,
        last_tick_at: result.last_candle_at,
        train_boundary_at: result.trades.find(t => t.sample === "out_of_sample")?.signal_time || null,
        overall: result.overall, in_sample: result.in_sample, out_of_sample: result.out_of_sample,
        assumptions: { ...result.assumptions, experiment_group: "inverse_keltner_demo_research_v1",
          strategy: result.strategy, by_direction: result.by_direction },
        warnings: result.warnings, trade_details: result.trades
      })
    });
    console.log("Inverse Keltner backtest saved", JSON.stringify({
      symbol, overall: result.overall, out_of_sample: result.out_of_sample,
      by_direction: result.by_direction, run_id: saved?.[0]?.id || null
    }));
  } catch (error) {
    console.error("Inverse Keltner backtest failed", error instanceof Error ? error.message : String(error));
  } finally {
    inverseKeltnerBacktestRunning = false;
  }
}

let inverseKeltnerDemoRunning = false;
async function runScheduledInverseKeltnerDemo(symbol) {
  if (inverseKeltnerDemoRunning) return;
  inverseKeltnerDemoRunning = true;
  try {
    const result = await runInverseKeltnerDemoCycle(db, symbol);
    console.log("Inverse Keltner paper demo cycle", JSON.stringify({symbol,...result}));
  } catch (error) {
    console.error("Inverse Keltner paper demo error", error instanceof Error ? error.message : String(error));
  } finally {
    inverseKeltnerDemoRunning = false;
  }
}
const strategyTournamentIntervalMs = Math.max(60 * 60 * 1000, Number(process.env.STRATEGY_TOURNAMENT_INTERVAL_MS || 21600000));
setTimeout(() => { for (const symbol of symbols) runScheduledStrategyTournament(symbol); }, 120000).unref();
setInterval(() => { for (const symbol of symbols) runScheduledStrategyTournament(symbol); }, strategyTournamentIntervalMs);
console.log("Independent strategy tournament scheduler enabled", strategyTournamentIntervalMs, "ms");
const inverseKeltnerDemoIntervalMs = Math.max(15000, Number(process.env.INVERSE_KELTNER_DEMO_INTERVAL_MS || 30000));
setTimeout(() => { for (const symbol of symbols) runScheduledInverseKeltnerDemo(symbol); }, 60000).unref();
setInterval(() => { for (const symbol of symbols) runScheduledInverseKeltnerDemo(symbol); }, inverseKeltnerDemoIntervalMs);
console.log("Inverse Keltner paper demo scheduler enabled", inverseKeltnerDemoIntervalMs, "ms; real orders disabled");
const inverseKeltnerBacktestIntervalMs = Math.max(60 * 60 * 1000, Number(process.env.INVERSE_KELTNER_BACKTEST_INTERVAL_MS || 21600000));
setTimeout(() => { for (const symbol of symbols) runScheduledInverseKeltnerBacktest(symbol); }, 180000).unref();
setInterval(() => { for (const symbol of symbols) runScheduledInverseKeltnerBacktest(symbol); }, inverseKeltnerBacktestIntervalMs);
console.log("Inverse Keltner research backtest scheduler enabled", inverseKeltnerBacktestIntervalMs, "ms");
const liquiditySweepIntervalMs = Math.max(60 * 60 * 1000, Number(process.env.LIQUIDITY_SWEEP_INTERVAL_MS || 21600000));
setTimeout(() => { for (const symbol of symbols) runScheduledLiquiditySweep(symbol); }, 45000).unref();
setInterval(() => { for (const symbol of symbols) runScheduledLiquiditySweep(symbol); }, liquiditySweepIntervalMs);
console.log("Experimental liquidity sweep research scheduler enabled", liquiditySweepIntervalMs, "ms");