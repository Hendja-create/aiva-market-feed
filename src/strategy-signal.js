const PREFIX = "aiva_strategy_tournament_v1_";
const CONFIGS = {
  "ema_cross_ema_20_50_crossover": {family:"ema_cross",lookback:50,minLookback:51},
  "donchian_breakout_donchian_breakout_20": {family:"donchian_breakout",lookback:20,minLookback:21},
  "donchian_breakout_donchian_breakout_50": {family:"donchian_breakout",lookback:50,minLookback:51},
  "bollinger_reversion_bollinger_20_rsi14": {family:"bollinger_reversion",lookback:20,minLookback:21},
  "rsi2_reversion_rsi2_reversal_threshold_5": {family:"rsi2_reversion",lookback:20,minLookback:21,threshold:5},
  "rsi2_reversion_rsi2_reversal_threshold_10": {family:"rsi2_reversion",lookback:20,minLookback:21,threshold:10},
  "ema_pullback_ema20_50_pullback": {family:"ema_pullback",lookback:20,minLookback:51},
  "atr_expansion_atr_expansion_1_5x": {family:"atr_expansion",lookback:20,minLookback:21,rangeAtr:1.5},
  "atr_expansion_atr_expansion_2_0x": {family:"atr_expansion",lookback:20,minLookback:21,rangeAtr:2},
  "keltner_breakout_keltner_breakout_1_5_atr": {family:"keltner_breakout",lookback:20,minLookback:51,channelAtr:1.5},
  "keltner_breakout_keltner_breakout_2_atr": {family:"keltner_breakout",lookback:20,minLookback:51,channelAtr:2},
  "session_momentum_session_momentum_07_20_utc": {family:"session_momentum",lookback:20,minLookback:51,startHour:7,endHour:20,momentum:3,momentumAtr:0.8},
  "session_momentum_session_momentum_12_16_utc": {family:"session_momentum",lookback:20,minLookback:51,startHour:12,endHour:16,momentum:3,momentumAtr:0.8}
};
const mean = values => values.length ? values.reduce((a,b)=>a+b,0)/values.length : 0;
function ema(values, period) {
  const out=Array(values.length).fill(null), k=2/(period+1); let value=null;
  for(let i=0;i<values.length;i++){value=value===null?values[i]:values[i]*k+value*(1-k);out[i]=value;}
  return out;
}
function rsi(values, period) {
  const out=Array(values.length).fill(null);
  for(let i=period;i<values.length;i++){let up=0,down=0;for(let j=i-period+1;j<=i;j++){const d=values[j]-values[j-1];if(d>0)up+=d;else down-=d;}out[i]=down===0?100:100-100/(1+up/down);}
  return out;
}
function atr(candles, period=14) {
  const tr=candles.map((x,i)=>i===0?x.bid_high-x.bid_low:Math.max(x.bid_high-x.bid_low,Math.abs(x.bid_high-candles[i-1].bid_close),Math.abs(x.bid_low-candles[i-1].bid_close)));
  const out=Array(candles.length).fill(null);
  for(let i=period;i<candles.length;i++)out[i]=mean(tr.slice(i-period+1,i+1));
  return out;
}
function evaluate(c, cfg) {
  const closes=c.map(x=>x.bid_close), i=c.length-1, e20=ema(closes,20), e50=ema(closes,50), r2=rsi(closes,2), r14=rsi(closes,14), a14=atr(c,14);
  const close=closes[i], prev=closes[i-1], bar=c[i], a=a14[i];
  if(!Number.isFinite(a)||a<=0||i<cfg.minLookback)return null;
  const prior=c.slice(i-cfg.lookback,i), high=Math.max(...prior.map(x=>x.bid_high)), low=Math.min(...prior.map(x=>x.bid_low));
  const high3=Math.max(...c.slice(i-3,i).map(x=>x.bid_high)), low3=Math.min(...c.slice(i-3,i).map(x=>x.bid_low));
  const avg=mean(prior.map(x=>x.bid_close)), variance=mean(prior.map(x=>(x.bid_close-avg)**2));
  const upper=avg+2*Math.sqrt(variance), lower=avg-2*Math.sqrt(variance), body=close-bar.bid_open, hour=new Date(bar.candle_at).getUTCHours();
  switch(cfg.family){
    case "ema_cross": if(e20[i]>e50[i]&&e20[i-1]<=e50[i-1])return "BUY";if(e20[i]<e50[i]&&e20[i-1]>=e50[i-1])return "SELL";break;
    case "donchian_breakout": if(close>high)return "BUY";if(close<low)return "SELL";break;
    case "bollinger_reversion": if(close<lower&&r14[i]<30)return "BUY";if(close>upper&&r14[i]>70)return "SELL";break;
    case "rsi2_reversion": if(r2[i]<cfg.threshold&&close>prev)return "BUY";if(r2[i]>100-cfg.threshold&&close<prev)return "SELL";break;
    case "ema_pullback": if(e20[i]>e50[i]&&bar.bid_low<=e20[i]+.15*a&&close>high3&&body>0)return "BUY";if(e20[i]<e50[i]&&bar.bid_high>=e20[i]-.15*a&&close<low3&&body<0)return "SELL";break;
    case "atr_expansion": {const range=bar.bid_high-bar.bid_low;if(range>cfg.rangeAtr*a&&body>.65*range&&close>high3)return "BUY";if(range>cfg.rangeAtr*a&&body<-.65*range&&close<low3)return "SELL";break;}
    case "keltner_breakout": if(close>e20[i]+cfg.channelAtr*a)return "BUY";if(close<e20[i]-cfg.channelAtr*a)return "SELL";break;
    case "session_momentum": if(hour>=cfg.startHour&&hour<cfg.endHour){const mom=close-closes[i-cfg.momentum];if(mom>cfg.momentumAtr*a&&close>e20[i])return "BUY";if(mom< -cfg.momentumAtr*a&&close<e20[i])return "SELL";}break;
  }
  return null;
}
export async function generateSelectedStrategySignal(db,symbol,method,nowMs=Date.now()) {
  if(typeof method!=="string"||!method.startsWith(PREFIX))return {available:false,direction:null,reason:"unsupported_strategy_method",method};
  const key=method.slice(PREFIX.length), cfg=CONFIGS[key];
  if(!cfg)return {available:false,direction:null,reason:"unsupported_strategy_configuration",method};
  const rows=await db("aiva_historical_m1?symbol=eq."+encodeURIComponent(symbol)+"&timeframe=eq.M5&select=candle_at,bid_open,bid_high,bid_low,bid_close&order=candle_at.desc&limit=100");
  const candles=rows.slice().reverse().map(row=>Object.fromEntries(["bid_open","bid_high","bid_low","bid_close"].map(k=>[k,Number(row[k])]).concat([["candle_at",row.candle_at]])));
  if(candles.some(c=>![c.bid_open,c.bid_high,c.bid_low,c.bid_close].every(Number.isFinite)||c.bid_low>c.bid_high||c.bid_open<=0))return {available:false,direction:null,reason:"invalid_candle_data",method};
  // Weekend/session gaps are allowed only before the contiguous trailing sample.
  let start=candles.length-1;
  while(start>0&&Date.parse(candles[start].candle_at)-Date.parse(candles[start-1].candle_at)===300000)start--;
  const continuous=candles.slice(start);
  if(continuous.length<60)return {available:false,direction:null,reason:"insufficient_contiguous_m5_history",method,rows:continuous.length};
  const candleAt=Date.parse(continuous.at(-1).candle_at), closedAt=candleAt+300000, age=nowMs-closedAt;
  if(!Number.isFinite(candleAt)||age<0||age>360000)return {available:false,direction:null,reason:"stale_or_unclosed_m5_candle",method,candle_at:continuous.at(-1)?.candle_at,closed_at:new Date(closedAt).toISOString(),age_ms:age};
  const direction=evaluate(continuous,cfg);
  return {available:true,direction,decision:direction||"NO_TRADE",method,signal_candle_at:continuous.at(-1).candle_at,signal_candle_closed_at:new Date(closedAt).toISOString(),timeframe:"M5",entry_rule:"next fresh live Bid/Ask quote after closed signal candle",reason:direction?"selected_strategy_condition_met":"selected_strategy_condition_not_met"};
}
