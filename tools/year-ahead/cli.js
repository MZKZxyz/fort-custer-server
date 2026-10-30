import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { BatchError, createBatch, generateBatch, validateBatch, cleanupTemporary, recoverLock } from './batch.js';

try {
  const { values } = parseArgs({ options: Object.fromEntries(
    ['command', 'root', 'id', 'year', 'plan', 'source-revision'].map(k => [k, { type: 'string' }])) });
  const options = { root: values.root, id: values.id };
  let result;
  switch (values.command) {
    case 'create': result = createBatch({ ...options, year: Number(values.year),
      plan: JSON.parse(readFileSync(values.plan, 'utf8')), sourceRevision: values['source-revision'] }); break;
    case 'generate': result = generateBatch(options); break;
    case 'validate': result = validateBatch(options); break;
    case 'cleanup-temporary': result = cleanupTemporary(options); break;
    case 'recover-lock': result = recoverLock(options); break;
    default: throw new BatchError('INVALID_COMMAND');
  }
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  // Node/fs/JSON/generator diagnostics can contain paths, seeds and grid fragments.
  process.stderr.write(JSON.stringify({ code: error instanceof BatchError ? error.message : 'BATCH_OPERATION_FAILED' }) + '\n');
  process.exitCode = 1;
}
