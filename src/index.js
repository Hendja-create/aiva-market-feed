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
    "access-control-allow-origin": process.env.DASHBOARD_ORIGIN || "*",
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
  if (returns.length < 30) {
    rationale = "Historique insuffisant : au moins 30 variations sont nécessaires avant toute décision.";
  } else if (spreadRatio > 0.5) {
    rationale = "Spread trop élevé par rapport au mouvement attendu : entrée bloquée.";
  } else if (probabilityUp >= adaptiveConfidenceThreshold && probabilityUp - probabilityDown >= 0.25 && expectedMove > spread * 1.5 && riskScore < 0.55 && recentMomentum > 0) {
    decision = "BUY";
    rationale = "Les trajectoires haussières dominent, le mouvement moyen dépasse le spread et le momentum récent confirme la direction.";
  } else if (probabilityDown >= adaptiveConfidenceThreshold && probabilityDown - probabilityUp >= 0.25 && expectedMove < -spread * 1.5 && riskScore < 0.55 && recentMomentum < 0) {
    decision = "SELL";
    rationale = "Les trajectoires baissières dominent, le mouvement moyen dépasse le spread et le momentum récent confirme la direction.";
  } else {
    rationale = "Les 100 trajectoires ne montrent pas d'avantage statistique assez net. Aucune entrée recommandée.";
  }
  const result = {
    symbol, decision, simulations: 100, confidence: Number(confidence.toFixed(4)),
    probability_up: Number(probabilityUp.toFixed(4)), probability_down: Number(probabilityDown.toFixed(4)), probability_flat: Number(probabilityFlat.toFixed(4)),
    expected_move: Number(expectedMove.toFixed(4)), risk_score: Number(riskScore.toFixed(4)),
    rationale, features: { samples: prices.length, returns: returns.length, current_price: current, spread, mean_return: mean, volatility_per_tick: sigma, horizon_steps: horizon, block_length: blockLength, confidence_threshold: adaptiveConfidenceThreshold, recent_momentum_10: Number(recentMomentum.toFixed(8)), model: "block_bootstrap_monte_carlo_v2" },
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
  if (reviewed >= 30 && accuracy !== null) {
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
  const d = new Date(date);
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
      "&select=pnl_points&limit=500"),
    db("aiva_demo_trades?symbol=eq." + encodeURIComponent(symbol) +
      "&status=eq.CLOSED&select=pnl_points,closed_at&order=closed_at.desc&limit=" + maxConsecutiveLosses)
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
    "&select=bid,ask,mid,received_at&limit=1");
  const q = quotes[0];
  const quoteAge = q ? Date.now() - new Date(q.received_at).getTime() : Infinity;
  const freshQuote = Boolean(q && Number.isFinite(quoteAge) && quoteAge >= -30000 && quoteAge <= 90000);

  if (openRows.length) {
    const trade = openRows[0];
    if (!freshQuote) {
      return { mode: "demo", open: true, risk_monitoring: "waiting_for_fresh_quote" };
    }

    const entryPrice = Number(trade.entry_price);
    const markPrice = Number(trade.direction === "BUY" ? q.bid : q.ask);
    const pnl = (trade.direction === "BUY" ? 1 : -1) * (markPrice - entryPrice);
    const context = trade.context && typeof trade.context === "object" ? trade.context : {};
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
          close_reason: closeReason
        })
      });
      console.log("Demo trade closed", JSON.stringify({
        symbol, direction: trade.direction, pnl_points: finalPnl, close_reason: closeReason
      }));
      return { mode: "demo", closed: true, pnl_points: finalPnl, close_reason: closeReason };
    }

    return {
      mode: "demo", open: true, pnl_points: Number(pnl.toFixed(4)),
      stop_loss_remaining: Number(Math.max(0, sl + pnl).toFixed(4)),
      take_profit_remaining: Number(Math.max(0, tp - pnl).toFixed(4)),
      waiting_ticks: Math.max(0, 30 - ticks.length)
    };
  }

  const risk = await getDemoRiskState(symbol);
  if (risk.blockedByDailyLoss || risk.blockedByLosingStreak) {
    return {
      mode: "demo", opened: false, reason: risk.blockedByDailyLoss ? "daily_loss_limit" : "consecutive_losses_limit",
      risk
    };
  }
  if (!analysis || !["BUY", "SELL"].includes(analysis.decision)) {
    return { mode: "demo", opened: false, reason: "NO_TRADE", risk };
  }
  if (!freshQuote) {
    return { mode: "demo", opened: false, reason: "stale_quote" };
  }

  const entry = Number(analysis.decision === "BUY" ? q.ask : q.bid);
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
    take_profit_points: takeProfitPoints, trade_id: saved?.[0]?.id || null
  };
}
async function getDemoHistory(period, symbol) {
  const now = new Date();
  const days = period === "monthly" ? 370 : period === "weekly" ? 100 : 31;
  const from = new Date(now.getTime() - days * 86400000).toISOString();
  const [closed, opened, analyses] = await Promise.all([
    db("aiva_demo_trades?symbol=eq." + encodeURIComponent(symbol) + "&status=eq.CLOSED&opened_at=gte." + encodeURIComponent(from) +
      "&select=direction,entry_price,exit_price,pnl_points,opened_at,closed_at&order=closed_at.desc&limit=2000"),
    db("aiva_demo_trades?symbol=eq." + encodeURIComponent(symbol) + "&status=eq.OPEN&select=id,direction,entry_price,opened_at&order=opened_at.desc&limit=100"),
    db("market_analysis_runs?symbol=eq." + encodeURIComponent(symbol) + "&created_at=gte." + encodeURIComponent(from) +
      "&select=decision,created_at&order=created_at.desc&limit=2000")
  ]);
  const buckets = new Map();
  const ensure = key => {
    if (!buckets.has(key)) buckets.set(key, { period: key, decisions: 0, trades: 0, wins: 0, losses: 0, breakeven: 0, pnl_points: 0 });
    return buckets.get(key);
  };
  for (const a of analyses) ensure(periodKey(new Date(a.created_at), period)).decisions++;
  for (const t of closed) {
    const b = ensure(periodKey(new Date(t.closed_at || t.opened_at), period));
    const pnl = Number(t.pnl_points || 0);
    b.trades++; b.pnl_points += pnl;
    if (pnl > 0) b.wins++; else if (pnl < 0) b.losses++; else b.breakeven++;
  }
  const rows = [...buckets.values()].sort((a,b) => a.period.localeCompare(b.period)).map(b => ({
    ...b, pnl_points: Number(b.pnl_points.toFixed(4)),
    win_rate: b.trades ? Number((b.wins / b.trades).toFixed(4)) : null
  }));
  const totalTrades = closed.length;
  const totalPnl = closed.reduce((sum,t) => sum + Number(t.pnl_points || 0), 0);
  return {
    mode: "DEMO", symbol, period, timezone: "Africa/Kinshasa",
    summary: {
      decisions: analyses.length, closed_trades: totalTrades, open_trades: opened.length,
      wins: closed.filter(t => Number(t.pnl_points) > 0).length,
      losses: closed.filter(t => Number(t.pnl_points) < 0).length,
      win_rate: totalTrades ? Number((closed.filter(t => Number(t.pnl_points) > 0).length / totalTrades).toFixed(4)) : null,
      pnl_points: Number(totalPnl.toFixed(4))
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
      try {
        analysis = await getAnalysis(symbol);
      } catch (analysisError) {
        console.warn("Analysis skipped; continuing demo risk management", analysisError.message);
      }
      const demo = await manageDemoTrade(symbol, analysis);
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
          last_decision: analysis.decision,
          last_error: null
        })
      });
      console.log("Autonomous cycle", JSON.stringify({
        symbol,
        decision: analysis.decision,
        simulations: analysis.simulations,
        learning,
        demo,
        generatedAt: analysis.generated_at
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
    } else if (trade.pnl_points < 0) {
      grossLoss += Math.abs(trade.pnl_points);
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
  const all = [];
  for (let offset = 0; offset < maxRows; offset += 1000) {
    const page = await db("market_quote_ticks?symbol=eq." + encodeURIComponent(symbol) +
      "&select=bid,ask,mid,spread,received_at&order=received_at.asc&limit=1000&offset=" + offset);
    all.push(...page);
    if (page.length < 1000) break;
  }
  return all.slice(-maxRows).filter(t =>
    Number.isFinite(Number(t.bid)) && Number.isFinite(Number(t.ask)) &&
    Number.isFinite(Number(t.mid)) && Number(t.ask) >= Number(t.bid)
  );
}

function runHistoricalBacktest(ticks) {
  const stopLoss = Math.max(0.1, Number(process.env.DEMO_STOP_LOSS_POINTS || 5));
  const takeProfit = Math.max(0.1, Number(process.env.DEMO_TAKE_PROFIT_POINTS || 8));
  const horizon = 30, blockLength = 3, signalInterval = 60, trainBoundary = Math.floor(ticks.length * 0.7);
  const trades = [];
  let skippedSignals = 0;
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
        probabilityUp >= 0.65 && probabilityUp - probabilityDown >= 0.25 &&
        expectedMove > spread * 1.5 && momentum > 0) direction = "BUY";
    else if (spreadRatio <= 0.5 && riskScore < 0.55 &&
        probabilityDown >= 0.65 && probabilityDown - probabilityUp >= 0.25 &&
        expectedMove < -spread * 1.5 && momentum < 0) direction = "SELL";

    if (!direction) { skippedSignals++; i += signalInterval; continue; }

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
    trades.push({
      direction,
      entry_time: ticks[entryIndex].received_at,
      exit_time: ticks[exitIndex].received_at,
      entry_price: Number(entry.toFixed(4)),
      exit_price: Number(exitPrice.toFixed(4)),
      pnl_points: Number(pnl.toFixed(4)),
      exit_reason: exitReason,
      sample: entryIndex < trainBoundary ? "in_sample" : "out_of_sample"
    });
    i = Math.max(i + signalInterval, exitIndex);
  }

  const inSample = trades.filter(t => t.sample === "in_sample");
  const outOfSample = trades.filter(t => t.sample === "out_of_sample");
  const first = ticks[0]?.received_at || null;
  const last = ticks[ticks.length - 1]?.received_at || null;
  return {
    method: "walk_forward_block_bootstrap_monte_carlo",
    model: "block_bootstrap_monte_carlo_v2",
    symbol: "XAUUSD",
    data_points: ticks.length,
    first_tick_at: first,
    last_tick_at: last,
    train_boundary_at: ticks[trainBoundary]?.received_at || null,
    split: "70% chronologique / 30% chronologique",
    assumptions: {
      simulations_per_signal: 100,
      signal_interval_ticks: signalInterval,
      horizon_ticks: horizon,
      stop_loss_points: stopLoss,
      take_profit_points: takeProfit,
      entry_exit_use_bid_ask: true,
      spread_included: true,
      commissions: "non incluses",
      slippage: "non inclus",
      random_seed: "déterministe par index de cotation"
    },
    signals_without_entry: skippedSignals,
    overall: summarizeBacktestTrades(trades),
    in_sample: summarizeBacktestTrades(inSample),
    out_of_sample: summarizeBacktestTrades(outOfSample),
    trades: trades.slice(-100)
  };
}

