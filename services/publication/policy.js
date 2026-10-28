import { hash, generationIdentity } from '../../lib/maze/engine.js';
import { validateDate, utcDate } from '../../lib/maze/dates.js';
import { trustedInstant, publisherInput } from './ingress.js';
import { createLegacyPolicy } from './legacy-policy.js';

export const PUBLICATION_ERA = 'year-round-v1';
export const MANIFEST_VERSION = 'maze-publication-v1';
const rejectionCodes = new Set(['ENDPOINT_DISTANCE_REJECTED', 'FIRE_PLACEMENT_FAILED',
  'EXTINGUISHER_PLACEMENT_FAILED', 'LEGACY_REACHABILITY_REJECTED', 'GRID_SHAPE_REJECTED',
  'TILE_COUNTS_REJECTED', 'BORDER_REJECTED', 'SOLVER_LIMIT', 'UNSOLVABLE',
  'EXTINGUISHER_UNREACHABLE_BEFORE_EXIT', 'DISCONNECTED_GEOMETRY']);

export { createLegacyPolicy } from './legacy-policy.js';
// Pure helper legacy fallback; production defaults use the fresh release policy.
export const legacyPolicy = createLegacyPolicy();

export function completeGrid(maze) {
  if (!maze || !Number.isInteger(maze.width) || !Number.isInteger(maze.height)
      || maze.width < 1 || maze.width > 101 || maze.height < 1 || maze.height > 101
      || typeof maze.seed !== 'string' || !maze.seed.length || !Array.isArray(maze.grid)
      || maze.grid.length !== maze.height || maze.grid.some(row => !Array.isArray(row) || row.length !== maze.width)) return false;
  const counts = { S: 0, E: 0, X: 0, F: 0 };
  for (const row of maze.grid) for (const tile of row) {
    if (!['#', ' ', 'S', 'E', 'X', 'F'].includes(tile)) return false;
    if (Object.hasOwn(counts, tile)) counts[tile]++;
  }
  return counts.S === 1 && counts.E === 1 ? counts : false;
}

export function validManifest(maze) {
  try {
    const counts = completeGrid(maze), p = maze.provenance;
    if (!counts || counts.X !== 1 || counts.F !== 1 || !p || p.manifestVersion !== MANIFEST_VERSION
        || maze.publicationEra !== PUBLICATION_ERA || !(maze.publishedAt instanceof Date)) return false;
    const input = publisherInput({ date: maze.date, version: p.algorithmVersion, seed: maze.seed, config: p.config }, maze.publishedAt);
    const identity = generationIdentity(input);
    if (p.configVersion !== identity.configVersion || p.rngVersion !== identity.rngVersion
        || p.configHash !== identity.configHash || p.identityHash !== identity.identityHash
        || p.gridHash !== hash(maze.grid) || maze.width !== input.config.width || maze.height !== input.config.height
        || !Number.isInteger(p.acceptedAttempt) || p.acceptedAttempt < 0 || p.acceptedAttempt >= input.config.maxAttempts
        || !Array.isArray(p.attempts) || p.attempts.length !== p.acceptedAttempt + 1) return false;
    if (p.attempts.some((a, i) => a.attempt !== i || (i === p.acceptedAttempt ? a.code !== 'ACCEPTED' : !rejectionCodes.has(a.code)))) return false;
    return !maze.grid.some((row, r) => row.some((tile, c) =>
      (r === 0 || c === 0 || r === maze.height - 1 || c === maze.width - 1) && tile !== '#'));
  } catch { return false; }
}

export function isPublished(maze, now, legacy = legacyPolicy) {
  const instant = trustedInstant(now), today = utcDate(instant);
  try { validateDate(maze?.date); } catch { return false; }
  if (maze.date > today || !completeGrid(maze)) return false;
  if (maze.publicationEra === undefined && maze.publishedAt === undefined && maze.provenance === undefined) {
    return legacy.matches(maze.date, hash(maze.grid));
  }
  return validManifest(maze) && maze.publishedAt <= instant
    && (!legacy.modernMatches || legacy.modernMatches(maze));
}

export const publicationEra = maze => maze.publicationEra ?? 'legacy';

// A cheap indexed prefilter only; every selected row still passes isPublished.
export function publicationFilter(now, legacy = legacyPolicy) {
  const instant = trustedInstant(now);
  const modern = legacy.modernFilter?.() ?? {};
  return { date: { $gte: '0001-01-01', $lte: utcDate(instant) }, $or: [
    { ...modern, publicationEra: PUBLICATION_ERA,
      publishedAt: { ...modern.publishedAt, $type: 'date', $lte: instant }, provenance: { $type: 'object' } },
    { date: { $in: legacy.dates }, publicationEra: { $exists: false }, publishedAt: { $exists: false }, provenance: { $exists: false } },
  ] };
}

export function publicationDocument(result, now) {
  return { ...result.maze, publicationEra: PUBLICATION_ERA, publishedAt: trustedInstant(now), provenance: {
    manifestVersion: MANIFEST_VERSION, algorithmVersion: result.algorithmVersion, configVersion: result.configVersion,
    rngVersion: result.rngVersion, config: result.config, configHash: result.configHash,
    identityHash: result.identityHash, gridHash: result.gridHash,
    acceptedAttempt: result.acceptedAttempt, attempts: result.attempts,
  } };
}
