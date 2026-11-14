import { parentPort } from "node:worker_threads";
import { runDeterministicMonteCarlo } from "./monte-carlo.js";

if (!parentPort) throw new Error("Monte Carlo worker requires a parent port");
parentPort.on("message", ({ id, input }) => {
  try {
    const result = runDeterministicMonteCarlo(input);
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error instanceof Error ? error.message : String(error), code: "AIVA_MONTE_CARLO_WORKER_ERROR" } });
  }
});
