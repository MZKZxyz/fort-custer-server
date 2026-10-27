import { fork } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { publisherInput, trustedInstant, plainKeys, fail } from './ingress.js';

export const WORKER_LIMITS = Object.freeze({ timeoutMs: 1500, rssBytes: 128 * 1024 * 1024,
  heapMiB: 48, maxConcurrency: 1, maxMessageBytes: 256 * 1024, sampleMs: 10 });
let active = false;

export async function generateInWorker(input, now, limits = {}) {
  // Callers may tighten limits for an owned resource probe, never enlarge them.
  plainKeys(limits, ['timeoutMs', 'rssBytes']);
  const timeoutMs = limits.timeoutMs ?? WORKER_LIMITS.timeoutMs;
  const rssBytes = limits.rssBytes ?? WORKER_LIMITS.rssBytes;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > WORKER_LIMITS.timeoutMs
      || !Number.isInteger(rssBytes) || rssBytes < 1 || rssBytes > WORKER_LIMITS.rssBytes) throw fail('INVALID_WORKER_LIMITS');
  const at = trustedInstant(now).getTime(), safe = publisherInput(input, at);
  if (process.platform !== 'linux') throw fail('WORKER_RSS_MONITOR_UNAVAILABLE');
  if (active) throw fail('GENERATOR_BUSY');
  active = true;
  try {
    return await new Promise((resolve, reject) => {
      const started = performance.now();
      const child = fork(new URL('../../tools/maze-publisher/worker.js', import.meta.url), [], {
        env: { TZ: 'UTC', LANG: 'C', NODE_NO_WARNINGS: '1' },
        execArgv: [`--max-old-space-size=${WORKER_LIMITS.heapMiB}`, '--max-semi-space-size=4',
          '--permission', `--allow-fs-read=${fileURLToPath(new URL('../..', import.meta.url))}`],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json',
      });
      let response, reason, sampledPeakRssBytes = 0, sampling = false, sampledActive = false;
      let exited = false, closed = false, resolveExit;
      const exitObserved = new Promise(resolve => { resolveExit = resolve; });
      const reads = new AbortController();
      const hasExited = () => exited || child.exitCode !== null || child.signalCode !== null;
      const stop = code => {
        if (closed) return;
        reason ??= code;
        if (!hasExited()) child.kill('SIGKILL');
      };
      const deadline = setTimeout(() => stop('GENERATOR_TIMEOUT'), timeoutMs);
      const sample = async () => {
        if (sampling || hasExited() || closed || !child.pid) return;
        sampling = true;
        try {
          // Exit wins over an outstanding read: cleanup must not hang on procfs
          // or let a late rejection kill/poison a subsequent execution slot.
          const status = await Promise.race([
            readFile(`/proc/${child.pid}/status`, { encoding: 'utf8', signal: reads.signal }),
            exitObserved,
          ]);
          if (status === null) return;
          const rss = /VmHWM:\s+(\d+) kB/.exec(status);
          if (/State:\s+Z/.test(status)) confirmExit(); // OS-confirmed process exit.
          else if (rss) {
            sampledActive = true;
            sampledPeakRssBytes = Math.max(sampledPeakRssBytes, +rss[1] * 1024);
            if (sampledPeakRssBytes > rssBytes) stop('GENERATOR_MEMORY_LIMIT');
          } else if (!await confirmMissingProcess()) stop('WORKER_RSS_MONITOR_UNAVAILABLE');
        } catch (error) {
          if (error.code !== 'ENOENT' || !await confirmMissingProcess()) stop('WORKER_RSS_MONITOR_UNAVAILABLE');
        } finally { sampling = false; }
      };
      const monitor = setInterval(sample, WORKER_LIMITS.sampleMs);
      const confirmExit = () => {
        exited = true;
        resolveExit(null);
        reads.abort();
        clearInterval(monitor);
      };
      const confirmMissingProcess = async () => {
        // A procfs read can complete before libuv delivers the same child's exit.
        // Reconcile at most one sampling interval, then require exit or OS ESRCH;
        // an alive process with missing/inaccessible procfs always fails closed.
        if (!hasExited()) {
          let cleanupTimer;
          await Promise.race([exitObserved, new Promise(resolve => {
            cleanupTimer = setTimeout(resolve, WORKER_LIMITS.sampleMs);
          })]);
          clearTimeout(cleanupTimer);
        }
        if (hasExited()) return true;
        try { process.kill(child.pid, 0); }
        catch (error) {
          if (error.code === 'ESRCH') { confirmExit(); return true; }
        }
        return false;
      };
      child.once('exit', confirmExit);
      child.on('error', () => { reason ??= 'GENERATOR_FAILED'; });
      child.on('message', message => {
        if (response || typeof message !== 'string' || Buffer.byteLength(message) > WORKER_LIMITS.maxMessageBytes) return stop('GENERATOR_PROTOCOL');
        try { response = JSON.parse(message); } catch { stop('GENERATOR_PROTOCOL'); }
      });
      child.once('close', code => {
        closed = true;
        confirmExit();
        clearTimeout(deadline); clearInterval(monitor);
        const peakRssBytes = Math.max(sampledPeakRssBytes, response?.metrics?.peakRssBytes ?? 0);
        const metrics = { elapsedMs: performance.now() - started, peakRssBytes };
        if (!reason && peakRssBytes > rssBytes) reason = 'GENERATOR_MEMORY_LIMIT';
        if (!reason && response?.ok && !sampledActive) reason = 'WORKER_RSS_MONITOR_UNAVAILABLE';
        if (reason || code !== 0 || !response || !Number.isFinite(response.metrics?.peakRssBytes)) {
          return reject(Object.assign(fail(reason ?? 'GENERATOR_FAILED'), { metrics }));
        }
        if (!response.ok) return reject(Object.assign(fail(response.code), { attempts: response.attempts, metrics }));
        resolve({ result: response.result, metrics });
      });
      // Sample before dispatch, so even short computations have a proven active
      // monitor. Final child metrics supplement rather than replace this guard.
      void sample().then(() => {
        if (!reason && !hasExited() && !closed && sampledActive) {
          child.send({ input: safe, at }, error => { if (error) stop('GENERATOR_FAILED'); });
        }
      });
    });
  } finally { active = false; }
}
