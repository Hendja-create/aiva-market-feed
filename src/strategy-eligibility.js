const MIN_OOS_TRADES = 100;
const MIN_DATA_POINTS = 5000;
const MIN_PROFIT_FACTOR = 1.2;
const MAX_RESULT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const RETIRED_STRATEGY_METHODS = new Set(["aiva_inverse_keltner_1_5_atr_v1"]);
function finite(value) { const n=Number(value); return Number.isFinite(n)?n:null; }
export function assessBacktestEligibility(row, nowMs=Date.now()) {
 const oos=row?.out_of_sample||{}, trades=finite(oos.trades), pf=finite(oos.profit_factor), exp=finite(oos.expectancy_points), net=finite(oos.net_pnl_points), points=finite(row?.data_points);
 const last=Date.parse(row?.last_tick_at||""), age=nowMs-last;
 const warnings=Array.isArray(row?.warnings)?row.warnings.join(" ").toLowerCase():String(row?.warnings||"").toLowerCase();
 const failures=[];
 if(!row?.method)failures.push("missing_strategy_method");
 if(RETIRED_STRATEGY_METHODS.has(row?.method))failures.push("strategy_retired");
 if(!Number.isFinite(last)||age<0||age>MAX_RESULT_AGE_MS)failures.push("stale_or_invalid_backtest");
 if(points===null||points<MIN_DATA_POINTS)failures.push("insufficient_history");
 if(trades===null||trades<MIN_OOS_TRADES)failures.push("insufficient_oos_sample");
 if(pf===null||pf<MIN_PROFIT_FACTOR)failures.push("oos_profit_factor_below_1_20");
 if(exp===null||exp<=0)failures.push("non_positive_oos_expectancy");
 if(net===null||net<=0)failures.push("non_positive_oos_net_pnl");
 if(/selection bias|selected on|exploratory|biais de sélection|non indépendant|overlap|overlapping|incomplete|plafond/.test(warnings))failures.push("methodology_warning");
 return {eligible:failures.length===0,method:row?.method||null,metrics:{oos_trades:trades,profit_factor:pf,expectancy_points:exp,net_pnl_points:net,data_points:points},failures};
}
export async function selectEligiblePaperStrategy(db,symbol,nowMs=Date.now()) {
 const rows=await db("aiva_backtest_runs?symbol=eq."+encodeURIComponent(symbol)+"&select=*&order=last_tick_at.desc&limit=500");
 const assessed=(Array.isArray(rows)?rows:[]).map(row=>({row,assessment:assessBacktestEligibility(row,nowMs)}));
 const eligible=assessed.filter(x=>x.assessment.eligible).sort((a,b)=>b.assessment.metrics.expectancy_points-a.assessment.metrics.expectancy_points);
 if(!eligible.length)return {selected:false,decision:"NO_TRADE",reason:"no_strategy_meets_independent_oos_thresholds",evaluated:assessed.length,rejected:assessed.slice(0,25).map(x=>({method:x.assessment.method,failures:x.assessment.failures,metrics:x.assessment.metrics}))};
 const best=eligible[0]; return {selected:true,decision:"STRATEGY_SELECTED",strategy:best.assessment.method,metrics:best.assessment.metrics,evaluated:assessed.length};
}
