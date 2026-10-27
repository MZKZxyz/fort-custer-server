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
      let response, reason, sampledPeakRssBytes = 0, sampling = false;
      const stop = code => { reason ??= code; child.kill('SIGKILL'); };
      const deadline = setTimeout(() => stop('GENERATOR_TIMEOUT'), timeoutMs);
      const monitor = setInterval(async () => {
        if (sampling || !child.pid) return;
        sampling = true;
        try {
          const status = await readFile(`/proc/${child.pid}/status`, 'utf8');
          const rss = /VmHWM:\s+(\d+) kB/.exec(status);
          // Linux removes VM fields when a child becomes a zombie before close.
          // The child's final resourceUsage high-water mark is still checked below.
          if (!rss && !/State:\s+Z/.test(status) && !response) stop('WORKER_RSS_MONITOR_UNAVAILABLE');
          else if (rss) {
            sampledPeakRssBytes = Math.max(sampledPeakRssBytes, +rss[1] * 1024);
            if (sampledPeakRssBytes > rssBytes) stop('GENERATOR_MEMORY_LIMIT');
          }
        } catch (error) {
          if (error.code !== 'ENOENT') stop('WORKER_RSS_MONITOR_UNAVAILABLE');
        } finally { sampling = false; }
      }, WORKER_LIMITS.sampleMs);
      child.on('error', () => { reason ??= 'GENERATOR_FAILED'; });
      child.on('message', message => {
        if (response || typeof message !== 'string' || Buffer.byteLength(message) > WORKER_LIMITS.maxMessageBytes) return stop('GENERATOR_PROTOCOL');
        try { response = JSON.parse(message); } catch { stop('GENERATOR_PROTOCOL'); }
      });
      child.once('close', code => {
        clearTimeout(deadline); clearInterval(monitor);
        const peakRssBytes = Math.max(sampledPeakRssBytes, response?.metrics?.peakRssBytes ?? 0);
        const metrics = { elapsedMs: performance.now() - started, peakRssBytes };
        if (!reason && peakRssBytes > rssBytes) reason = 'GENERATOR_MEMORY_LIMIT';
        if (reason || code !== 0 || !response || !Number.isFinite(response.metrics?.peakRssBytes)) {
          return reject(Object.assign(fail(reason ?? 'GENERATOR_FAILED'), { metrics }));
        }
        if (!response.ok) return reject(Object.assign(fail(response.code), { attempts: response.attempts, metrics }));
        resolve({ result: response.result, metrics });
      });
      child.send({ input: safe, at }, error => { if (error) stop('GENERATOR_FAILED'); });
    });
  } finally { active = false; }
}
