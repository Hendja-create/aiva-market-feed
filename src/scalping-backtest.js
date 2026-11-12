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

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function summarize(trades) {
  let equity = 0, peak = 0, maxDrawdown = 0, lossStreak = 0, maxLossStreak = 0;
  let grossProfit = 0, grossLoss = 0;
  for (const trade of trades) {
    equity += trade.pnl_points;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (trade.pnl_points > 0) {
      grossProfit += trade.pnl_points;
      lossStreak = 0;
    } else if (trade.pnl_points < 0) {
      grossLoss += Math.abs(trade.pnl_points);
      lossStreak++;
      maxLossStreak = Math.max(maxLossStreak, lossStreak);
    } else lossStreak = 0;
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

function validCandle(row) {
  const fields = ["bid_open", "bid_high", "bid_low", "bid_close", "ask_open", "ask_high", "ask_low", "ask_close", "spread_close"];
  return fields.every(key => Number.isFinite(Number(row[key]))) &&
    Number(row.bid_open) > 0 && Number(row.ask_open) >= Number(row.bid_open) &&
    Number(row.bid_high) >= Number(row.bid_low) &&
    Number(row.ask_high) >= Number(row.ask_low) &&
    Number(row.spread_close) >= 0 &&
    Number.isFinite(new Date(row.candle_at).getTime());
}

export async function runM1ScalpingBacktest(db, symbol = "XAUUSD", confidenceThreshold = 0.65, maxRows = 80000, timeframe = "M1", dateRange = null) {
  const pageSize = 1000;
  const concurrency = 10;
  const newestFirst = [];
  const latestRows = await db("aiva_historical_m1?symbol=eq." + encodeURIComponent(symbol) +
    "&timeframe=eq." + timeframe + "&select=candle_at&order=candle_at.desc&limit=1");
  const cutoff = latestRows[0]?.candle_at;
  if (!cutoff) {
    return { available: false, symbol, timeframe, data_points: 0,
      required_data_points: 5000, warning: "Aucune bougie M1 disponible." };
  }
  const effectiveEnd = dateRange?.end && new Date(dateRange.end) < new Date(cutoff) ? dateRange.end : cutoff;
  const cutoffFilter = "&candle_at=lte." + encodeURIComponent(effectiveEnd) +
    (dateRange?.start ? "&candle_at=gte." + encodeURIComponent(dateRange.start) : "");

  for (let offset = 0; offset < maxRows; offset += pageSize * concurrency) {
    const offsets = Array.from({ length: concurrency }, (_, i) => offset + i * pageSize)
      .filter(value => value < maxRows);
    const pages = await Promise.all(offsets.map(pageOffset =>
      db("aiva_historical_m1?symbol=eq." + encodeURIComponent(symbol) +
        "&timeframe=eq." + timeframe + "&select=candle_at,bid_open,bid_high,bid_low,bid_close,ask_open,ask_high,ask_low,ask_close,spread_close" +
        cutoffFilter + "&order=candle_at.desc&limit=" + pageSize + "&offset=" + pageOffset)
    ));
    for (const page of pages) newestFirst.push(...page);
    if (pages.some(page => page.length < pageSize) || newestFirst.length >= maxRows) break;
  }

  const rawCandles = newestFirst.filter(validCandle).sort((a, b) =>
    new Date(a.candle_at).getTime() - new Date(b.candle_at).getTime()
  ).slice(-maxRows);

  const candles = rawCandles;

  if (candles.length < 5000) {
    return {
      available: false, symbol, timeframe, data_points: candles.length,
      required_data_points: 5000,
      warning: `Historique ${timeframe} encore insuffisant pour un backtest exploitable.`
    };
  }

  const lookback = timeframe === "M5" ? 60 : 300;
  const horizon = timeframe === "M5" ? 1 : 5;
  const blockLength = timeframe === "M5" ? 1 : 3;
  const signalInterval = timeframe === "M5" ? 1 : 5;
  const barIntervalMs = timeframe === "M5" ? 300000 : 60000;
  const allowedGapMs = barIntervalMs;
  const trainBoundary = Math.floor(candles.length * 0.7);
  const stopLoss = Math.max(0.1, Number(process.env.SCALPING_STOP_LOSS_POINTS || 5));
  const takeProfit = Math.max(0.1, Number(process.env.SCALPING_TAKE_PROFIT_POINTS || 8));
  const maxSpread = Math.max(0.2, Number(process.env.SCALPING_MAX_SPREAD_POINTS || 1.5));
  const slippageEachSide = Math.max(0, Number(process.env.SCALPING_SLIPPAGE_POINTS || 0.05));
  const commissionRoundTrip = Math.max(0, Number(process.env.SCALPING_COMMISSION_POINTS || 0.20));
  const maxDailyLoss = Math.max(1, Number(process.env.SCALPING_MAX_DAILY_LOSS_POINTS || 15));
  const maxDailyLossStreak = Math.max(1, Math.floor(Number(process.env.SCALPING_MAX_LOSSES_PER_DAY || 3)));
  const returns = new Array(candles.length).fill(0);

  for (let i = 1; i < candles.length; i++) {
    const gap = new Date(candles[i].candle_at).getTime() - new Date(candles[i - 1].candle_at).getTime();
    if (gap > allowedGapMs || gap <= 0) continue;
    const previousMid = (Number(candles[i - 1].bid_close) + Number(candles[i - 1].ask_close)) / 2;
    const currentMid = (Number(candles[i].bid_close) + Number(candles[i].ask_close)) / 2;
    if (previousMid > 0) returns[i] = (currentMid - previousMid) / previousMid;
  }

  const trades = [];
  let skippedSignals = 0, blockedByDailyRisk = 0;
  let currentDay = null, dailyPnl = 0, dailyLossStreak = 0;

  for (let i = lookback; i + horizon < candles.length; i += signalInterval) {
    let completeSample = true;
    for (let j = i - lookback + 1; j <= i; j++) {
      const gap = new Date(candles[j].candle_at).getTime() - new Date(candles[j - 1].candle_at).getTime();
      if (gap !== barIntervalMs) { completeSample = false; break; }
    }
    if (!completeSample) { skippedSignals++; continue; }
    const sample = returns.slice(i - lookback + 1, i + 1);
    const currentCandle = candles[i];
    const current = (Number(currentCandle.bid_close) + Number(currentCandle.ask_close)) / 2;
    const spread = Number(currentCandle.spread_close);
    if (spread > maxSpread || spread <= 0) { skippedSignals++; continue; }

    const sigma = standardDeviation(sample);
    if (!(sigma > 0)) { skippedSignals++; continue; }
    const expectedRange = current * sigma * Math.sqrt(horizon);
    const spreadRatio = expectedRange > 0 ? spread / expectedRange : 1;
    const momentumLookback = timeframe === "M5" ? 2 : 10;
    const momentum = sample.slice(-momentumLookback).reduce((sum, value) => sum + value, 0);
    const random = seededRandom((i * 2654435761 + Math.round(confidenceThreshold * 10000)) >>> 0);

    let up = 0, down = 0, flat = 0, sumMove = 0, adverse = 0;
    for (let simulation = 0; simulation < 100; simulation++) {
      let price = current, pathHigh = current, pathLow = current;
      for (let step = 0; step < horizon;) {
        const start = Math.floor(random() * sample.length);
        for (let j = 0; j < blockLength && step < horizon; j++, step++) {
          price *= 1 + sample[(start + j) % sample.length];
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

    const probabilityUp = up / 100;
    const probabilityDown = down / 100;
    const expectedMove = sumMove / 100;
    const riskScore = Math.min(1, (adverse / 100) * 0.6 + Math.min(1, spreadRatio) * 0.4);
    let direction = null;

    if (spreadRatio <= 0.5 && riskScore < 0.55 &&
        probabilityUp >= confidenceThreshold && probabilityUp - probabilityDown >= 0.25 &&
        expectedMove > spread * 1.5 && momentum > 0) direction = "BUY";
    else if (spreadRatio <= 0.5 && riskScore < 0.55 &&
        probabilityDown >= confidenceThreshold && probabilityDown - probabilityUp >= 0.25 &&
        expectedMove < -spread * 1.5 && momentum < 0) direction = "SELL";

    if (!direction) { skippedSignals++; continue; }

    const entryIndex = i + 1;
    const lastIndex = entryIndex + horizon - 1;
    if (lastIndex >= candles.length) break;
    let contiguous = true;
    for (let j = entryIndex; j <= lastIndex; j++) {
      const gap = new Date(candles[j].candle_at).getTime() - new Date(candles[j - 1].candle_at).getTime();
      if (gap > allowedGapMs || gap <= 0) { contiguous = false; break; }
    }
    if (!contiguous) { skippedSignals++; continue; }

    const entryBar = candles[entryIndex];
    const entrySpread = Number(entryBar.ask_open) - Number(entryBar.bid_open);
    if (entrySpread <= 0 || entrySpread > maxSpread) { skippedSignals++; continue; }

    const signalDay = new Date(currentCandle.candle_at).toISOString().slice(0, 10);
    if (signalDay !== currentDay) {
      currentDay = signalDay;
      dailyPnl = 0;
      dailyLossStreak = 0;
    }
    if (dailyPnl <= -maxDailyLoss || dailyLossStreak >= maxDailyLossStreak) {
      blockedByDailyRisk++;
      continue;
    }

    const isBuy = direction === "BUY";
    const rawEntry = Number(isBuy ? entryBar.ask_open : entryBar.bid_open);
    const entry = rawEntry + (isBuy ? slippageEachSide : -slippageEachSide);
    let exitIndex = lastIndex;
    let rawExit = Number(isBuy ? candles[lastIndex].bid_close : candles[lastIndex].ask_close);
    let exitReason = "Horizon 5 minutes";
    let hitBothSameBar = false;

    for (let j = entryIndex; j <= lastIndex; j++) {
      const bar = candles[j];
      const stopHit = isBuy
        ? Number(bar.bid_low) <= entry - stopLoss
        : Number(bar.ask_high) >= entry + stopLoss;
      const targetHit = isBuy
        ? Number(bar.bid_high) >= entry + takeProfit
        : Number(bar.ask_low) <= entry - takeProfit;
      if (stopHit && targetHit) {
        exitIndex = j;
        rawExit = isBuy ? entry - stopLoss : entry + stopLoss;
        exitReason = "Stop-loss (stop prioritaire si SL et TP touchés dans la même minute)";
        hitBothSameBar = true;
        break;
      }
      if (stopHit) {
        exitIndex = j;
        rawExit = isBuy ? entry - stopLoss : entry + stopLoss;
        exitReason = "Stop-loss";
        break;
      }
      if (targetHit) {
        exitIndex = j;
        rawExit = isBuy ? entry + takeProfit : entry - takeProfit;
        exitReason = "Take-profit";
        break;
      }
    }

    const exit = rawExit + (isBuy ? -slippageEachSide : slippageEachSide);
    const grossPnl = (isBuy ? 1 : -1) * (exit - entry);
    const netPnl = grossPnl - commissionRoundTrip;
    const roundedPnl = Number(netPnl.toFixed(4));

    trades.push({
      direction,
      entry_time: candles[entryIndex].candle_at,
      exit_time: candles[exitIndex].candle_at,
      entry_price: Number(entry.toFixed(4)),
      exit_price: Number(exit.toFixed(4)),
      gross_pnl_points: Number(grossPnl.toFixed(4)),
      commission_points: commissionRoundTrip,
      pnl_points: roundedPnl,
      exit_reason: exitReason,
      same_bar_ambiguity: hitBothSameBar,
      sample: entryIndex < trainBoundary ? "in_sample" : "out_of_sample"
    });

    dailyPnl += roundedPnl;
    dailyLossStreak = roundedPnl < 0 ? dailyLossStreak + 1 : 0;
    i = Math.max(i, exitIndex - signalInterval);
  }

  const inSample = trades.filter(t => t.sample === "in_sample");
  const outOfSample = trades.filter(t => t.sample === "out_of_sample");
  const warnings = [];
  if (candles.length < (timeframe === "M5" ? 5000 : 20000)) warnings.push(`Historique ${timeframe} encore limité : résultat exploratoire.`);
  if (trades.length < 30) warnings.push("Moins de 30 transactions : échantillon trop faible pour conclure.");
  if (outOfSample.length < 10) warnings.push("Moins de 10 transactions hors échantillon : validation indépendante insuffisante.");
  if (trades.some(t => t.same_bar_ambiguity)) warnings.push("Quand SL et TP sont touchés dans la même bougie, le stop est compté en premier.");
  warnings.push("Les prix Bid/Ask proviennent de Dukascopy, pas du courtier du compte de trading.");
  warnings.push("Commission et glissement sont des hypothèses en points, pas les frais contractuels du courtier.");

  return {
    available: true,
    symbol,
    timeframe,
    method: `${timeframe.toLowerCase()}_scalping_block_bootstrap_monte_carlo_bid_ask_v1`,
    model: "block_bootstrap_monte_carlo_v1",
    data_points: candles.length,
    first_tick_at: candles[0].candle_at,
    last_tick_at: candles[candles.length - 1].candle_at,
    train_boundary_at: candles[trainBoundary]?.candle_at || null,
    split: "70% chronologique / 30% chronologique",
    assumptions: {
      source: "Dukascopy historical candles",
      simulations_per_signal: 100,
      confidence_threshold: confidenceThreshold,
      lookback_candles: lookback,
      horizon_candles: horizon,
      horizon_minutes: horizon * (timeframe === "M5" ? 5 : 1),
      lookback_minutes: lookback * (timeframe === "M5" ? 5 : 1),
      block_length: blockLength,
      signal_interval_candles: signalInterval,
      stop_loss_points: stopLoss,
      take_profit_points: takeProfit,
      maximum_signal_spread_points: maxSpread,
      slippage_points_each_side: slippageEachSide,
      commission_points_round_trip: commissionRoundTrip,
      max_daily_loss_points: maxDailyLoss,
      max_daily_consecutive_losses: maxDailyLossStreak,
      entry_exit_use_bid_ask: true,
      spread_included: true,
      same_bar_stop_priority: true,
      random_seed: "deterministic by candle index and confidence threshold"
    },
    signals_without_entry: skippedSignals,
    signals_blocked_by_daily_risk: blockedByDailyRisk,
    overall: summarize(trades),
    in_sample: summarize(inSample),
    out_of_sample: summarize(outOfSample),
    warnings,
    trades: trades.slice(-200)
  };
}
