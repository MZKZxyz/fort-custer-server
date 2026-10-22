import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
export function validateReports(sample, benchmark, expectedSample, expectedBenchmark) {
  assert.deepEqual(sample.metadata, expectedSample.metadata, 'sample provenance/options changed');
  assert.deepEqual(sample.summary, expectedSample.summary, 'sample results changed');
  assert.equal(sample.records.length, expectedSample.metadata.options.count);
  const flagged = sample.records.filter(r => r.issues.length).map(r => ({
    seed: r.seed, issues: r.issues, ...(r.error ? { error: r.error } : {}),
    ...(r.solution ? { minimumMoves: r.solution.minimumMoves, unreachableItems: r.solution.unreachableItems } : {}),
  }));
  assert.deepEqual(flagged, expectedSample.problematicSeeds, 'flagged seeds changed');
  sample.records.forEach((record, index) => {
    assert.equal(record.seed, `${expectedSample.metadata.options.prefix}-${expectedSample.metadata.options.start + index}`);
  });
  // Deterministic fields must match; host-dependent measurements must remain valid.
  for (const field of ['metadata', 'count', 'solved', 'errors', 'maxStates']) {
    assert.deepEqual(benchmark[field], expectedBenchmark[field], `benchmark ${field} changed`);
  }
  assert.match(benchmark.node, /^v24\./, 'benchmark must use supported Node 24');
  assert.equal(typeof benchmark.platform, 'string');
  assert.equal(typeof benchmark.architecture, 'string');
  for (const field of ['elapsedMs', 'peakRssKiB', 'heapUsedBytes']) {
    assert.ok(Number.isFinite(benchmark[field]) && benchmark[field] > 0, `invalid benchmark ${field}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4) throw new Error('Usage: node tools/maze-analyzer/validate-reports.js SAMPLE_JSON BENCHMARK_JSON');
  validateReports(read(process.argv[2]), read(process.argv[3]),
    read(new URL('../../reports/sample-difficulty.json', import.meta.url)),
    read(new URL('../../reports/performance.json', import.meta.url)));
  console.log('Documented sample and deterministic benchmark fields match; runtime measurements are valid.');
}
