import test from "node:test";
import assert from "node:assert/strict";
import { summarizeProbabilityCalibration } from "../src/probability-calibration.js";

test("computes a three-class Brier score and directional reliability bins", () => {
  const result = summarizeProbabilityCalibration([
    { decision: "BUY", probability_up: 0.8, probability_down: 0.1, actual_direction: "UP" },
    { decision: "SELL", probability_up: 0.1, probability_down: 0.8, actual_direction: "DOWN" },
    { decision: "NO_TRADE", probability_up: 0.2, probability_down: 0.2, actual_direction: "FLAT" }
  ]);
  assert.equal(result.observations, 3);
  assert.equal(result.directional_observations, 2);
  assert.equal(result.multiclass_brier_score, 0.04);
  assert.equal(result.directional_ece, 0.2);
  assert.deepEqual(result.bins, [{
    range: "[0.8, 0.9)",
    observations: 2,
    mean_confidence: 0.8,
    observed_accuracy: 1,
    calibration_gap: 0.2
  }]);
  assert.equal(result.status, "insufficient_sample");
});

test("ignores malformed probabilities and unknown outcomes", () => {
  const result = summarizeProbabilityCalibration([
    { decision: "BUY", probability_up: 1.2, probability_down: 0, actual_direction: "UP" },
    { decision: "BUY", probability_up: 0.7, probability_down: 0.4, actual_direction: "UP" },
    { decision: "SELL", probability_up: 0.2, probability_down: 0.7, actual_direction: "SIDEWAYS" }
  ]);
  assert.equal(result.observations, 0);
  assert.equal(result.multiclass_brier_score, null);
  assert.equal(result.status, "no_valid_observations");
});

test("includes low-confidence and NO_TRADE forecasts in Brier score but not directional ECE bins", () => {
  const result = summarizeProbabilityCalibration([
    { decision: "BUY", probability_up: 0.45, probability_down: 0.4, actual_direction: "UP" },
    { decision: "NO_TRADE", probability_up: 0.2, probability_down: 0.2, actual_direction: "FLAT" }
  ]);
  assert.equal(result.observations, 2);
  assert.equal(result.directional_observations, 1);
  assert.equal(result.bins.length, 0);
  assert.equal(result.directional_ece, null);
});
