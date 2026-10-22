import { generate, generatorHash, rngVersion } from './generator.js';
import { analyze } from './analyzer.js';

// Stream one compact record at a time; never retain grids, paths, or search states across seeds.
export function* batch({ prefix = 'sprint4', start = 0, count = 1000, ...options } = {}) {
  if (typeof prefix !== 'string' || !Number.isSafeInteger(start) || start < 0 ||
      !Number.isInteger(count) || count < 1 || count > 100000 || !Number.isSafeInteger(start + count)) {
    throw new Error('Invalid batch range (count must be 1..100000)');
  }
  for (let i = start; i < start + count; i++) {
    const seed = `${prefix}-${i}`;
    try {
      const result = analyze(generate(seed, options).grid, options);
      const { actions, path, interactions, ...solution } = result.solution;
      yield { seed, ...result, solution };
    } catch (error) {
      yield { seed, issues: ['generation-or-validation-error'], error: error.message };
    }
  }
}

export function metadata(options) {
  return { schemaVersion: 1, generatorHash, rngVersion, options,
    rules: 'client-single-slot-fire-input-v1', thresholds: { shortMoves: 25, longMovesPerCell: 2,
      difficultyOutlier: 'score < 25 or score > 175 (fixed experimental thresholds)' } };
}

export function summarize(records) {
  let total = 0, solved = 0, minimum = Infinity, maximum = -Infinity, sum = 0;
  const issueCounts = {};
  for (const record of records) {
    total++;
    if (record.solution?.solvable === true) {
      solved++; const n = record.solution.minimumMoves;
      minimum = Math.min(minimum, n); maximum = Math.max(maximum, n); sum += n;
    }
    for (const issue of record.issues) issueCounts[issue] = (issueCounts[issue] || 0) + 1;
  }
  return { total, solved, issueCounts, minimumMoves: solved ? minimum : null,
    maximumMoves: solved ? maximum : null, meanMoves: solved ? sum / solved : null };
}
