import { createHash } from 'node:crypto';
import { carveCandidate } from './candidate-v1.js';
import { rngVersion, seededRandom } from './random-v1.js';
import { validateDate } from './dates.js';
import { analyze } from './analyzer.js';

export const algorithmVersion = 'daily-dfs-v1';
export const configVersion = 'daily-config-v1';
export const tileRules = 'client-single-slot-fire-input-v1';
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const defaults = Object.freeze({ width: 13, height: 17, minDistance: 25,
  endpointAttempts: 10, fireAttempts: 5, maxAttempts: 10, maxStates: 100000, tileRules });

export function canonicalConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !Object.hasOwn(defaults, key))) throw new Error('INVALID_CONFIG');
  const config = Object.fromEntries(Object.entries(defaults).map(([key, value]) =>
    [key, Object.hasOwn(input, key) ? input[key] : value]));
  for (const key of ['width', 'height']) {
    const n = config[key];
    if (!Number.isInteger(n) || n < 5 || n > 101 || n % 2 !== 1) throw new Error('INVALID_DIMENSIONS');
  }
  for (const [key, max] of [['minDistance', 10201], ['endpointAttempts', 32],
    ['fireAttempts', 32], ['maxAttempts', 32], ['maxStates', 100000]]) {
    if (!Number.isInteger(config[key]) || config[key] < 1 || config[key] > max) throw new Error('INVALID_CONFIG');
  }
  if (config.tileRules !== tileRules) throw new Error('UNSUPPORTED_TILE_RULES');
  return Object.freeze(config);
}

export class GenerationError extends Error {
  constructor(identity, attempts) {
    super('GENERATION_EXHAUSTED');
    this.code = 'GENERATION_EXHAUSTED';
    this.identity = identity;
    this.attempts = attempts;
  }
}

export function generationIdentity({ date, version = algorithmVersion, seed, config = {} } = {}) {
  validateDate(date);
  if (version !== algorithmVersion) throw new Error('UNSUPPORTED_ALGORITHM_VERSION');
  const canonical = canonicalConfig(config);
  seed ??= `fortcuster-${date}`;
  if (typeof seed !== 'string' || !seed.length || seed.length > 256) throw new Error('INVALID_SEED');
  const configHash = hash([configVersion, canonical]);
  const identityHash = hash(['fort-custer/daily', date, version, configHash, seed]);
  return { date, seed, algorithmVersion: version, configVersion, rngVersion,
    config: canonical, configHash, identityHash };
}

const rejectionMessages = new Map([
  ['Unable to place fire', 'FIRE_PLACEMENT_FAILED'],
  ['No extinguisher locations', 'EXTINGUISHER_PLACEMENT_FAILED'],
  ['Maze invalid: extinguisher or exit unreachable', 'LEGACY_REACHABILITY_REJECTED'],
  ['Maze generation failed: no valid path found', 'ENDPOINT_DISTANCE_REJECTED'],
]);

// Exported for offline verification of candidate fixtures. Never edits the input grid.
export function verifyCandidate(grid, config) {
  const { width, height, maxStates } = canonicalConfig(config);
  if (!Array.isArray(grid) || grid.length !== height || grid.some(row => !Array.isArray(row) || row.length !== width)) {
    return { code: 'GRID_SHAPE_REJECTED' };
  }
  const cells = grid.flat();
  if (['S', 'E', 'X', 'F'].some(tile => cells.filter(value => value === tile).length !== 1)
      || cells.some(tile => !['#', ' ', 'S', 'E', 'X', 'F'].includes(tile))) return { code: 'TILE_COUNTS_REJECTED' };
  if (grid.some((row, r) => row.some((tile, c) =>
    (r === 0 || c === 0 || r === height - 1 || c === width - 1) && tile !== '#'))) {
    return { code: 'BORDER_REJECTED' };
  }
  const analysis = analyze(grid, { maxStates });
  if (analysis.solution.status === 'limit') return { code: 'SOLVER_LIMIT' };
  if (!analysis.solution.solvable) return { code: 'UNSOLVABLE' };
  // The client ends at E: a pickup reachable only after E is invalid for daily v1.
  if (analysis.solution.unreachableItems.length) return { code: 'EXTINGUISHER_UNREACHABLE_BEFORE_EXIT' };
  if (analysis.exact.geometricComponents !== 1) return { code: 'DISCONNECTED_GEOMETRY' };
  return { code: 'ACCEPTED', analysis };
}

export function generateDaily(options) {
  const identity = generationIdentity(options), attempts = [];
  const { config, seed, date, identityHash } = identity;
  for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
    // Domain-separated independent streams make retry k reproducible on its own.
    const attemptSeed = hash(['fort-custer/attempt', identityHash, attempt]);
    let candidate;
    try {
      candidate = carveCandidate(seed, { ...config, preserveEndpoints: true }, seededRandom(attemptSeed));
    } catch (error) {
      const code = rejectionMessages.get(error.message);
      if (!code) throw error; // Programming defects must not masquerade as random rejections.
      attempts.push({ attempt, code });
      continue;
    }
    const verification = verifyCandidate(candidate.grid, config);
    attempts.push({ attempt, code: verification.code });
    if (verification.code !== 'ACCEPTED') continue;
    return { ...identity, acceptedAttempt: attempt, attempts, gridHash: hash(candidate.grid),
      maze: { date, ...candidate, collectibles: [] }, analysis: verification.analysis };
  }
  throw new GenerationError(identity, attempts);
}
