import os from "node:os";
import { performance } from "node:perf_hooks";
import { MonteCarloWorkerPool } from "../src/monte-carlo-worker-pool.js";
const returns=Array.from({length:1200},(_,i)=>Math.sin(i*0.173)*0.00018+Math.cos(i*0.037)*0.00007);
const input={returns,current:2600,spread:0.3,sigma:0.0002,horizon:30,blockLength:3,seedMaterial:"XAUUSD|worker-pool-load-v1",sampleSizes:[100,5000]};
const levels=[1,2,4,8,16,32]; const bursts=8;
function pct(v,p){const s=[...v].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.ceil(p*s.length)-1)];}
function stats(v){return {p50_ms:Number(pct(v,.5).toFixed(3)),p95_ms:Number(pct(v,.95).toFixed(3)),max_ms:Number(Math.max(...v).toFixed(3))};}
const pool=new MonteCarloWorkerPool({size:2,maxQueue:64});
const cpu=os.cpus()[0]??{};
console.log(JSON.stringify({event:"worker_pool_benchmark_start",workers:2,max_queue:64,node:process.version,platform:process.platform,cpu_model:cpu.model??"unknown",logical_cpus_visible:os.cpus().length,simulations_per_request:5000,return_sample_size:returns.length,levels,bursts,synthetic_inputs:true,external_services:false}));
try {
 for(const concurrency of levels){const latencies=[];const elapsedStart=performance.now();let completed=0;let deterministic=true;let seed=null;
  for(let burst=0;burst<bursts;burst++){const started=performance.now();const tasks=Array.from({length:concurrency},()=>pool.run(input).then(result=>{if(!result?.available||result.largest_simulations!==5000||result.baseline_simulations!==100)throw new Error("invalid worker result");if(seed===null)seed=result.seed;else if(seed!==result.seed)deterministic=false;latencies.push(performance.now()-started);completed++;return result;}));await Promise.all(tasks);}
  const elapsed=performance.now()-elapsedStart;
  console.log(JSON.stringify({event:"worker_pool_result",concurrency,requests_completed:completed,elapsed_ms:Number(elapsed.toFixed(3)),throughput_requests_per_second:Number((completed/(elapsed/1000)).toFixed(2)),queue_plus_compute_latency:stats(latencies),deterministic,worker_status:pool.getStatus()}));
 }
 const saturationPool=new MonteCarloWorkerPool({size:1,maxQueue:1});
 try {const heavy={...input,returns:Array.from({length:1200},(_,i)=>Math.sin(i*.17)*.0001),horizon:100,sampleSizes:[100,20000]};const first=saturationPool.run(heavy);const second=saturationPool.run(heavy);let rejected=false;try{await saturationPool.run(heavy);}catch(error){rejected=error.code==="AIVA_ANALYSIS_QUEUE_FULL";}await Promise.all([first,second]);console.log(JSON.stringify({event:"queue_saturation_check",bounded_queue_rejection_verified:rejected,status:saturationPool.getStatus()}));} finally {await saturationPool.close();}
 console.log(JSON.stringify({event:"worker_pool_benchmark_complete",note:"Single Railway container with two Node worker threads. Measures CPU-bound Monte Carlo and in-process queueing, not HTTP/network latency or multi-replica scaling."}));
} finally {await pool.close();}
