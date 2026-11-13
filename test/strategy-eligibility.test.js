import test from "node:test";
import assert from "node:assert/strict";
import { assessBacktestEligibility, selectEligiblePaperStrategy } from "../src/strategy-eligibility.js";
const valid={method:"candidate_v1",data_points:12000,last_tick_at:"2026-11-12T10:00:00.000Z",out_of_sample:{trades:120,profit_factor:1.35,expectancy_points:0.8,net_pnl_points:96},warnings:[]};
const now=Date.parse("2026-11-13T10:00:00.000Z");
test("accepts a recent sufficiently sampled positive OOS result",()=>assert.equal(assessBacktestEligibility(valid,now).eligible,true));
test("rejects weak, stale and methodologically warned results",()=>{
 assert.ok(assessBacktestEligibility({...valid,out_of_sample:{...valid.out_of_sample,profit_factor:0.9}},now).failures.includes("oos_profit_factor_below_1_20"));
 assert.ok(assessBacktestEligibility({...valid,last_tick_at:"2026-09-01T00:00:00.000Z"},now).failures.includes("stale_or_invalid_backtest"));
 assert.ok(assessBacktestEligibility({...valid,warnings:["Exploratory result with selection bias"]},now).failures.includes("methodology_warning"));
});
test("returns NO_TRADE when there are no stored candidates",async()=>{
 const r=await selectEligiblePaperStrategy(async()=>[],"XAUUSD",now);
 assert.equal(r.selected,false);
 assert.equal(r.decision,"NO_TRADE");
});
test("returns NO_TRADE when stored candidates fail the evidence thresholds",async()=>{
 const r=await selectEligiblePaperStrategy(async()=>[{...valid,out_of_sample:{...valid.out_of_sample,trades:2}}],"XAUUSD",now);
 assert.equal(r.selected,false);
 assert.equal(r.decision,"NO_TRADE");
});
