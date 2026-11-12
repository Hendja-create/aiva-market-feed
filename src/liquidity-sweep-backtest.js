function stats(trades) {
  let equity = 0, peak = 0, maxDrawdown = 0, grossProfit = 0, grossLoss = 0, losses = 0, maxLossStreak = 0, streak = 0;
  for (const t of trades) {
    equity += t.pnl_points;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (t.pnl_points > 0) { grossProfit += t.pnl_points; streak = 0; }
    else if (t.pnl_points < 0) { grossLoss += Math.abs(t.pnl_points); losses++; streak++; maxLossStreak = Math.max(maxLossStreak, streak); }
  }
  const wins = trades.filter(t => t.pnl_points > 0).length;
  const net = trades.reduce((s, t) => s + t.pnl_points, 0);
  return {
    trades: trades.length, wins, losses,
    win_rate: trades.length ? Number((wins / trades.length).toFixed(4)) : null,
    net_pnl_points: Number(net.toFixed(4)),
    profit_factor: grossLoss ? Number((grossProfit / grossLoss).toFixed(4)) : null,
    expectancy_points: trades.length ? Number((net / trades.length).toFixed(4)) : null,
    max_drawdown_points: Number(maxDrawdown.toFixed(4)),
    max_consecutive_losses: maxLossStreak
  };
}

