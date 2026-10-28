// Explicit offline operator artifact tool. No URI, credential or apply selector.
import { parseArgs } from 'node:util';
import { open, constants } from 'node:fs/promises';
import { applyProduction } from './live-boundary.mjs';

try {
  const command = process.argv[2] ?? 'status';
  if (command === 'apply' || command === 'status') {
    process.stdout.write(JSON.stringify(applyProduction()) + '\n');
    if (command === 'apply') process.exitCode = 2;
  } else if (command === 'preview') {
    const { values } = parseArgs({ args: process.argv.slice(3), options: { request: { type: 'string' }, out: { type: 'string' } }, allowPositionals: false });
    const file = await open(values.request, constants.O_RDONLY | constants.O_NOFOLLOW);
    let request;
    try {
      const stat = await file.stat(); if (!stat.isFile() || stat.size > 256 * 1024) throw Error('REQUEST_INVALID');
      // Bound actual bytes as well as stat size; a concurrent growing file must
      // not turn this offline ingress into an unbounded read.
      const bytes = Buffer.alloc(256 * 1024 + 1); let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > 256 * 1024) throw Error('REQUEST_INVALID');
      request = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    } finally { await file.close(); }
    const { exactKeys } = await import('../../services/publication/fresh-release.js');
    exactKeys(request, ['context', 'input', 'target', 'notBefore', 'expiresAt']);
    const { previewOperatorPublication } = await import('./rehearsal.mjs');
    const preview = await previewOperatorPublication({ ...request, now: new Date() });
    const output = await open(values.out, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await output.writeFile(JSON.stringify(preview, null, 2) + '\n'); await output.sync(); } finally { await output.close(); }
    process.stdout.write(JSON.stringify({ schemaVersion: 1, mode: 'offline-review-only', planHash: preview.planHash }) + '\n');
  } else throw Error('COMMAND_INVALID');
} catch { process.stderr.write('{"schemaVersion":1,"code":"OFFLINE_REQUEST_REFUSED"}\n'); process.exitCode = 1; }
