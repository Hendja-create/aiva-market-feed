const STRATEGY_KEY = "inverse_keltner_1_5_atr_v1";
const COSTS = { spreadMax: 1.5, slippageEachSide: 0.05, commissionRoundTrip: 0.20 };
const mean = values => values.length ? values.reduce((a,b)=>a+b,0)/values.length : 0;
function ema(values, period) {
  const out=Array(values.length).fill(null), k=2/(period+1); let v=null;
  for(let i=0;i<values.length;i++){v=v===null?values[i]:values[i]*k+v*(1-k);out[i]=v;}
  return out;
}
function atr(candles, period=14) {
  const tr=candles.map((x,i)=>i===0?x.bid_high-x.bid_low:Math.max(x.bid_high-x.bid_low,
    Math.abs(x.bid_high-candles[i-1].bid_close),Math.abs(x.bid_low-candles[i-1].bid_close)));
  const out=Array(candles.length).fill(null);
  for(let i=period;i<candles.length;i++)out[i]=mean(tr.slice(i-period+1,i+1));
  return out;
}
function signalAt(candles, closes, ema20, atr14, i) {
  const a=atr14[i]; if(!Number.isFinite(a)||a<=0||!Number.isFinite(ema20[i]))return null;
  const close=closes[i], band=1.5*a;
  if(close>ema20[i]+band)return "BUY";
  if(close<ema20[i]-band)return "SELL";
  return null;
}
function stats(trades) {
  let net=0,peak=0,dd=0,grossWin=0,grossLoss=0,streak=0,maxStreak=0;
  for(const t of trades){net+=t.pnl_points;peak=Math.max(peak,net);dd=Math.max(dd,peak-net);
    if(t.pnl_points>0){grossWin+=t.pnl_points;streak=0;}else if(t.pnl_points<0){grossLoss-=t.pnl_points;streak++;maxStreak=Math.max(maxStreak,streak);}}
  const wins=trades.filter(t=>t.pnl_points>0).length;
  return {trades:trades.length,wins,losses:trades.filter(t=>t.pnl_points<0).length,
    win_rate:trades.length?Number((wins/trades.length).toFixed(4)):null,
    net_pnl_points:Number(net.toFixed(4)),profit_factor:grossLoss?Number((grossWin/grossLoss).toFixed(4)):null,
    expectancy_points:trades.length?Number((net/trades.length).toFixed(4)):null,
    max_drawdown_points:Number(dd.toFixed(4)),max_consecutive_losses:maxStreak};
}
function directionStats(trades){return {BUY:stats(trades.filter(t=>t.direction==="BUY")),SELL:stats(trades.filter(t=>t.direction==="SELL"))};}
async function loadCandles(db,symbol="XAUUSD",maxRows=80000){
  const latest=await db("aiva_historical_m1?symbol=eq."+encodeURIComponent(symbol)+"&timeframe=eq.M5&select=candle_at&order=candle_at.desc&limit=1");
  if(!latest.length)return [];
  const end=latest[0].candle_at,rows=[],page=1000;
  for(let offset=0;offset<maxRows;offset+=page){
    const batch=await db("aiva_historical_m1?symbol=eq."+encodeURIComponent(symbol)+
      "&timeframe=eq.M5&select=candle_at,bid_open,bid_high,bid_low,bid_close,ask_open,ask_high,ask_low,ask_close,spread_close"+
      "&candle_at=lte."+encodeURIComponent(end)+"&order=candle_at.desc&limit="+page+"&offset="+offset);
    rows.push(...batch);if(batch.length<page)break;
  }
  return rows.sort((a,b)=>Date.parse(a.candle_at)-Date.parse(b.candle_at)).slice(-maxRows)
    .map(x=>Object.fromEntries(Object.entries(x).map(([k,v])=>k==="candle_at"?[k,v]:[k,Number(v)])));
}
export async function runInverseKeltnerBacktest(db,symbol="XAUUSD",maxRows=80000){
  const candles=await loadCandles(db,symbol,maxRows);
  if(candles.length<5000)return {available:false,data_points:candles.length,required:5000};
  const closes=candles.map(x=>x.bid_close),e20=ema(closes,20),a14=atr(candles,14);
  const split=Math.floor(candles.length*0.7),trades=[];let nextAllowed=51;
  for(let i=51;i<candles.length-7;i++){
    if(i<nextAllowed)continue;
    const original=signalAt(candles,closes,e20,a14,i);if(!original)continue;
    const direction=original==="BUY"?"SELL":"BUY",entryBar=candles[i+1];
    const spread=entryBar.ask_open-entryBar.bid_open;if(!(spread>0&&spread<=COSTS.spreadMax))continue;
    const sl=Math.max(3,Math.min(8,a14[i]*1.2)),tp=sl*1.5,buy=direction==="BUY";
    const entry=(buy?entryBar.ask_open:entryBar.bid_open)+(buy?COSTS.slippageEachSide:-COSTS.slippageEachSide);
    let exitIndex=i+6,rawExit=buy?candles[exitIndex].bid_close:candles[exitIndex].ask_close,reason="time_exit",ambiguous=false;
    for(let j=i+1;j<=exitIndex;j++){
      const bar=candles[j],stop=buy?bar.bid_low<=entry-sl:bar.ask_high>=entry+sl;
      const target=buy?bar.bid_high>=entry+tp:bar.ask_low<=entry-tp;
      if(stop&&target){exitIndex=j;rawExit=buy?entry-sl:entry+sl;reason="ambiguous_stop_first";ambiguous=true;break;}
      if(stop){exitIndex=j;rawExit=buy?entry-sl:entry+sl;reason="stop";break;}
      if(target){exitIndex=j;rawExit=buy?entry+tp:entry-tp;reason="target";break;}
    }
    if(i<split&&exitIndex>=split){exitIndex=split-1;rawExit=buy?candles[exitIndex].bid_close:candles[exitIndex].ask_close;reason="forced_flat_at_boundary";}
    const exit=rawExit+(buy?-COSTS.slippageEachSide:COSTS.slippageEachSide);
    trades.push({direction,source_signal_direction:original,signal_time:candles[i].candle_at,entry_time:entryBar.candle_at,
      exit_time:candles[exitIndex].candle_at,pnl_points:Number(((buy?1:-1)*(exit-entry)-COSTS.commissionRoundTrip).toFixed(4)),
      exit_reason:reason,sample:i<split?"in_sample":"out_of_sample",same_bar_ambiguity:ambiguous});
    nextAllowed=exitIndex+1;
  }
  const is=trades.filter(t=>t.sample==="in_sample"),oos=trades.filter(t=>t.sample==="out_of_sample");
  return {available:true,strategy:"INVERSE_KELTNER_1_5_ATR",symbol,timeframe:"M5",data_points:candles.length,
    first_candle_at:candles[0].candle_at,last_candle_at:candles.at(-1).candle_at,
    rule:"Invert each Keltner 1.5 ATR breakout signal; same ATR stop, 1.5R target, 6-bar horizon.",
    assumptions:{source:"Dukascopy Bid/Ask M5",entry:"next candle open",sl_atr_multiple:1.2,sl_min:3,sl_max:8,
      target_r_multiple:1.5,horizon_bars:6,spread_max:COSTS.spreadMax,slippage_each_side:COSTS.slippageEachSide,
      commission_round_trip:COSTS.commissionRoundTrip,same_bar_rule:"stop first",chronological_split:"70/30"},
    overall:stats(trades),in_sample:stats(is),out_of_sample:stats(oos),
    by_direction:{overall:directionStats(trades),in_sample:directionStats(is),out_of_sample:directionStats(oos)},
    warnings:["Le signal choisi comme perdant a été sélectionné sur ce même historique : ce backtest inversé est exploratoire et biaisé par sélection.","Les coûts restent des hypothèses, pas les frais confirmés d'un courtier.","Aucune activation dans le moteur autonome."],
    trades:trades.slice(-500)};
}
function buildTickCandles(rows){
  const map=new Map();
  for(const r of rows){
    const stamp=Date.parse(r.provider_timestamp||r.received_at);if(!Number.isFinite(stamp))continue;
    const bucket=Math.floor(stamp/300000)*300000,key=new Date(bucket).toISOString();
    const bid=Number(r.bid),ask=Number(r.ask);if(!(bid>0&&ask>=bid))continue;
    let c=map.get(key);if(!c){c={candle_at:key,bid_open:bid,bid_high:bid,bid_low:bid,bid_close:bid,
      ask_open:ask,ask_high:ask,ask_low:ask,ask_close:ask,ticks:0,first_tick_at:new Date(stamp).toISOString()};map.set(key,c);}
    c.bid_high=Math.max(c.bid_high,bid);c.bid_low=Math.min(c.bid_low,bid);c.bid_close=bid;
    c.ask_high=Math.max(c.ask_high,ask);c.ask_low=Math.min(c.ask_low,ask);c.ask_close=ask;c.ticks++;
  }
  return [...map.values()].sort((a,b)=>Date.parse(a.candle_at)-Date.parse(b.candle_at));
}
export async function loadRecentQuoteTicks(db,symbol="XAUUSD",maxRows=25000,pageSize=1000){
  const rows=[];
  let beforeId=null,pages=0;
  const safeMax=Math.max(1,Math.floor(Number(maxRows)||25000));
  const safePage=Math.max(1,Math.min(1000,Math.floor(Number(pageSize)||1000)));
  while(rows.length<safeMax){
    const limit=Math.min(safePage,safeMax-rows.length);
    let path="market_quote_ticks?symbol=eq."+encodeURIComponent(symbol)+
      "&select=id,bid,ask,provider_timestamp,received_at&order=id.desc&limit="+limit;
    if(beforeId!==null)path+="&id=lt."+encodeURIComponent(beforeId);
    const batch=await db(path);
    if(!Array.isArray(batch))throw new Error("Supabase tick history returned a non-array response");
    if(!batch.length)break;
    if(beforeId!==null&&BigInt(batch[0].id)>=BigInt(beforeId)){
      throw new Error("Supabase tick pagination cursor did not advance");
    }
    rows.push(...batch);
    pages++;
    const nextCursor=String(batch.at(-1).id);
    if(!/^\d+$/.test(nextCursor))throw new Error("Supabase tick history contains an invalid row id");
    if(batch.length<limit)break;
    beforeId=nextCursor;
  }
  rows.sort((a,b)=>Date.parse(a.provider_timestamp||a.received_at)-Date.parse(b.provider_timestamp||b.received_at));
  return {rows,pages,reached_limit:rows.length>=safeMax};
}
async function upsertState(db,symbol,patch){
  await db("aiva_inverse_demo_state?on_conflict=strategy_key,symbol",{
    method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},
    body:JSON.stringify({strategy_key:STRATEGY_KEY,symbol,...patch,updated_at:new Date().toISOString()})});
}
export async function runInverseKeltnerDemoCycle(db,symbol="XAUUSD"){
  const history=await loadRecentQuoteTicks(db,symbol,25000,1000);
  const rows=history.rows;
  const last=rows.at(-1),lastTickAt=last?.provider_timestamp||last?.received_at;
  if(!lastTickAt||Date.now()-Date.parse(lastTickAt)>90000){
    await upsertState(db,symbol,{status:"WAITING_FOR_FRESH_FEED",last_tick_at:lastTickAt||null});
    return {status:"WAITING_FOR_FRESH_FEED",last_tick_at:lastTickAt||null,
      ticks_loaded:rows.length,tick_pages:history.pages,history_limit_reached:history.reached_limit};
  }
  const candles=buildTickCandles(rows);
  if(candles.length<60)return {status:"BUILDING_M5_HISTORY",candles:candles.length,required:60,
    ticks_loaded:rows.length,tick_pages:history.pages,history_limit_reached:history.reached_limit,
    first_tick_at:rows[0]?.provider_timestamp||rows[0]?.received_at,last_tick_at:lastTickAt};
  const currentBucket=Math.floor(Date.now()/300000)*300000;
  const closed=candles.filter(c=>Date.parse(c.candle_at)<currentBucket);
  const forming=candles.find(c=>Date.parse(c.candle_at)===currentBucket);
  if(closed.length<55||!forming)return {status:"WAITING_FOR_COMPLETE_CANDLES",closed:candles.length,has_forming:Boolean(forming)};
  const continuity=[...closed.slice(-54),forming];
  if(continuity.some((bar,i)=>i>0&&Date.parse(bar.candle_at)-Date.parse(continuity[i-1].candle_at)!==300000)){
    return {status:"WAITING_FOR_CONTIGUOUS_M5_CANDLES",checked:continuity.length};
  }
  let stateRows=await db("aiva_inverse_demo_state?strategy_key=eq."+STRATEGY_KEY+"&symbol=eq."+encodeURIComponent(symbol)+"&select=*&limit=1");
  let state=stateRows[0];
  if(!state){
    await upsertState(db,symbol,{last_processed_candle_at:closed.at(-1).candle_at,last_tick_at:lastTickAt,status:"DEMO_INITIALIZED"});
    return {status:"DEMO_INITIALIZED",baseline_candle_at:closed.at(-1).candle_at,closed_candles:closed.length};
  }
  const lastProcessedMs=state.last_processed_candle_at?Date.parse(state.last_processed_candle_at):0;
  const newestClosedMs=Date.parse(closed.at(-1).candle_at);
  const openRows=await db("aiva_inverse_demo_trades?strategy_key=eq."+STRATEGY_KEY+"&symbol=eq."+encodeURIComponent(symbol)+"&status=eq.OPEN&select=*&order=entry_at.desc&limit=1");
  if(lastProcessedMs && newestClosedMs-lastProcessedMs>600000){
    const staleOpen=openRows[0]||null;
    if(staleOpen){
      const buy=staleOpen.direction==="BUY",exit=(buy?Number(last.bid):Number(last.ask))+(buy?-COSTS.slippageEachSide:COSTS.slippageEachSide);
      const pnl=(buy?1:-1)*(exit-Number(staleOpen.entry_price))-COSTS.commissionRoundTrip;
      await db("aiva_inverse_demo_trades?id=eq."+staleOpen.id,{method:"PATCH",headers:{Prefer:"return=minimal"},
        body:JSON.stringify({status:"CLOSED",exit_at:lastTickAt,exit_price:Number(exit.toFixed(4)),
          pnl_points:Number(pnl.toFixed(4)),close_reason:"feed_gap_liquidation",closed_at:new Date().toISOString()})});
    }
    await upsertState(db,symbol,{last_processed_candle_at:closed.at(-1).candle_at,last_tick_at:lastTickAt,status:"RESYNCED_AFTER_FEED_GAP"});
    return {status:"RESYNCED_AFTER_FEED_GAP",closed_open_trade:Boolean(staleOpen),baseline_candle_at:closed.at(-1).candle_at};
  }
  let open=openRows[0]||null,closedCount=0;
  if(open){
    const entryMs=Date.parse(open.entry_at),lastExitCandle=open.context?.last_exit_candle_at?Date.parse(open.context.last_exit_candle_at):0;
    const after=closed.filter(c=>Date.parse(c.candle_at)>Math.max(Math.floor(entryMs/300000)*300000,lastExitCandle));
    for(const bar of after){
      const buy=open.direction==="BUY",stop=buy?bar.bid_low<=Number(open.stop_price):bar.ask_high>=Number(open.stop_price);
      const target=buy?bar.bid_high>=Number(open.target_price):bar.ask_low<=Number(open.target_price);
      const held=Number(open.context?.bars_held||0)+1;
      let exit=null,reason=null;
      if(stop&&target){exit=buy?Number(open.stop_price):Number(open.stop_price);reason="ambiguous_stop_first";}
      else if(stop){exit=Number(open.stop_price);reason="stop";}
      else if(target){exit=Number(open.target_price);reason="target";}
      else if(held>=6){exit=buy?bar.bid_close:bar.ask_close;reason="time_exit";}
      if(exit!==null){
        exit+=buy?-COSTS.slippageEachSide:COSTS.slippageEachSide;
        const pnl=(buy?1:-1)*(exit-Number(open.entry_price))-COSTS.commissionRoundTrip;
        await db("aiva_inverse_demo_trades?id=eq."+open.id,{method:"PATCH",headers:{Prefer:"return=minimal"},
          body:JSON.stringify({status:"CLOSED",exit_at:new Date(Date.parse(bar.candle_at)+300000).toISOString(),
            exit_price:Number(exit.toFixed(4)),pnl_points:Number(pnl.toFixed(4)),close_reason:reason,
            closed_at:new Date().toISOString(),context:{...open.context,bars_held:held,last_exit_candle_at:bar.candle_at}})});
        closedCount++;open=null;
        await upsertState(db,symbol,{last_processed_candle_at:bar.candle_at,last_tick_at:lastTickAt,status:"DEMO_RUNNING"});
        state.last_processed_candle_at=bar.candle_at;
        break;
      }else{
        await db("aiva_inverse_demo_trades?id=eq."+open.id,{method:"PATCH",headers:{Prefer:"return=minimal"},
          body:JSON.stringify({context:{...open.context,bars_held:held}})});
        open={...open,context:{...open.context,bars_held:held,last_exit_candle_at:bar.candle_at}};
      }
    }
    if(open){
      const buy=open.direction==="BUY",bid=Number(last.bid),ask=Number(last.ask);
      const hit=buy?bid<=Number(open.stop_price)||bid>=Number(open.target_price):
        ask>=Number(open.stop_price)||ask<=Number(open.target_price);
      if(hit){
        const reason=buy?(bid<=Number(open.stop_price)?"stop":"target"):(ask>=Number(open.stop_price)?"stop":"target");
        const exit=buy?bid-COSTS.slippageEachSide:ask+COSTS.slippageEachSide;
        const pnl=(buy?1:-1)*(exit-Number(open.entry_price))-COSTS.commissionRoundTrip;
        await db("aiva_inverse_demo_trades?id=eq."+open.id,{method:"PATCH",headers:{Prefer:"return=minimal"},
          body:JSON.stringify({status:"CLOSED",exit_at:lastTickAt,exit_price:Number(exit.toFixed(4)),pnl_points:Number(pnl.toFixed(4)),
            close_reason:reason,closed_at:new Date().toISOString()})});
        closedCount++;open=null;
        await upsertState(db,symbol,{last_processed_candle_at:closed.at(-1).candle_at,last_tick_at:lastTickAt,status:"DEMO_RUNNING"});
        state.last_processed_candle_at=closed.at(-1).candle_at;
      }
    }
  }
  let processed=0,opened=null;
  const closes=closed.map(c=>c.bid_close),e20=ema(closes,20),a14=atr(closed,14);
  const lastProcessed=state.last_processed_candle_at?Date.parse(state.last_processed_candle_at):0;
  for(let i=51;i<closed.length;i++){
    const signal=closed[i];
    if(Date.parse(signal.candle_at)<=lastProcessed)continue;
    if(!open){
      const source=signalAt(closed,closes,e20,a14,i);
      const next=closed[i+1]&&Date.parse(closed[i+1].candle_at)>Date.parse(signal.candle_at)?closed[i+1]:forming;
      if(source&&next){
        const direction=source==="BUY"?"SELL":"BUY",buy=direction==="BUY";
        const spread=Number(last.ask)-Number(last.bid),atrNow=a14[i];
        if(spread>0&&spread<=COSTS.spreadMax){
          const sl=Math.max(3,Math.min(8,atrNow*1.2)),tp=sl*1.5;
          const entry=(buy?Number(last.ask):Number(last.bid))+(buy?COSTS.slippageEachSide:-COSTS.slippageEachSide);
          const row=await db("aiva_inverse_demo_trades",{method:"POST",headers:{Prefer:"return=representation"},
            body:JSON.stringify({strategy_key:STRATEGY_KEY,symbol,source_signal_direction:source,direction,
              signal_candle_at:signal.candle_at,entry_at:lastTickAt,
              entry_price:Number(entry.toFixed(4)),stop_price:Number((buy?entry-sl:entry+sl).toFixed(4)),
              target_price:Number((buy?entry+tp:entry-tp).toFixed(4)),atr_points:Number(atrNow.toFixed(4)),
              context:{source_strategy:"Keltner breakout EMA20 +/- 1.5 ATR",inversion:"BUY<->SELL",
                sl_atr_multiple:1.2,target_r_multiple:1.5,horizon_bars:6,bars_held:0,
                costs:COSTS,mode:"paper_demo_only"}})});
          opened=row?.[0]||{direction,entry_price:entry};open=opened;
        }
      }
    }
    await upsertState(db,symbol,{last_processed_candle_at:signal.candle_at,last_tick_at:lastTickAt,status:open?"DEMO_POSITION_OPEN":"DEMO_RUNNING"});
    processed++;
    if(open)break;
  }
  if(processed===0)await upsertState(db,symbol,{last_tick_at:lastTickAt,status:open?"DEMO_POSITION_OPEN":"DEMO_RUNNING"});
  return {status:open?"DEMO_POSITION_OPEN":"DEMO_RUNNING",fresh_tick_at:lastTickAt,closed_candles:closed.length,
    processed_signals:processed,opened_trade:opened?{id:opened.id,direction:opened.direction,entry_price:opened.entry_price}:null,
    closed_trades:closedCount,open_trade:open?{id:open.id,direction:open.direction,entry_price:open.entry_price}:null};
}

export async function getInverseKeltnerDemoStatus(db,symbol="XAUUSD"){
  const state=await db("aiva_inverse_demo_state?strategy_key=eq."+STRATEGY_KEY+"&symbol=eq."+encodeURIComponent(symbol)+"&select=*&limit=1");
  const rows=await db("aiva_inverse_demo_trades?strategy_key=eq."+STRATEGY_KEY+"&symbol=eq."+encodeURIComponent(symbol)+"&status=eq.CLOSED&select=direction,pnl_points,close_reason,entry_at,exit_at&order=exit_at.desc&limit=1000");
  const all=rows.map(x=>({...x,pnl_points:Number(x.pnl_points||0)}));
  const open=await db("aiva_inverse_demo_trades?strategy_key=eq."+STRATEGY_KEY+"&symbol=eq."+encodeURIComponent(symbol)+"&status=eq.OPEN&select=*&order=entry_at.desc&limit=1");
  return {strategy:STRATEGY_KEY,symbol,mode:"PAPER_DEMO_ONLY",state:state[0]||null,
    closed_trades:stats(all),by_direction:directionStats(all),open_trade:open[0]||null,
    recent_trades:all.slice(0,30)};
}