export async function runLiquiditySweepBacktest(db, symbol = "XAUUSD", timeframe = "M5", maxRows = 80000) {
  const intervalMs = timeframe === "M1" ? 60000 : 300000;
  const pageSize = 1000, pages = [];
  const latest = await db("aiva_historical_m1?symbol=eq." + encodeURIComponent(symbol) +
    "&timeframe=eq." + timeframe + "&select=candle_at&order=candle_at.desc&limit=1");
  if (!latest.length) return { available: false, warning: "Aucune bougie disponible." };
  const end = latest[0].candle_at;
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const batch = await db("aiva_historical_m1?symbol=eq." + encodeURIComponent(symbol) +
      "&timeframe=eq." + timeframe +
      "&select=candle_at,bid_open,bid_high,bid_low,bid_close,ask_open,ask_high,ask_low,ask_close,spread_close" +
      "&candle_at=lte." + encodeURIComponent(end) +
      "&order=candle_at.desc&limit=" + pageSize + "&offset=" + offset);
    pages.push(...batch);
    if (batch.length < pageSize) break;
  }
  const candles = pages.filter(r => ["bid_open","bid_high","bid_low","bid_close","ask_open","ask_high","ask_low","ask_close","spread_close"]
    .every(k => Number.isFinite(Number(r[k]))) && Number(r.ask_open) >= Number(r.bid_open))
    .sort((a,b) => new Date(a.candle_at) - new Date(b.candle_at)).slice(-maxRows);
  if (candles.length < 5000) return { available:false, symbol, timeframe, data_points:candles.length, required_data_points:5000, warning:"Historique insuffisant." };

  // Pré-déclaration : niveau de liquidité sur 20 bougies antérieures ; sweep puis confirmation structurelle.
  const swingLookback = 20, microLookback = 3, horizon = 3;
  const stopLoss = 5, takeProfit = 8, maxSpread = 1.5, slippage = 0.05, commission = 0.20;
  const trainBoundary = Math.floor(candles.length * 0.7);
  const trades = [];
  let skipped = 0, nextAvailableIndex = swingLookback + 2;

  for (let i = swingLookback + 1; i < candles.length - horizon - 1; i++) {
    if (i < nextAvailableIndex) continue;
    let contiguous = true;
    for (let j = i - swingLookback - 1; j <= i; j++) {
      if (new Date(candles[j].candle_at).getTime() - new Date(candles[j-1].candle_at).getTime() !== intervalMs) { contiguous = false; break; }
    }
    if (!contiguous) { skipped++; continue; }

    const sweep = candles[i-1], confirm = candles[i];
    const prior = candles.slice(i-swingLookback-1, i-1);
    const priorHigh = Math.max(...prior.map(c => Number(c.bid_high)));
    const priorLow = Math.min(...prior.map(c => Number(c.bid_low)));
    const microHigh = Math.max(...candles.slice(i-microLookback-1, i-1).map(c => Number(c.bid_high)));
    const microLow = Math.min(...candles.slice(i-microLookback-1, i-1).map(c => Number(c.bid_low)));
    const spread = Number(confirm.spread_close);
    if (!(spread > 0 && spread <= maxSpread)) { skipped++; continue; }

    const sweptLow = Number(sweep.bid_low) < priorLow && Number(sweep.bid_close) > priorLow;
    const sweptHigh = Number(sweep.bid_high) > priorHigh && Number(sweep.bid_close) < priorHigh;
    let direction = null;
    // Confirmation sur clôture complète : reprise de la micro-structure après le sweep.
    if (sweptLow && Number(confirm.bid_close) > Number(confirm.bid_open) && Number(confirm.bid_close) > microHigh) direction = "BUY";
    if (sweptHigh && Number(confirm.bid_close) < Number(confirm.bid_open) && Number(confirm.bid_close) < microLow) direction = "SELL";
    if (!direction) continue;

    const entryIndex = i+1, entryBar = candles[entryIndex];
    if (new Date(entryBar.candle_at).getTime() - new Date(confirm.candle_at).getTime() !== intervalMs) { skipped++; continue; }
    const entrySpread = Number(entryBar.ask_open)-Number(entryBar.bid_open);
    if (!(entrySpread > 0 && entrySpread <= maxSpread)) { skipped++; continue; }
    const buy = direction === "BUY";
    const entry = Number(buy ? entryBar.ask_open : entryBar.bid_open) + (buy ? slippage : -slippage);
    const lastIndex = Math.min(candles.length-1, entryIndex+horizon-1);
    let exitIndex = lastIndex, rawExit = Number(buy ? candles[lastIndex].bid_close : candles[lastIndex].ask_close);
    let exitReason = "Horizon " + (horizon * (timeframe === "M1" ? 1 : 5)) + " minutes";
    let ambiguous = false;
    for (let j=entryIndex; j<=lastIndex; j++) {
      const bar = candles[j];
      const stop = buy ? Number(bar.bid_low) <= entry-stopLoss : Number(bar.ask_high) >= entry+stopLoss;
      const target = buy ? Number(bar.bid_high) >= entry+takeProfit : Number(bar.ask_low) <= entry-takeProfit;
      if (stop && target) { exitIndex=j; rawExit=buy ? entry-stopLoss : entry+stopLoss; exitReason="Stop prioritaire (ambiguïté intrabougie)"; ambiguous=true; break; }
      if (stop) { exitIndex=j; rawExit=buy ? entry-stopLoss : entry+stopLoss; exitReason="Stop-loss"; break; }
      if (target) { exitIndex=j; rawExit=buy ? entry+takeProfit : entry-takeProfit; exitReason="Take-profit"; break; }
    }
    const exit = rawExit + (buy ? -slippage : slippage);
    const pnl = (buy ? 1 : -1) * (exit-entry) - commission;
    trades.push({
      direction, sweep_time:sweep.candle_at, confirmation_time:confirm.candle_at,
      entry_time:entryBar.candle_at, exit_time:candles[exitIndex].candle_at,
      liquidity_level: Number((buy ? priorLow : priorHigh).toFixed(4)),
      sweep_extreme: Number((buy ? Number(sweep.bid_low) : Number(sweep.bid_high)).toFixed(4)),
      entry_price:Number(entry.toFixed(4)), exit_price:Number(exit.toFixed(4)),
      pnl_points:Number(pnl.toFixed(4)), exit_reason:exitReason, same_bar_ambiguity:ambiguous,
      sample:entryIndex < trainBoundary ? "in_sample" : "out_of_sample"
    });
    nextAvailableIndex=exitIndex+1;
    i=exitIndex;
  }

  const by = (list, direction) => stats(list.filter(t=>t.direction===direction));
  const is = trades.filter(t=>t.sample==="in_sample"), oos = trades.filter(t=>t.sample==="out_of_sample");
  const warnings = [
    "Recherche expérimentale : sweep d'un extrême des 20 bougies antérieures, puis clôture de confirmation au-delà de la micro-structure des 3 bougies antérieures.",
    "Aucun niveau futur n'est utilisé ; entrée à l'ouverture de la bougie suivant la confirmation.",
    "Bid/Ask Dukascopy ; glissement 0,05 point par côté ; commission 0,20 point par aller-retour ; spread maximum 1,5 point.",
    "Stop 5 points, objectif 8 points, horizon 3 bougies ; stop prioritaire si SL et TP sont touchés dans la même bougie.",
    "Paramètres pré-déclarés, pas de recherche de paramètres sur l'échantillon hors échantillon.",
    "Cette stratégie n'est pas connectée aux décisions autonomes ni à l'exécution réelle."
  ];
  if (trades.length<30) warnings.push("Moins de 30 transactions : échantillon global faible.");
  if (oos.length<10) warnings.push("Moins de 10 transactions hors échantillon : validation insuffisante.");
  if (trades.some(t=>t.same_bar_ambiguity)) warnings.push("Des bougies touchent stop et objectif ; ordre intrabougie inconnu.");
  return {
    available:true, symbol, timeframe, strategy:"AIVA_Liquidity_Sweep_Structure_Confirmation",
    method:"aiva_liquidity_sweep_structure_confirm_v1",
    data_points:candles.length, first_tick_at:candles[0].candle_at, last_tick_at:candles.at(-1).candle_at,
    train_boundary_at:candles[trainBoundary]?.candle_at || null, split:"70% chronologique / 30% chronologique",
    assumptions:{source:"Dukascopy Bid/Ask candles", liquidity_lookback_bars:swingLookback,
      micro_structure_lookback_bars:microLookback, confirmation:"clôture au-delà du plus haut/bas des 3 bougies précédant le sweep",
      horizon_bars:horizon, horizon_minutes:horizon*(timeframe==="M1"?1:5),
      stop_loss_points:stopLoss,take_profit_points:takeProfit,max_spread_points:maxSpread,
      slippage_each_side_points:slippage,commission_round_trip_points:commission,
      one_position_at_a_time:true, no_live_execution:true},
    signals_skipped:skipped, overall:stats(trades), in_sample:stats(is), out_of_sample:stats(oos),
    by_direction:{BUY:{overall:by(trades,"BUY"),in_sample:by(is,"BUY"),out_of_sample:by(oos,"BUY")},
      SELL:{overall:by(trades,"SELL"),in_sample:by(is,"SELL"),out_of_sample:by(oos,"SELL")}},
    warnings, trades:trades.slice(-200)
  };
}
