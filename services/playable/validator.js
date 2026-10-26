import { Worker } from 'node:worker_threads';
import { fail, PlayableError } from './errors.js';

export class RouteValidator {
  constructor({ concurrency = 2, timeoutMs = 5000 } = {}) {
    this.active = new Set(); this.accounts = new Set(); this.concurrency = concurrency; this.timeoutMs = timeoutMs;
  }
  async validate(accountId, grid, manifest, transcript) {
    if (this.accounts.has(accountId) || this.active.size >= this.concurrency) fail('VALIDATION_BUSY', 503);
    this.accounts.add(accountId);
    let worker;
    try {
      worker = new Worker(new URL('./validation-worker.js', import.meta.url), {
        workerData: { grid, manifest, transcript }, resourceLimits: { maxOldGenerationSizeMb: 64 },
      });
      this.active.add(worker);
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { reject(new PlayableError('VALIDATION_TIMEOUT', 503)); void worker.terminate(); }, this.timeoutMs);
        worker.once('message', data => {
          clearTimeout(timer);
          if (data.result) resolve(data.result);
          else reject(new PlayableError(data.error?.code || 'VALIDATION_UNAVAILABLE', data.error?.status || 503));
        });
        worker.once('error', () => { clearTimeout(timer); reject(new PlayableError('VALIDATION_UNAVAILABLE', 503)); });
        worker.once('exit', () => { clearTimeout(timer); reject(new PlayableError('VALIDATION_UNAVAILABLE', 503)); });
      });
    } finally {
      if (worker) { this.active.delete(worker); await worker.terminate(); }
      this.accounts.delete(accountId);
    }
  }
}
