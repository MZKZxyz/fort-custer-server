import { batch, metadata } from './batch.js';
const count = Number(process.argv[2] ?? 10000);
const options = { count, prefix: 'sprint4', start: 0, width: 13, height: 17, minDistance: 25, maxStates: 100000 };
const began = performance.now();
let solved = 0, errors = 0, maxStates = 0;
for (const record of batch(options)) {
  solved += Number(record.solution?.solvable === true);
  errors += Number(Boolean(record.error));
  maxStates = Math.max(maxStates, record.solution?.discoveredStates ?? 0);
}
console.log(JSON.stringify({ metadata: metadata(options), node: process.version, platform: process.platform,
  architecture: process.arch, count, solved, errors, maxStates,
  elapsedMs: performance.now() - began, peakRssKiB: process.resourceUsage().maxRSS,
  heapUsedBytes: process.memoryUsage().heapUsed }, null, 2));
