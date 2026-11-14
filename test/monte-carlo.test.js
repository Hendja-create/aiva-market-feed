import test from "node:test";
import assert from "node:assert/strict";
import { runDeterministicMonteCarlo } from "../src/monte-carlo.js";

const input = {
  returns: [0.0002, -0.0001, 0.0003, -0.0002, 0.0001, 0.00005],
  current: 2600,
  spread: 0.3,
  sigma: 0.0002,
  horizon: 30,
  blockLength: 3,
  seedMaterial: "XAUUSD|2026-11-14T10:00:00.000Z"
};

test("same market snapshot produces exactly reproducible scenarios and probabilities", () => {
  const first = runDeterministicMonteCarlo(input);
  const second = runDeterministicMonteCarlo(input);
  assert.deepEqual(first, second);
  assert.equal(first.sample_sizes.at(-1).simulations, 5000);
  assert.equal(first.scenarios.length, 100);
});

test("sample-size comparisons are nested and probabilities sum to one", () => {
  const result = runDeterministicMonteCarlo(input);
  assert.deepEqual(result.sample_sizes.map(item => item.simulations), [100, 500, 1000, 5000]);
  for (const item of result.sample_sizes) {
    const total = item.probability_up + item.probability_down + item.probability_flat;
    assert.ok(Math.abs(total - 1) <= 0.000003);
    assert.ok(item.probability_up_standard_error >= 0);
    assert.ok(item.probability_down_standard_error >= 0);
  }
});

test("seed changes when the market snapshot changes", () => {
  const first = runDeterministicMonteCarlo(input);
  const changed = runDeterministicMonteCarlo({ ...input, seedMaterial: "XAUUSD|next-quote" });
  assert.notEqual(first.seed, changed.seed);
});

test("rejects invalid or empty simulation inputs", () => {
  assert.equal(runDeterministicMonteCarlo({ ...input, returns: [] }).available, false);
  assert.equal(runDeterministicMonteCarlo({ ...input, current: 0 }).available, false);
  assert.equal(runDeterministicMonteCarlo({ ...input, sampleSizes: [] }).available, false);
});

test("rejects malformed sample-size inputs without throwing", () => {
  assert.equal(runDeterministicMonteCarlo({ ...input, sampleSizes: null }).reason, "invalid_simulation_inputs");
  assert.equal(runDeterministicMonteCarlo({ ...input, sampleSizes: {} }).reason, "invalid_simulation_inputs");
});

test("rejects non-physical returns that could produce zero or negative prices", () => {
  assert.equal(runDeterministicMonteCarlo({ ...input, returns: [0.01, -1] }).reason, "invalid_simulation_inputs");
  assert.equal(runDeterministicMonteCarlo({ ...input, returns: [0.01, -1.2] }).reason, "invalid_simulation_inputs");
  assert.equal(runDeterministicMonteCarlo({ ...input, returns: [0.01, NaN] }).reason, "invalid_simulation_inputs");
});

test("requires the 100-simulation baseline used by the decision engine", () => {
  const result = runDeterministicMonteCarlo({ ...input, sampleSizes: [500, 1000, 5000] });
  assert.equal(result.available, false);
  assert.equal(result.reason, "invalid_simulation_inputs");
});

test("rejects non-finite simulated price paths", () => {
  const result = runDeterministicMonteCarlo({ ...input, returns: [Number.MAX_VALUE] });
  assert.equal(result.available, false);
  assert.equal(result.reason, "non_finite_simulation_path");
});
