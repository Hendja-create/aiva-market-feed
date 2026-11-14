import os from "node:os";
import { performance } from "node:perf_hooks";
import { runDeterministicMonteCarlo } from "../src/monte-carlo.js";

const returns = Array.from({ length: 1200 }, (_, i) => Math.sin(i * 0.173) * 0.00018 + Math.cos(i * 0.037) * 0.00007);
const input = { returns, current: 2600, spread: 0.3, sigma: 0.0002, horizon: 30, blockLength: 3, seedMaterial: "XAUUSD|railway-concurrent-load-v1", sampleSizes: [100, 5000] };
const concurrencyLevels = [1, 2, 4, 8, 16, 32];
const burstsPerLevel = 8;
function percentile(values, p) { const sorted = [...values].sort((a,b) => a-b); return sorted[Math.min(sorted.length-1, Math.ceil(p*sorted.length)-1)]; }
function stats(values) { return { p50_ms: Number(percentile(values,0.5).toFixed(3)), p95_ms: Number(percentile(values,0.95).toFixed(3)), max_ms: Number(Math.max(...values).toFixed(3)) }; }
const cpu = os.cpus()[0] ?? {};
console.log(JSON.stringify({ event:"load_test_start", benchmark:"AIVA Monte Carlo single-process burst contention", isolation:"standalone Railway benchmark project; synthetic inputs only; no external services", node:process.version, platform:process.platform, arch:process.arch, cpu_model:cpu.model ?? "unknown", logical_cpus_visible:os.cpus().length, return_sample_size:returns.length, simulations_per_request:5000, horizon:input.horizon, concurrency_levels:concurrencyLevels, bursts_per_level:burstsPerLevel }));
for (const concurrency of concurrencyLevels) {
  const queueLatencies = []; const serviceTimes = []; const levelStart = performance.now(); let seed = null; let completed = 0;
  for (let burst=0; burst<burstsPerLevel; burst++) {
    const scheduledAt = performance.now();
    const jobs = Array.from({length:concurrency}, (_, requestIndex) => new Promise((resolve,reject) => {
      setImmediate(() => { const startedAt=performance.now(); try {
        const result=runDeterministicMonteCarlo(input); const finishedAt=performance.now();
        if (!result?.available || result.largest_simulations!==5000 || result.baseline_simulations!==100) throw new Error("Invalid Monte Carlo result under load");
        if (seed===null) seed=result.seed; if (seed!==result.seed) throw new Error("Non-deterministic seed for identical inputs");
        queueLatencies.push(finishedAt-scheduledAt); serviceTimes.push(finishedAt-startedAt); completed++; resolve({requestIndex,burst});
      } catch(error) { reject(error); } });
    }));
    await Promise.all(jobs);
  }
  const elapsedMs=performance.now()-levelStart;
  console.log(JSON.stringify({ event:"load_test_result", concurrency, bursts:burstsPerLevel, requests_completed:completed, elapsed_ms:Number(elapsedMs.toFixed(3)), throughput_requests_per_second:Number((completed/(elapsedMs/1000)).toFixed(2)), queue_plus_compute_latency:stats(queueLatencies), compute_service_time:stats(serviceTimes), deterministic_seed:seed }));
}
console.log(JSON.stringify({ event:"load_test_complete", note:"Concurrent arrivals are queued on one Node.js event loop. Measures synchronous CPU contention and queue latency, not multi-process scaling, HTTP/network latency, strategy accuracy, or profitability." }));
