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
  seedMaterial: "XAUUSD|isolated-github-actions-benchmark"
};
const sizes = [100, 500, 1000, 5000];
const warmups = 3;
const iterations = 20;

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

console.log(JSON.stringify({
  benchmark: "AIVA deterministic Monte Carlo",
  environment: "GitHub Actions isolated runner (not Railway)",
  node: process.version,
  cpu: process.env.RUNNER_ARCH ?? "unknown",
  warmups,
  iterations,
  return_sample_size: returns.length
}));

for (const size of sizes) {
  const sampleSizes = sizes.filter(value => value <= size);
  for (let i = 0; i < warmups; i++) {
    runDeterministicMonteCarlo({ ...input, sampleSizes });
  }

  const timings = [];
  const heapBefore = process.memoryUsage().heapUsed;
  let result;
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    result = runDeterministicMonteCarlo({ ...input, sampleSizes });
    timings.push(performance.now() - start);
  }
  const heapAfter = process.memoryUsage().heapUsed;

  if (!result?.available || result.largest_simulations !== size) {
    throw new Error(`Monte Carlo benchmark failed for sample size ${size}`);
  }

  console.log(JSON.stringify({
    simulations: size,
    median_ms: Number(percentile(timings, 0.5).toFixed(3)),
    p95_ms: Number(percentile(timings, 0.95).toFixed(3)),
    min_ms: Number(Math.min(...timings).toFixed(3)),
    max_ms: Number(Math.max(...timings).toFixed(3)),
    heap_delta_kb: Number(((heapAfter - heapBefore) / 1024).toFixed(1)),
    deterministic_seed: result.seed
  }));
}
