import os from "node:os";
import { performance } from "node:perf_hooks";
import { runDeterministicMonteCarlo } from "../src/monte-carlo.js";

const returns = Array.from({ length: 1200 }, (_, i) =>
  Math.sin(i * 0.173) * 0.00018 + Math.cos(i * 0.037) * 0.00007
);
const input = {
  returns,
  current: 2600,
  spread: 0.3,
  sigma: 0.0002,
  horizon: 30,
  blockLength: 3,
  seedMaterial: "XAUUSD|railway-isolated-benchmark-v1"
};
const sizes = [100, 500, 1000, 5000];
const warmups = 5;
const iterations = 30;

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

const cpu = os.cpus()[0] ?? {};
console.log(JSON.stringify({
  event: "benchmark_start",
  benchmark: "AIVA deterministic Monte Carlo",
  isolation: "standalone Railway project; no Supabase, Live-Rates, API keys or production writes",
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  cpu_model: cpu.model ?? "unknown",
  logical_cpus: os.cpus().length,
  total_memory_mb: Math.round(os.totalmem() / 1024 / 1024),
  warmups,
  iterations,
  return_sample_size: returns.length,
  horizon: input.horizon,
  block_length: input.blockLength
}));

for (const size of sizes) {
  const sampleSizes = sizes.filter(value => value <= size);
  for (let i = 0; i < warmups; i++) {
    runDeterministicMonteCarlo({ ...input, sampleSizes });
  }
  const timings = [];
  let result;
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    result = runDeterministicMonteCarlo({ ...input, sampleSizes });
    timings.push(performance.now() - start);
  }
  if (!result?.available || result.largest_simulations !== size) {
    throw new Error(`Monte Carlo benchmark failed for sample size ${size}`);
  }
  console.log(JSON.stringify({
    event: "benchmark_result",
    simulations: size,
    median_ms: Number(percentile(timings, 0.5).toFixed(3)),
    p95_ms: Number(percentile(timings, 0.95).toFixed(3)),
    min_ms: Number(Math.min(...timings).toFixed(3)),
    max_ms: Number(Math.max(...timings).toFixed(3)),
    deterministic_seed: result.seed,
    result_available: result.available
  }));
}
console.log(JSON.stringify({
  event: "benchmark_complete",
  note: "Synthetic deterministic returns; compute latency only, not strategy accuracy or trading profitability."
}));
