import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const selectors = ['MONGO_URI', 'MONGODB_URI', 'MONGO_URL', 'DATABASE_URL'];

test('full regression execution has no ambient database selector, including empty values', () => {
  for (const key of selectors) assert.equal(Object.hasOwn(process.env, key), false, `${key} must be unset`);
});

test('the actual workflow test step removes inherited selectors before full automatic discovery', async () => {
  const workflow = await readFile(new URL('../.github/workflows/server-ci.yml', import.meta.url), 'utf8');
  for (const key of selectors) assert.doesNotMatch(workflow, new RegExp(`^\\s*${key}:`, 'm'));
  const step = workflow.match(/      - name: Run all tests[^]*?(?=\n      - name:)/)?.[0];
  assert.ok(step, 'Full regression step must exist');
  const source = step.split('        run: |\n')[1]?.split('\n').map(line => line.slice(10)).join('\n');
  assert.ok(source, 'Full regression step must be executable');
  const dir = await mkdtemp(join(tmpdir(), 'fc-ci-isolation-'));
  try {
    // Substitute only npm: execute the workflow's real shell body with poisoned env.
    const stub = join(dir, 'npm');
    await writeFile(stub, `#!/usr/bin/env bash\nset -euo pipefail\n[ "$#" = 1 ] && [ "$1" = test ]\n${selectors.map(key => `[[ ! -v ${key} ]]`).join('\n')}\nprintf 'full-discovery-without-database-selectors\\n'\n`);
    await chmod(stub, 0o700);
    for (const value of ['synthetic-refused-value', '']) {
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', source], {
        cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 5000,
        env: { ...process.env, ...Object.fromEntries(selectors.map(key => [key, value])), PATH: `${dir}:${process.env.PATH}` },
      });
      assert.equal(result.status, 0, 'Workflow must remove all inherited selectors');
      assert.equal(result.stdout, 'full-discovery-without-database-selectors\n');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
