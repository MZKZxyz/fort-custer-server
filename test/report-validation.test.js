import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateReports } from '../tools/maze-analyzer/validate-reports.js';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const expectedBenchmark = read('../reports/performance.json');
const record = { seed: 'check-0', issues: ['short-solution'], solution: { minimumMoves: 1, unreachableItems: [] } };
const sample = { metadata: { options: { prefix: 'check', start: 0, count: 1 } }, summary: { solved: 1 }, records: [record] };
const expectedSample = { metadata: sample.metadata, summary: sample.summary,
  problematicSeeds: [{ seed: 'check-0', issues: record.issues, minimumMoves: 1, unreachableItems: [] }] };

test('report validator accepts different host measurements but rejects deterministic drift', () => {
  const benchmark = { ...expectedBenchmark, elapsedMs: 123, peakRssKiB: 456, heapUsedBytes: 789 };
  assert.doesNotThrow(() => validateReports(sample, benchmark, expectedSample, expectedBenchmark));
  for (const field of ['count', 'solved', 'errors', 'maxStates']) {
    assert.throws(() => validateReports(sample, { ...benchmark, [field]: benchmark[field] + 1 }, expectedSample, expectedBenchmark));
  }
  const changed = structuredClone(sample); changed.records[0].solution.minimumMoves++;
  assert.throws(() => validateReports(changed, benchmark, expectedSample, expectedBenchmark));
  assert.throws(() => validateReports(sample, { ...benchmark, elapsedMs: -1 }, expectedSample, expectedBenchmark));
  assert.throws(() => validateReports(sample, { ...benchmark, node: 'v22.0.0' }, expectedSample, expectedBenchmark));
});
