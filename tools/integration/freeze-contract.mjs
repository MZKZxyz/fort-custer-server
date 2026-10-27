import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { buildContract } from './contract.mjs';
const file = new URL('../../docs/integration/session-v2.contract.json', import.meta.url);
const contract = await buildContract();
if (process.argv.length === 3 && process.argv[2] === '--write') await writeFile(file, JSON.stringify(contract, null, 2) + '\n');
else {
  assert.ok(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--check');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), contract);
  process.stdout.write('FROZEN_CONTRACT_MATCH\n');
}
