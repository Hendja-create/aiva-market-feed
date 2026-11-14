const DIRECTIONS = ["UP", "DOWN", "FLAT"];
const BIN_COUNT = 5;
const MIN_CONFIDENCE = 0.5;

function round(value, digits = 4) {
  return Number(value.toFixed(digits));
}

function normalizeProbabilities(row) {
  const up = Number(row.probability_up);
  const down = Number(row.probability_down);
  if (!Number.isFinite(up) || !Number.isFinite(down) || up < 0 || down < 0 || up > 1 || down > 1) return null;
  const flat = 1 - up - down;
  if (flat < -0.001) return null;
  const values = [up, down, Math.max(0, flat)];
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return null;
  return values.map(value => value / total);
}

export function summarizeProbabilityCalibration(rows, minimumObservations = 30) {
  const valid = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const probabilities = normalizeProbabilities(row || {});
    if (!probabilities || !DIRECTIONS.includes(row.actual_direction)) continue;
    valid.push({ row, probabilities, actualIndex: DIRECTIONS.indexOf(row.actual_direction) });
  }

  if (!valid.length) {
    return {
      observations: 0,
      directional_observations: 0,
      multiclass_brier_score: null,
      directional_ece: null,
      bins: [],
      status: "no_valid_observations",
      minimum_observations: minimumObservations
    };
  }

  const brier = valid.reduce((sum, item) => {
    return sum + item.probabilities.reduce((score, probability, index) =>
      score + (probability - (index === item.actualIndex ? 1 : 0)) ** 2, 0) / 3;
  }, 0) / valid.length;

  const bins = Array.from({ length: BIN_COUNT }, (_, index) => ({
    lower: MIN_CONFIDENCE + index * 0.1,
    upper: MIN_CONFIDENCE + (index + 1) * 0.1,
    count: 0,
    confidenceSum: 0,
    correct: 0
  }));
  let directionalObservations = 0;
  for (const item of valid) {
    const decision = item.row.decision;
    if (decision !== "BUY" && decision !== "SELL") continue;
    const directionIndex = decision === "BUY" ? 0 : 1;
    const confidence = item.probabilities[directionIndex];
    directionalObservations++;
    if (confidence < MIN_CONFIDENCE) continue;
    const binIndex = Math.min(BIN_COUNT - 1, Math.floor((confidence - MIN_CONFIDENCE) / 0.1));
    const bin = bins[binIndex];
    bin.count++;
    bin.confidenceSum += confidence;
    if (item.actualIndex === directionIndex) bin.correct++;
  }

  const populatedBins = bins.filter(bin => bin.count > 0).map(bin => {
    const meanConfidence = bin.confidenceSum / bin.count;
    const accuracy = bin.correct / bin.count;
    return {
      range: "[" + round(bin.lower, 2) + ", " + round(bin.upper, 2) + (bin.upper === 1 ? "]" : ")"),
      observations: bin.count,
      mean_confidence: round(meanConfidence),
      observed_accuracy: round(accuracy),
      calibration_gap: round(Math.abs(meanConfidence - accuracy))
    };
  });
  const binnedCount = populatedBins.reduce((sum, bin) => sum + bin.observations, 0);
  const ece = binnedCount
    ? populatedBins.reduce((sum, bin) => sum + bin.observations * bin.calibration_gap, 0) / binnedCount
    : null;

  return {
    observations: valid.length,
    directional_observations: directionalObservations,
    multiclass_brier_score: round(brier),
    directional_ece: ece === null ? null : round(ece),
    bins: populatedBins,
    status: valid.length >= minimumObservations ? "measured" : "insufficient_sample",
    minimum_observations: minimumObservations,
    note: "Diagnostic only. This score does not change confidence thresholds or enable a strategy."
  };
}
