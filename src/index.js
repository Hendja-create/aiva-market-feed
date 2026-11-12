import http from "node:http";
import { io } from "socket.io-client";

const required = ["LIVE_RATES_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
for (const key of required) {
  if (!process.env[key]) {
    console.error("Missing required environment variable:", key);
    process.exit(1);
  }
}

const symbols = (process.env.SYMBOLS || "XAUUSD")
  .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
const host = process.env.LIVE_RATES_SOCKET_HOST || "eu-wss.live-rates.com";
const baseUrl = process.env.SUPABASE_URL.replace(/\/$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let connected = false;
let lastQuoteAt = null;
let lastError = null;
let received = 0;

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url !== "/" && req.url !== "/health") {
    res.writeHead(404); return res.end(JSON.stringify({ error: "not_found" }));
  }
  res.writeHead(connected ? 200 : 503);
  res.end(JSON.stringify({ service: "aiva-market-feed", connected, symbols, lastQuoteAt, received, lastError }));
});
server.listen(Number(process.env.PORT || 3000), "0.0.0.0", () => console.log("Health endpoint ready"));

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
  if (!bid || !ask || bid <= 0 || ask < bid) {
    console.warn("Rejected invalid quote", symbol); return;
  }
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
  const response = await fetch(baseUrl + "/rest/v1/market_quotes?on_conflict=symbol", {
    method: "POST",
    headers: {
      apikey: serviceKey, Authorization: "Bearer " + serviceKey,
      "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify(row), signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error("Supabase " + response.status + ": " + (await response.text()).slice(0, 250));
  received++; lastQuoteAt = row.received_at; lastError = null;
  if (received === 1 || received % 20 === 0) console.log("Quote stored", symbol, "bid", bid, "ask", ask, "latency", row.latency_ms);
}

const socket = io("https://" + host, {
  transports: ["websocket"], reconnection: true,
  reconnectionDelay: 1000, reconnectionDelayMax: 30000, timeout: 20000
});
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
