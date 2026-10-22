import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

// Execute only the existing pure generator declarations, never the seeder/imports.
const source = readFileSync(new URL('../../scripts/generateMazes.js', import.meta.url), 'utf8');
const begin = source.indexOf('const placeFireAndExtinguisher =');
const end = source.indexOf('const run = async');
if (begin < 0 || end <= begin) throw new Error('Generator layout changed; review the offline adapter');
const script = new vm.Script(`(() => { ${source.slice(begin, end)}\nreturn generateDummyMaze(seed, width, height, minDistance); })()`);
const math = Object.create(Math);
const context = vm.createContext({ Math: math });
export const generatorHash = createHash('sha256').update(source).digest('hex');
export const rngVersion = 'sha256-mulberry32-v1';
export function seededRandom(seed) {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function generate(seed, { width = 13, height = 17, minDistance = 25 } = {}) {
  if (typeof seed !== 'string' || !seed.length) throw new Error('seed must be a nonempty string');
  for (const n of [width, height]) {
    if (!Number.isInteger(n) || n < 3 || n > 101 || n % 2 !== 1) {
      throw new Error('dimensions must be odd integers from 3 to 101');
    }
  }
  if (!Number.isInteger(minDistance) || minDistance < 1) throw new Error('minDistance must be positive');
  math.random = seededRandom(seed);
  Object.assign(context, { seed, width, height, minDistance });
  // Reuse one realm; repeated vm contexts retain substantial V8 metadata in long batches.
  return structuredClone(script.runInContext(context, { timeout: 2000 }));
}
