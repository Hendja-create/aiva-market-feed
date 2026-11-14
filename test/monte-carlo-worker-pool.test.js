import test from "node:test";
import assert from "node:assert/strict";
import { MonteCarloWorkerPool } from "../src/monte-carlo-worker-pool.js";
import { runDeterministicMonteCarlo } from "../src/monte-carlo.js";

const input = { returns:[0.0002,-0.0001,0.0003,-0.0002,0.0001,0.00005], current:2600, spread:0.3, sigma:0.0002, horizon:30, blockLength:3, seedMaterial:"worker-pool-test" };

test("worker pool returns the same deterministic result as the inline engine", async () => {
  const pool = new MonteCarloWorkerPool({ size: 2, maxQueue: 4 });
  try {
    const [actual, expected] = await Promise.all([pool.run(input), Promise.resolve(runDeterministicMonteCarlo(input))]);
    assert.deepEqual(actual, expected);
    assert.deepEqual(pool.getStatus(), { workers:2, active:0, queued:0, max_queue:4, closed:false });
  } finally { await pool.close(); }
});

test("worker pool enforces a bounded waiting queue", async () => {
  const pool = new MonteCarloWorkerPool({ size: 1, maxQueue: 1 });
  const heavy = { ...input, returns:Array.from({length:1200},(_,i)=>Math.sin(i*0.17)*0.0001), horizon:100, sampleSizes:[100,20000] };
  try {
    const first = pool.run(heavy);
    const second = pool.run(heavy);
    await assert.rejects(pool.run(heavy), error => error.code === "AIVA_ANALYSIS_QUEUE_FULL");
    const [a,b] = await Promise.all([first,second]);
    assert.equal(a.available,true);
    assert.equal(b.available,true);
    assert.equal(pool.getStatus().queued,0);
  } finally { await pool.close(); }
});

test("worker pool rejects new work after close", async () => {
  const pool = new MonteCarloWorkerPool({ size:1, maxQueue:1 });
  await pool.close();
  await assert.rejects(pool.run(input), /closed/);
});