const server = http.createServer(async (req, res) => {
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
    }
    if (url.pathname === "/api/autonomous-status") {
      const symbol = (url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
      if (!symbols.includes(symbol)) return send(res, 400, { error: "unsupported_symbol" });
      const rows = await db("aiva_learning_state?symbol=eq." + encodeURIComponent(symbol) +
        "&select=symbol,confidence_threshold,evaluated_directional,directional_accuracy,updated_at,last_cycle_at,last_decision&limit=1");
      return send(res, 200, rows[0] || {
        symbol,
        confidence_threshold: adaptiveConfidenceThreshold,
        evaluated_directional: 0,
        directional_accuracy: null,
        last_cycle_at: null,
        last_decision: null
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
    if (url.pathname === "/api/backtest") {
      const symbol = (url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
      if (!symbols.includes(symbol)) return send(res, 400, { error: "unsupported_symbol" });
      const authHeader = String(req.headers.authorization || "");
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (!(await verifyUserToken(bearer))) return send(res, 401, { error: "authentication_required" });
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

const autonomousIntervalMs = Math.max(30000, Math.min(300000, Number(process.env.AUTO_ANALYSIS_INTERVAL_MS || 60000)));
setTimeout(() => { runAutonomousCycle(); }, 20000);
setInterval(runAutonomousCycle, autonomousIntervalMs);
console.log("Autonomous analysis scheduler enabled", autonomousIntervalMs, "ms");

