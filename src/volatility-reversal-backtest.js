function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(trades) {
  let equity = 0, peak = 0, maxDrawdown = 0, grossProfit = 0, grossLoss = 0, streak = 0, maxStreak = 0;
  for (const trade of trades) {
    equity += trade.pnl_points;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (trade.pnl_points > 0) { grossProfit += trade.pnl_points; streak = 0; }
    else if (trade.pnl_points < 0) { grossLoss += Math.abs(trade.pnl_points); streak++; maxStreak = Math.max(maxStreak, streak); }
  }
  const wins = trades.filter(t => t.pnl_points > 0).length;
  const net = trades.reduce((sum, t) => sum + t.pnl_points, 0);
  return {
    trades: trades.length, wins, losses: trades.filter(t => t.pnl_points < 0).length,
    win_rate: trades.length ? Number((wins / trades.length).toFixed(4)) : null,
    net_pnl_points: Number(net.toFixed(4)),
    profit_factor: grossLoss ? Number((grossProfit / grossLoss).toFixed(4)) : null,
    expectancy_points: trades.length ? Number((net / trades.length).toFixed(4)) : null,
    max_drawdown_points: Number(maxDrawdown.toFixed(4)),
    max_consecutive_losses: maxStreak
  };
}

export async function runVolatilityReversalBacktest(db, symbol = "XAUUSD", timeframe = "M5", maxRows = 80000, dateRange = null, overrides = {}) {
  const intervalMs = timeframe === "M1" ? 60000 : 300000;
  const pageSize = 1000;
  const pages = [];
  const latest = await db("aiva_historical_m1?symbol=eq." + encodeURIComponent(symbol) +
    "&timeframe=eq." + timeframe + "&select=candle_at&order=candle_at.desc&limit=1");
  if (!latest.length) return { available: false, warning: "Aucune bougie disponible." };
  const end = dateRange?.end && new Date(dateRange.end) < new Date(latest[0].candle_at) ? dateRange.end : latest[0].candle_at;
  const rangeFilter = "&candle_at=lte." + encodeURIComponent(end) +
    (dateRange?.start ? "&candle_at=gte." + encodeURIComponent(dateRange.start) : "");
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const batch = await db("aiva_historical_m1?symbol=eq." + encodeURIComponent(symbol) +
      "&timeframe=eq." + timeframe + "&select=candle_at,bid_open,bid_high,bid_low,bid_close,ask_open,ask_high,ask_low,ask_close,spread_close" +
      rangeFilter + "&order=candle_at.desc&limit=" + pageSize + "&offset=" + offset);
    pages.push(...batch);
    if (batch.length < pageSize) break;
  }
  const candles = pages.filter(row => [
    "bid_open","bid_high","bid_low","bid_close","ask_open","ask_high","ask_low","ask_close","spread_close"
  ].every(key => Number.isFinite(Number(row[key]))) && Number(row.ask_open) >= Number(row.bid_open))
    .sort((a, b) => new Date(a.candle_at) - new Date(b.candle_at)).slice(-maxRows);
  if (candles.length < 5000) return {
    available: false, symbol, timeframe, data_points: candles.length, required_data_points: 5000,
    warning: "Historique insuffisant pour tester le retournement."
  };

  const lookback = 60;
  const horizon = 3;
  const trainBoundary = Math.floor(candles.length * 0.7);
  const stopLoss = Math.max(0.1, Number(overrides.stopLoss ?? 5));
  const takeProfit = Math.max(0.1, Number(overrides.takeProfit ?? 8));
  const impulseBodyMultiplier = Math.max(1.1, Number(overrides.impulseBodyMultiplier ?? 1.8));
  const rangeMultiplier = Math.max(1.1, Number(overrides.rangeMultiplier ?? 1.3));
  const maxSpread = 1.5;
  const slippage = 0.05;
  const commission = 0.20;
  const trades = [];
  let skipped = 0;
  let nextAvailableIndex = lookback + 1;

  for (let i = lookback; i < candles.length - horizon - 1; i++) {
    if (i < nextAvailableIndex) continue;
    let contiguous = true;
    for (let j = i - lookback + 1; j <= i; j++) {
      if (new Date(candles[j].candle_at).getTime() - new Date(candles[j - 1].candle_at).getTime() !== intervalMs) {
        contiguous = false; break;
      }
    }
    if (!contiguous) { skipped++; continue; }

    const impulse = candles[i - 1];
    const confirm = candles[i];
    const prior = candles.slice(i - lookback - 1, i - 1);
    const bodyHistory = prior.map(c => Math.abs(Number(c.bid_close) - Number(c.bid_open)));
    const rangeHistory = prior.map(c => Number(c.bid_high) - Number(c.bid_low));
    const typicalBody = median(bodyHistory);
    const typicalRange = median(rangeHistory);
    const impulseBody = Number(impulse.bid_close) - Number(impulse.bid_open);
    const impulseRange = Number(impulse.bid_high) - Number(impulse.bid_low);
    const impulseMid = (Number(impulse.bid_open) + Number(impulse.bid_close)) / 2;
    const spread = Number(confirm.spread_close);
    if (!(typicalBody > 0 && typicalRange > 0) || spread <= 0 || spread > maxSpread) { skipped++; continue; }

    const isBullImpulse = impulseBody > typicalBody * impulseBodyMultiplier &&
      impulseRange > typicalRange * rangeMultiplier;
    const isBearImpulse = -impulseBody > typicalBody * impulseBodyMultiplier &&
      impulseRange > typicalRange * rangeMultiplier;
    const confirmBody = Number(confirm.bid_close) - Number(confirm.bid_open);
    let direction = null;
    if (isBearImpulse && confirmBody > 0 && Number(confirm.bid_close) > impulseMid) direction = "BUY";
    if (isBullImpulse && confirmBody < 0 && Number(confirm.bid_close) < impulseMid) direction = "SELL";
    if (!direction) continue;

    const entryIndex = i + 1;
    if (new Date(candles[entryIndex].candle_at).getTime() - new Date(confirm.candle_at).getTime() !== intervalMs) {
      skipped++; continue;
    }
    const entryBar = candles[entryIndex];
    const entrySpread = Number(entryBar.ask_open) - Number(entryBar.bid_open);
    if (!(entrySpread > 0 && entrySpread <= maxSpread)) { skipped++; continue; }
    const buy = direction === "BUY";
    const rawEntry = Number(buy ? entryBar.ask_open : entryBar.bid_open);
    const entry = rawEntry + (buy ? slippage : -slippage);
    const lastIndex = Math.min(candles.length - 1, entryIndex + horizon - 1);
    let exitIndex = lastIndex;
    let rawExit = Number(buy ? candles[lastIndex].bid_close : candles[lastIndex].ask_close);
    let exitReason = "Horizon 15 minutes";
    let sameBarAmbiguity = false;

    for (let j = entryIndex; j <= lastIndex; j++) {
      const bar = candles[j];
      const stopHit = buy ? Number(bar.bid_low) <= entry - stopLoss : Number(bar.ask_high) >= entry + stopLoss;
      const targetHit = buy ? Number(bar.bid_high) >= entry + takeProfit : Number(bar.ask_low) <= entry - takeProfit;
      if (stopHit && targetHit) {
        exitIndex = j; rawExit = buy ? entry - stopLoss : entry + stopLoss;
        exitReason = "Stop-loss (prioritaire si SL et TP touchés dans la même bougie)";
        sameBarAmbiguity = true; break;
      }
      if (stopHit) { exitIndex = j; rawExit = buy ? entry - stopLoss : entry + stopLoss; exitReason = "Stop-loss"; break; }
      if (targetHit) { exitIndex = j; rawExit = buy ? entry + takeProfit : entry - takeProfit; exitReason = "Take-profit"; break; }
    }
    const exit = rawExit + (buy ? -slippage : slippage);
    const gross = (buy ? 1 : -1) * (exit - entry);
    trades.push({
      direction, signal_time: confirm.candle_at, entry_time: entryBar.candle_at,
      exit_time: candles[exitIndex].candle_at, entry_price: Number(entry.toFixed(4)),
      exit_price: Number(exit.toFixed(4)), pnl_points: Number((gross - commission).toFixed(4)),
      exit_reason: exitReason, same_bar_ambiguity: sameBarAmbiguity,
      impulse_body_points: Number(Math.abs(impulseBody).toFixed(4)),
      typical_body_points: Number(typicalBody.toFixed(4)),
      impulse_range_ratio: Number((impulseRange / typicalRange).toFixed(4)),
      sample: entryIndex < trainBoundary ? "in_sample" : "out_of_sample"
    });
    nextAvailableIndex = exitIndex + 1;
    i = exitIndex;
  }

  const inSample = trades.filter(t => t.sample === "in_sample");
  const outOfSample = trades.filter(t => t.sample === "out_of_sample");
  const warnings = [
    "Stratégie expérimentale distincte : impulsion anormale puis confirmation de retournement, entrée à l'ouverture suivante.",
    "Les seuils sont fixes et non optimisés sur l'échantillon hors échantillon.",
    "Bid/Ask Dukascopy, glissement de 0,05 point par côté et commission de 0,20 point par aller-retour sont des hypothèses.",
    "Stop prioritaire lorsque SL et TP sont touchés dans la même bougie ; l'ordre intrabougie réel est inconnu.",
    "Aucune position réelle ni décision autonome n'utilise cette stratégie."
  ];
  if (trades.length < 30) warnings.push("Moins de 30 transactions au total : échantillon trop faible.");
  if (outOfSample.length < 10) warnings.push("Moins de 10 transactions hors échantillon : validation indépendante insuffisante.");
  if (trades.some(t => t.same_bar_ambiguity)) warnings.push("Au moins une bougie touche à la fois le stop et l'objectif.");
  return {
    available: true, symbol, timeframe,
    method: "aiva_volatility_reversal_impulse_confirm_v1",
    strategy: "AIVA_Volatility_Reversal",
    data_points: candles.length, first_tick_at: candles[0].candle_at,
    last_tick_at: candles[candles.length - 1].candle_at,
    train_boundary_at: candles[trainBoundary]?.candle_at || null,
    split: "70% chronologique / 30% chronologique",
    assumptions: {
      source: "Dukascopy Bid/Ask candles", lookback_candles: lookback,
      horizon_candles: horizon, horizon_minutes: horizon * (timeframe === "M1" ? 1 : 5),
      impulse_body_multiplier: impulseBodyMultiplier, impulse_range_multiplier: rangeMultiplier,
      stop_loss_points: stopLoss, take_profit_points: takeProfit,
      max_spread_points: maxSpread, slippage_each_side_points: slippage,
      commission_round_trip_points: commission, entry: "open of candle after reversal confirmation",
      max_one_trade_at_a_time: true, no_live_execution: true
    },
    signals_skipped: skipped, overall: summarize(trades),
    in_sample: summarize(inSample), out_of_sample: summarize(outOfSample),
    warnings, trades: trades.slice(-200)
  };
}
