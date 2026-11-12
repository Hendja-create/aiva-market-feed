import http from "node:http";
import { io } from "socket.io-client";

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
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization"
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
  const simulations = [];
  let up = 0, down = 0, flat = 0, sumMove = 0, adverse = 0;
  if (returns.length >= 2) {
    for (let s = 0; s < 100; s++) {
      let price = current;
      for (let step = 0; step < horizon; step++) {
        const sampled = returns[Math.floor(Math.random() * returns.length)];
        price *= 1 + sampled;
      }
      const move = price - current;
      sumMove += move;
      if (move > spread) up++;
      else if (move < -spread) down++;
      else flat++;
      if (Math.abs(move) > Math.max(spread * 8, current * sigma * Math.sqrt(horizon) * 2.5)) adverse++;
      simulations.push({ id: s + 1, terminal_price: Number(price.toFixed(3)), move: Number(move.toFixed(3)), outcome: move > spread ? "UP" : move < -spread ? "DOWN" : "FLAT" });
    }
  }
  const probabilityUp = up / 100;
  const probabilityDown = down / 100;
  const expectedMove = sumMove / 100;
  const confidence = Math.max(probabilityUp, probabilityDown);
  const expectedRange = current * sigma * Math.sqrt(horizon);
  const spreadRatio = expectedRange > 0 ? spread / expectedRange : 1;
  const riskScore = Math.min(1, (adverse / 100) * 0.5 + Math.min(1, spreadRatio) * 0.5);
  let decision = "NO_TRADE";
  let rationale = "";
  if (returns.length < 30) {
    rationale = "Historique insuffisant : au moins 30 variations sont nécessaires avant toute décision.";
  } else if (spreadRatio > 0.35) {
    rationale = "Spread trop élevé par rapport au mouvement attendu.";
  } else if (probabilityUp >= 0.62 && expectedMove > spread * 1.5 && riskScore < 0.65) {
    decision = "BUY";
    rationale = "Les scénarios haussiers dominent et le mouvement moyen simulé dépasse le coût du spread.";
  } else if (probabilityDown >= 0.62 && expectedMove < -spread * 1.5 && riskScore < 0.65) {
    decision = "SELL";
    rationale = "Les scénarios baissiers dominent et le mouvement moyen simulé dépasse le coût du spread.";
  } else {
    rationale = "Les 100 scénarios ne montrent pas d'avantage statistique suffisant. Aucune entrée recommandée.";
  }
  const result = {
    symbol, decision, simulations: 100, confidence: Number(confidence.toFixed(4)),
    probability_up: Number(probabilityUp.toFixed(4)), probability_down: Number(probabilityDown.toFixed(4)),
    expected_move: Number(expectedMove.toFixed(4)), risk_score: Number(riskScore.toFixed(4)),
    rationale, features: { samples: prices.length, returns: returns.length, current_price: current, spread, mean_return: mean, volatility_per_tick: sigma, horizon_steps: horizon, model: "bootstrap_monte_carlo_v1" },
    scenarios: simulations, generated_at: new Date().toISOString()
  };
  await db("market_analysis_runs", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      symbol, decision, simulations: 100, confidence: result.confidence,
      probability_up: result.probability_up, probability_down: result.probability_down,
      expected_move: result.expected_move, risk_score: result.risk_score,
      rationale, features: result.features, scenarios: simulations
    })
  });
  return result;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/" || url.pathname === "/health") {
      return send(res, connected ? 200 : 503, { service: "aiva-market-feed", connected, symbols, lastQuoteAt, received, lastError });
    }
    if (url.pathname === "/api/quote") {
      const symbol = (url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
      if (!symbols.includes(symbol)) return send(res, 400, { error: "unsupported_symbol" });
      const rows = await db("market_quotes?symbol=eq." + encodeURIComponent(symbol) + "&select=symbol,bid,ask,mid,spread,provider_timestamp,received_at,source,connection_status,latency_ms&limit=1");
      return send(res, 200, rows[0] || { error: "quote_not_found" });
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
server.listen(Number(process.env.PORT || 3000), "0.0.0.0", () => console.log("Health and API endpoints ready"));

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

const socket = io("https://" + host, { transports: ["websocket"], reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 30000, timeout: 20000 });
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
