const DEFAULT_SAMPLE_SIZES = [100, 500, 1000, 5000];

function hashSeed(value) {
  const text = String(value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function summarize(count, up, down, flat, sumMove, adverse) {
  const probabilityUp = up / count;
  const probabilityDown = down / count;
  const probabilityFlat = flat / count;
  const standardError = probability => Math.sqrt(probability * (1 - probability) / count);
  return {
    simulations: count,
    probability_up: Number(probabilityUp.toFixed(6)),
    probability_down: Number(probabilityDown.toFixed(6)),
    probability_flat: Number(probabilityFlat.toFixed(6)),
    expected_move: Number((sumMove / count).toFixed(6)),
    adverse_path_rate: Number((adverse / count).toFixed(6)),
    probability_up_standard_error: Number(standardError(probabilityUp).toFixed(6)),
    probability_down_standard_error: Number(standardError(probabilityDown).toFixed(6))
  };
}

export function runDeterministicMonteCarlo({
  returns,
  current,
  spread,
  sigma,
  horizon = 30,
  blockLength = 3,
  seedMaterial = "",
  sampleSizes = DEFAULT_SAMPLE_SIZES
}) {
  if (!Array.isArray(sampleSizes) || !Array.isArray(returns) || !returns.length ||
      returns.some(value => !Number.isFinite(value) || value <= -1)) {
    return { available: false, reason: "invalid_simulation_inputs", sample_sizes: [] };
  }
  const cleanReturns = returns;
  const sizes = [...new Set(sampleSizes.map(Number).filter(value =>
    Number.isInteger(value) && value > 0 && value <= 20000
  ))].sort((a, b) => a - b);
  if (!(Number.isFinite(current) && current > 0) ||
      !(Number.isFinite(spread) && spread >= 0) || !(Number.isFinite(sigma) && sigma >= 0) ||
      !Number.isInteger(horizon) || horizon < 1 || !Number.isInteger(blockLength) || blockLength < 1 ||
      !sizes.length) {
    return { available: false, reason: "invalid_simulation_inputs", sample_sizes: [] };
  }

  const seed = hashSeed([
    seedMaterial, current.toPrecision(12), spread.toPrecision(8),
    horizon, blockLength, cleanReturns.length,
    cleanReturns.map(value => value.toPrecision(10)).join(",")
  ].join("|"));
  const random = seededRandom(seed);
  const maximum = sizes[sizes.length - 1];
  const snapshots = [];
  const scenarios = [];
  let up = 0, down = 0, flat = 0, sumMove = 0, adverse = 0;
  let nextSizeIndex = 0;

  for (let simulation = 1; simulation <= maximum; simulation++) {
    let price = current, pathHigh = current, pathLow = current;
    for (let step = 0; step < horizon;) {
      const startIndex = Math.floor(random() * cleanReturns.length);
      for (let j = 0; j < blockLength && step < horizon; j++, step++) {
        price *= 1 + cleanReturns[(startIndex + j) % cleanReturns.length];
        pathHigh = Math.max(pathHigh, price);
        pathLow = Math.min(pathLow, price);
      }
    }
    const move = price - current;
    const maxAdverseMove = move >= 0 ? current - pathLow : pathHigh - current;
    const maxFavorableMove = move >= 0 ? pathHigh - current : current - pathLow;
    sumMove += move;
    const outcome = move > spread ? "UP" : move < -spread ? "DOWN" : "FLAT";
    if (outcome === "UP") up++;
    else if (outcome === "DOWN") down++;
    else flat++;
    if (maxAdverseMove > Math.max(spread * 8, current * sigma * Math.sqrt(horizon) * 2.5)) adverse++;

    if (simulation <= 100) scenarios.push({
      id: simulation,
      terminal_price: Number(price.toFixed(3)),
      move: Number(move.toFixed(3)),
      max_adverse_move: Number(maxAdverseMove.toFixed(3)),
      max_favorable_move: Number(maxFavorableMove.toFixed(3)),
      outcome
    });

    if (simulation === sizes[nextSizeIndex]) {
      snapshots.push(summarize(simulation, up, down, flat, sumMove, adverse));
      nextSizeIndex++;
    }
  }

  const baseline = snapshots.find(item => item.simulations === 100) || snapshots[0];
  const largest = snapshots[snapshots.length - 1];
  const delta = (key) => Number((largest[key] - baseline[key]).toFixed(6));
  return {
    available: true,
    seed: seed.toString(16).padStart(8, "0"),
    seed_method: "FNV-1a over quote snapshot and return sample",
    sample_sizes: snapshots,
    baseline_simulations: baseline.simulations,
    largest_simulations: largest.simulations,
    sensitivity_vs_baseline: {
      probability_up_delta: delta("probability_up"),
      probability_down_delta: delta("probability_down"),
      probability_flat_delta: delta("probability_flat"),
      expected_move_delta: delta("expected_move")
    },
    scenarios
  };
}
