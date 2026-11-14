import { isValidSimulationCandle, isContinuousWindow } from "./simulation-quality.js";

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function ema(values, period) {
  const out = Array(values.length).fill(null), k = 2 / (period + 1);
  let value = null;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) continue;
    value = value === null ? values[i] : values[i] * k + value * (1 - k);
    out[i] = value;
  }
  return out;
}
function rsi(values, period) {
  const out = Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    let up = 0, down = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = values[j] - values[j - 1];
      if (d > 0) up += d; else down -= d;
    }
    const rs = down === 0 ? 100 : up / down;
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}
function atr(c, period = 14) {
  const tr = c.map((x, i) => i === 0 ? x.bid_high - x.bid_low : Math.max(
    x.bid_high - x.bid_low,
    Math.abs(x.bid_high - c[i-1].bid_close),
    Math.abs(x.bid_low - c[i-1].bid_close)
  ));
  const out = Array(c.length).fill(null);
  for (let i = period; i < c.length; i++) out[i] = mean(tr.slice(i-period+1, i+1));
  return out;
}
function metrics(trades) {
  let equity=0, peak=0, dd=0, gp=0, gl=0, streak=0, maxStreak=0;
  for (const t of trades) {
    equity += t.pnl_points; peak = Math.max(peak, equity); dd = Math.max(dd, peak-equity);
    if (t.pnl_points > 0) { gp += t.pnl_points; streak=0; }
    else if (t.pnl_points < 0) { gl += -t.pnl_points; streak++; maxStreak=Math.max(maxStreak,streak); }
  }
  const wins=trades.filter(t=>t.pnl_points>0).length, net=equity;
  return { trades:trades.length, wins, losses:trades.filter(t=>t.pnl_points<0).length,
    win_rate:trades.length?Number((wins/trades.length).toFixed(4)):null,
    net_pnl_points:Number(net.toFixed(4)),
    profit_factor:gl?Number((gp/gl).toFixed(4)):null,
    expectancy_points:trades.length?Number((net/trades.length).toFixed(4)):null,
    max_drawdown_points:Number(dd.toFixed(4)), max_consecutive_losses:maxStreak };
}
function utcHour(value) { return new Date(value).getUTCHours(); }
function buildSignals(c, closes, e9, e20, e50, r2, r14, a14, cfg) {
  const i=cfg.i, close=closes[i], prev=closes[i-1], bar=c[i], a=a14[i];
  if (!Number.isFinite(a) || a<=0 || i<cfg.minLookback) return null;
  const prior=c.slice(i-cfg.lookback,i);
  const high=Math.max(...prior.map(x=>x.bid_high)), low=Math.min(...prior.map(x=>x.bid_low));
  const priorHigh3=Math.max(...c.slice(i-3,i).map(x=>x.bid_high));
  const priorLow3=Math.min(...c.slice(i-3,i).map(x=>x.bid_low));
  const upper=mean(prior.map(x=>x.bid_close))+2*Math.sqrt(mean(prior.map(x=>(x.bid_close-mean(prior.map(y=>y.bid_close)))**2)));
  const lower=mean(prior.map(x=>x.bid_close))-2*Math.sqrt(mean(prior.map(x=>(x.bid_close-mean(prior.map(y=>y.bid_close)))**2)));
  const body=close-Number(bar.bid_open);
  const hour=utcHour(bar.candle_at);
  switch(cfg.family) {
    case "ema_cross":
      if (e20[i]>e50[i] && e20[i-1]<=e50[i-1]) return "BUY";
      if (e20[i]<e50[i] && e20[i-1]>=e50[i-1]) return "SELL";
      break;
    case "donchian_breakout":
      if (close>high) return "BUY";
      if (close<low) return "SELL";
      break;
    case "bollinger_reversion":
      if (close<lower && r14[i]<30) return "BUY";
      if (close>upper && r14[i]>70) return "SELL";
      break;
    case "rsi2_reversion":
      if (r2[i]<cfg.threshold && close>prev) return "BUY";
      if (r2[i]>100-cfg.threshold && close<prev) return "SELL";
      break;
    case "ema_pullback":
      if (e20[i]>e50[i] && Number(bar.bid_low)<=e20[i]+0.15*a && close>priorHigh3 && body>0) return "BUY";
      if (e20[i]<e50[i] && Number(bar.bid_high)>=e20[i]-0.15*a && close<priorLow3 && body<0) return "SELL";
      break;
    case "atr_expansion":
      if ((Number(bar.bid_high)-Number(bar.bid_low))>cfg.rangeAtr*a && body>0.65*(Number(bar.bid_high)-Number(bar.bid_low)) && close>priorHigh3) return "BUY";
      if ((Number(bar.bid_high)-Number(bar.bid_low))>cfg.rangeAtr*a && body< -0.65*(Number(bar.bid_high)-Number(bar.bid_low)) && close<priorLow3) return "SELL";
      break;
    case "keltner_breakout":
      if (close>e20[i]+cfg.channelAtr*a) return "BUY";
      if (close<e20[i]-cfg.channelAtr*a) return "SELL";
      break;
    case "session_momentum":
      if (hour>=cfg.startHour && hour<cfg.endHour) {
        const mom=close-closes[i-cfg.momentum];
        if (mom>cfg.momentumAtr*a && close>e20[i]) return "BUY";
        if (mom< -cfg.momentumAtr*a && close<e20[i]) return "SELL";
      }
      break;
  }
  return null;
}

