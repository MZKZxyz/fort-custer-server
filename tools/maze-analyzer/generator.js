import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { carveCandidate } from '../../lib/maze/candidate-v1.js';
import { seededRandom } from '../../lib/maze/random-v1.js';
export { seededRandom, rngVersion } from '../../lib/maze/random-v1.js';

export const algorithmVersion = 'legacy-analyzer-v1';
// Historical report provenance, not the hash of the extracted implementation.
export const legacySourceHash = 'cf0c29029b3ea8c17a6247a7aec46ab589246d48ec5afadbcc2b4646348dafe1';
export const generatorHash = createHash('sha256')
  .update(readFileSync(new URL('../../lib/maze/candidate-v1.js', import.meta.url)))
  .update(readFileSync(new URL('../../lib/maze/random-v1.js', import.meta.url))).digest('hex');

// Single invocation, intentionally retaining old failures; daily retries live in the engine.
export function generate(seed, { width = 13, height = 17, minDistance = 25 } = {}) {
  if (typeof seed !== 'string' || !seed.length) throw new Error('seed must be a nonempty string');
  for (const n of [width, height]) {
    if (!Number.isInteger(n) || n < 3 || n > 101 || n % 2 !== 1) {
      throw new Error('dimensions must be odd integers from 3 to 101');
    }
  }
  if (!Number.isInteger(minDistance) || minDistance < 1) throw new Error('minDistance must be positive');
  return carveCandidate(seed, { width, height, minDistance }, seededRandom(seed));
}
