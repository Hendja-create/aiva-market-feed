import { Worker } from "node:worker_threads";

export class MonteCarloQueueFullError extends Error {
  constructor() {
    super("Monte Carlo worker queue is full");
    this.name = "MonteCarloQueueFullError";
    this.code = "AIVA_ANALYSIS_QUEUE_FULL";
  }
}

export class MonteCarloWorkerPool {
  constructor({ size = 2, maxQueue = 32, workerUrl = new URL("./monte-carlo-worker.js", import.meta.url) } = {}) {
    if (!Number.isInteger(size) || size < 1 || size > 8) throw new RangeError("Worker size must be between 1 and 8");
    if (!Number.isInteger(maxQueue) || maxQueue < 0 || maxQueue > 1000) throw new RangeError("maxQueue must be between 0 and 1000");
    this.size = size;
    this.maxQueue = maxQueue;
    this.workerUrl = workerUrl;
    this.queue = [];
    this.workers = [];
    this.nextId = 1;
    this.closed = false;
    for (let i = 0; i < size; i++) this.spawnWorker();
  }

  spawnWorker() {
    if (this.closed) return;
    const slot = { worker: new Worker(this.workerUrl), busy: false, task: null, failed: false };
    this.workers.push(slot);
    slot.worker.on("message", message => {
      if (slot.failed || !slot.task || message?.id !== slot.task.id) return;
      const task = slot.task;
      slot.task = null;
      slot.busy = false;
      if (message.error) {
        const error = new Error(message.error.message || "Monte Carlo worker failed");
        error.code = message.error.code || "AIVA_MONTE_CARLO_WORKER_ERROR";
        task.reject(error);
      } else task.resolve(message.result);
      this.dispatch();
    });
    slot.worker.on("error", error => this.failWorker(slot, error));
    slot.worker.on("exit", code => {
      if (!this.closed && !slot.failed) this.failWorker(slot, new Error("Monte Carlo worker exited with code " + code));
    });
  }

  failWorker(slot, error) {
    if (slot.failed || this.closed) return;
    slot.failed = true;
    this.workers = this.workers.filter(item => item !== slot);
    if (slot.task) { slot.task.reject(error); slot.task = null; }
    this.spawnWorker();
    this.dispatch();
  }

  run(input) {
    if (this.closed) return Promise.reject(new Error("Monte Carlo worker pool is closed"));
    const idle = this.workers.some(slot => !slot.busy && !slot.failed);
    if (!idle && this.queue.length >= this.maxQueue) return Promise.reject(new MonteCarloQueueFullError());
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, input, resolve, reject });
      this.dispatch();
    });
  }

  dispatch() {
    if (this.closed) return;
    for (const slot of this.workers) {
      if (slot.busy || slot.failed || !this.queue.length) continue;
      const task = this.queue.shift();
      slot.busy = true;
      slot.task = task;
      try { slot.worker.postMessage({ id: task.id, input: task.input }); }
      catch (error) {
        slot.task = null;
        slot.busy = false;
        task.reject(error);
      }
    }
  }

  getStatus() {
    return { workers: this.workers.length, active: this.workers.filter(slot => slot.busy).length,
      queued: this.queue.length, max_queue: this.maxQueue, closed: this.closed };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("Monte Carlo worker pool closed");
    for (const task of this.queue.splice(0)) task.reject(error);
    const active = this.workers.splice(0);
    for (const slot of active) {
      slot.failed = true;
      if (slot.task) slot.task.reject(error);
      slot.task = null;
    }
    await Promise.all(active.map(slot => slot.worker.terminate()));
  }
}