export async function runStrategyTournament(db, symbol="XAUUSD", timeframe="M5", maxRows=80000) {
  const intervalMs=timeframe==="M1"?60000:300000, pageSize=1000, pages=[];
  const latest=await db("aiva_historical_m1?symbol=eq."+encodeURIComponent(symbol)+
    "&timeframe=eq."+timeframe+"&select=candle_at&order=candle_at.desc&limit=1");
  if(!latest.length) return {available:false,warning:"Aucune bougie disponible."};
  const end=latest[0].candle_at;
  for(let offset=0;offset<maxRows;offset+=pageSize) {
    const batch=await db("aiva_historical_m1?symbol=eq."+encodeURIComponent(symbol)+
      "&timeframe=eq."+timeframe+
      "&select=candle_at,bid_open,bid_high,bid_low,bid_close,ask_open,ask_high,ask_low,ask_close,spread_close"+
      "&candle_at=lte."+encodeURIComponent(end)+"&order=candle_at.desc&limit="+pageSize+"&offset="+offset);
    pages.push(...batch); if(batch.length<pageSize) break;
  }
  const candles=pages.filter(x=>["bid_open","bid_high","bid_low","bid_close","ask_open","ask_high","ask_low","ask_close","spread_close"]
    .every(k=>Number.isFinite(Number(x[k])))).sort((a,b)=>Date.parse(a.candle_at)-Date.parse(b.candle_at)).slice(-maxRows)
    .map(x=>Object.fromEntries(Object.entries(x).map(([k,v])=>["candle_at", "candle_at"].includes(k)?[k,v]:[k,Number(v)])));
  if(candles.length<5000) return {available:false,data_points:candles.length,required:5000,warning:"Historique insuffisant."};
  const closes=candles.map(x=>x.bid_close), e9=ema(closes,9), e20=ema(closes,20), e50=ema(closes,50);
  const r2=rsi(closes,2), r14=rsi(closes,14), a14=atr(candles,14,intervalMs);
  const configs=[
    {family:"ema_cross",name:"EMA 20/50 crossover",lookback:50,minLookback:51},
    {family:"donchian_breakout",name:"Donchian breakout 20",lookback:20,minLookback:21},
    {family:"donchian_breakout",name:"Donchian breakout 50",lookback:50,minLookback:51},
    {family:"bollinger_reversion",name:"Bollinger 20 + RSI14",lookback:20,minLookback:21},
    {family:"rsi2_reversion",name:"RSI2 reversal threshold 5",lookback:20,minLookback:21,threshold:5},
    {family:"rsi2_reversion",name:"RSI2 reversal threshold 10",lookback:20,minLookback:21,threshold:10},
    {family:"ema_pullback",name:"EMA20/50 pullback",lookback:20,minLookback:51},
    {family:"atr_expansion",name:"ATR expansion 1.5x",lookback:20,minLookback:21,rangeAtr:1.5},
    {family:"atr_expansion",name:"ATR expansion 2.0x",lookback:20,minLookback:21,rangeAtr:2},
    {family:"keltner_breakout",name:"Keltner breakout 1.5 ATR",lookback:20,minLookback:51,channelAtr:1.5},
    {family:"keltner_breakout",name:"Keltner breakout 2 ATR",lookback:20,minLookback:51,channelAtr:2},
    {family:"session_momentum",name:"Session momentum 07-20 UTC",lookback:20,minLookback:51,startHour:7,endHour:20,momentum:3,momentumAtr:0.8},
    {family:"session_momentum",name:"Session momentum 12-16 UTC",lookback:20,minLookback:51,startHour:12,endHour:16,momentum:3,momentumAtr:0.8}
  ];
  const split=Math.floor(candles.length*0.7), results=[];\n  let gapRejectedSignals=0;
  for(const cfg of configs) {
    const trades=[]; let nextAllowed=cfg.minLookback;
    for(let i=cfg.minLookback;i<candles.length-7;i++) {
      if(i<nextAllowed) continue;
      const direction=buildSignals(candles,closes,e9,e20,e50,r2,r14,a14,{...cfg,i});
      if(!direction) continue;
      const entryBar=candles[i+1], spread=entryBar.ask_open-entryBar.bid_open;
      if(!(spread>0&&spread<=1.5)) continue;
      const buy=direction==="BUY", atrNow=a14[i];
      const sl=Math.max(3,Math.min(8,atrNow*1.2)), tp=sl*1.5, horizon=6;
      const entry=(buy?entryBar.ask_open:entryBar.bid_open)+(buy?0.05:-0.05);
      let exitIndex=i+1+horizon-1, rawExit=buy?candles[exitIndex].bid_close:candles[exitIndex].ask_close, reason="time_exit", ambiguous=false;
      for(let j=i+1;j<=exitIndex;j++) {
        const bar=candles[j], stop=buy?bar.bid_low<=entry-sl:bar.ask_high>=entry+sl;
        const target=buy?bar.bid_high>=entry+tp:bar.ask_low<=entry-tp;
        if(stop&&target){exitIndex=j;rawExit=buy?entry-sl:entry+sl;reason="ambiguous_stop_first";ambiguous=true;break;}
        if(stop){exitIndex=j;rawExit=buy?entry-sl:entry+sl;reason="stop";break;}
        if(target){exitIndex=j;rawExit=buy?entry+tp:entry-tp;reason="target";break;}
      }
      // Force-flat any training trade at the final in-sample candle; never let an IS position leak into OOS.
      if (i < split && exitIndex >= split) {
        exitIndex = split - 1;
        rawExit = buy ? candles[exitIndex].bid_close : candles[exitIndex].ask_close;
        reason = "forced_flat_at_train_test_boundary";
      }
      const exit=rawExit+(buy?-0.05:0.05), grossPnl=(buy?1:-1)*(exit-entry), pnl=grossPnl-0.20;
      trades.push({direction,signal_time:candles[i].candle_at,entry_time:entryBar.candle_at,exit_time:candles[exitIndex].candle_at,
        entry_price:Number(entry.toFixed(4)),exit_price:Number(exit.toFixed(4)),gross_pnl_points:Number(grossPnl.toFixed(4)),pnl_points:Number(pnl.toFixed(4)),
        exit_reason:reason,same_bar_ambiguity:ambiguous,sample:i<split?"in_sample":"out_of_sample"});
      nextAllowed=exitIndex+1;
    }
    const is=trades.filter(t=>t.sample==="in_sample"), oos=trades.filter(t=>t.sample==="out_of_sample");
    const byDirection=list=>({BUY:metrics(list.filter(t=>t.direction==="BUY")),SELL:metrics(list.filter(t=>t.direction==="SELL"))});
    const costSensitivity = Object.fromEntries([
      {name:"base",slippage:0.05,commission:0.20},
      {name:"moderate",slippage:0.10,commission:0.20},
      {name:"severe",slippage:0.20,commission:0.30}
    ].map(scenario => [scenario.name, {
      assumptions:{slippage_each_side_points:scenario.slippage,commission_round_trip_points:scenario.commission},
      overall:metrics(trades.map(t=>({...t,pnl_points:Number((t.gross_pnl_points-2*scenario.slippage-scenario.commission).toFixed(4))}))),
      out_of_sample:metrics(oos.map(t=>({...t,pnl_points:Number((t.gross_pnl_points-2*scenario.slippage-scenario.commission).toFixed(4))})))
    }]));
    results.push({name:cfg.name,method:"aiva_strategy_tournament_v1_"+cfg.family+"_"+cfg.name.toLowerCase().replace(/[^a-z0-9]+/g,"_"),
      config:cfg,overall:metrics(trades),in_sample:metrics(is),out_of_sample:metrics(oos),cost_sensitivity:costSensitivity,
      by_direction:{overall:byDirection(trades),in_sample:byDirection(is),out_of_sample:byDirection(oos)},
      assumptions:{source:"Dukascopy native Bid/Ask M5",horizon_bars:6,horizon_minutes:30,atr_stop_multiple:1.2,
        stop_min_points:3,stop_max_points:8,target_r_multiple:1.5,spread_max_points:1.5,
        slippage_each_side_points:0.05,commission_round_trip_points:0.20,one_position_per_strategy:true,
        chronological_split:"70/30",entry:"next candle open",same_bar_rule:"stop first"},
      warnings:[...(trades.length<30?["Moins de 30 trades au total : échantillon faible."]:[]),
        ...(oos.length<20?["Moins de 20 trades OOS : validation insuffisante."]:[]),
        ...(trades.some(t=>t.same_bar_ambiguity)?["Ambiguïté intrabougie : stop prioritaire, résultat conservateur."]:[]),
        "Recherche exploratoire multi-tests : risque élevé de sélection fortuite et de surapprentissage.",
        "Les coûts sont des hypothèses ; ils doivent être remplacés par les frais et le glissement du courtier réel.",
        "Aucune stratégie de cette compétition n'est activée dans le moteur autonome."],
      trades:trades.slice(-250)});
  }
  results.sort((a,b)=>(b.out_of_sample.expectancy_points??-999)-(a.out_of_sample.expectancy_points??-999));
  return {available:true,symbol,timeframe,strategy:"AIVA_Independent_Strategy_Tournament",method:"aiva_strategy_tournament_v1",
    data_points:candles.length,rejected_invalid_candles:rejectedCandles,gap_rejected_signals:gapRejectedSignals,first_tick_at:candles[0].candle_at,last_tick_at:candles.at(-1).candle_at,
    train_boundary_at:candles[split]?.candle_at||null,configurations_tested:results.length,
    ranking_criterion:"OOS expectancy after Bid/Ask spread, slippage and commission; report PF, drawdown and trade count; no automatic promotion.",
    results};
}
