import test from "node:test";
import assert from "node:assert/strict";
import { generateSelectedStrategySignal } from "../src/strategy-signal.js";
test("refuses methods outside the explicitly supported tournament registry",async()=>{
 const r=await generateSelectedStrategySignal(async()=>[],"XAUUSD","unregistered_strategy");
 assert.equal(r.available,false);assert.equal(r.reason,"unsupported_strategy_method");
});
test("refuses an unknown tournament configuration",async()=>{
 const r=await generateSelectedStrategySignal(async()=>[],"XAUUSD","aiva_strategy_tournament_v1_unknown_method");
 assert.equal(r.available,false);assert.equal(r.reason,"unsupported_strategy_configuration");
});
test("does not emit a signal with insufficient history",async()=>{
 const db=async()=>Array.from({length:20},(_,i)=>({candle_at:new Date(Date.UTC(2026,0,1,0,i*5)).toISOString(),bid_open:100,bid_high:101,bid_low:99,bid_close:100}));
 const r=await generateSelectedStrategySignal(db,"XAUUSD","aiva_strategy_tournament_v1_ema_cross_ema_20_50_crossover");
 assert.equal(r.available,false);assert.equal(r.reason,"insufficient_closed_m5_history");
});

test("rejects the latest candle before its five-minute close",async()=>{
 const start=Date.parse("2026-01-01T00:00:00.000Z");
 const rows=Array.from({length:60},(_,i)=>({candle_at:new Date(start+i*300000).toISOString(),bid_open:100,bid_high:101,bid_low:99,bid_close:100}));
 const now=start+59*300000+240000;
 const r=await generateSelectedStrategySignal(async()=>rows.slice().reverse(),"XAUUSD","aiva_strategy_tournament_v1_ema_cross_ema_20_50_crossover",now);
 assert.equal(r.available,false);assert.equal(r.reason,"stale_or_unclosed_m5_candle");
});
test("accepts only a completed contiguous M5 sample and returns NO_TRADE without a setup",async()=>{
 const start=Date.parse("2026-01-01T00:00:00.000Z");
 const rows=Array.from({length:60},(_,i)=>({candle_at:new Date(start+i*300000).toISOString(),bid_open:100,bid_high:101,bid_low:99,bid_close:100}));
 const now=start+59*300000+300001;
 const r=await generateSelectedStrategySignal(async()=>rows.slice().reverse(),"XAUUSD","aiva_strategy_tournament_v1_ema_cross_ema_20_50_crossover",now);
 assert.equal(r.available,true);assert.equal(r.direction,null);assert.equal(r.decision,"NO_TRADE");
});
