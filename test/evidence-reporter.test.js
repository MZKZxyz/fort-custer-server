import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import report, { safeName } from '../tools/transaction-feasibility/evidence-reporter.mjs';

test('reporter redacts file failure names and arbitrary private titles deterministically', async () => {
  const privateValues = ['/private/person/project/broken.test.mjs', 'C:\\Users\\person\\broken.test.js',
    '\\\\private-host\\person\\broken.test.js', './private/broken.test.js', '../private/broken.test.mjs',
    'relative/private/broken.test.js', 'file:///private/person/broken.test.mjs',
    'person@example.invalid secret-token private-host', 'title with /private/person/path and token'];
  const events = privateValues.map(name => ({ type: 'test:fail', data: { name,
    file: '/private/hidden', details: { error: 'secret-exception' } } }));
  events.push({ type: 'test:stderr', data: { message: 'secret-stderr' } });
  const collect = async () => { let output = ''; for await (const chunk of report(events)) output += chunk; return output; };
  const output = await collect(); assert.equal(output, await collect());
  const evidence = JSON.parse(output);
  assert.equal(evidence.schemaVersion, 2); assert.equal(evidence.failed, privateValues.length);
  assert.equal(evidence.results.filter(t => t.name === 'file-level failure').length, 7);
  for (const text of [...privateValues, 'private-host', 'person', 'secret-exception', 'secret-stderr']) assert.ok(!output.includes(text));
  assert.equal(safeName('T2 stable test'), safeName('T2 stable test'));
  assert.match(safeName('T2 stable test'), /^T2:[a-f0-9]{20}$/);
  assert.notEqual(safeName('T2 stable test'), safeName('T2 other test'));
});

test('reporter sanitizes real Node import-time exceptions without publishing paths or logs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fc-private-reporter-'));
  try {
    const file = join(dir, 'private import.test.mjs');
    await writeFile(file, 'console.error("synthetic-private-stderr"); throw new Error("synthetic-private-exception");\n');
    const reporter = new URL('../tools/transaction-feasibility/evidence-reporter.mjs', import.meta.url).href;
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; // Run an independent Node test runner, not a nested test child.
    const result = await new Promise(resolve => execFile(process.execPath, ['--test', `--test-reporter=${reporter}`, file],
      { timeout: 10000, env }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
    assert.equal(result.error?.code, 1);
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.failed, 1); assert.equal(evidence.passed, 0);
    assert.deepEqual(evidence.results, [{ name: 'file-level failure', outcome: 'fail' }]);
    for (const value of [dir, file, 'private import', 'synthetic-private-stderr', 'synthetic-private-exception', 'file://']) {
      assert.ok(!result.stdout.includes(value)); assert.ok(!result.stderr.includes(value));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
