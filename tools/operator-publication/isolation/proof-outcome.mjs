// Failure diagnostics for the disposable proof only. Never serialize raw errors,
// stderr, arguments, paths, stacks, causes, credentials or signed request bytes.
const limit = 8;
const codes = new Set(['COMMAND_FAILED', 'SUPERVISOR_COMMAND_TIMEOUT', 'OUTPUT_LIMIT',
  'ERR_ASSERTION', 'ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EROFS', 'EPIPE',
  'ETIMEDOUT', 'ECONNREFUSED', 'DISPOSAL_INCOMPLETE', 'LIFECYCLE_DISPOSAL_INCOMPLETE']);
const operations = new Set(['info', 'create', 'cp', 'start', 'rm', 'inspect', 'pull',
  'build', 'run', 'kill', 'top', 'exec', 'ps', 'volume:create', 'volume:rm', 'volume:ls',
  'image:inspect', 'image:rm', 'rev-parse', 'status', 'archive', '-xf']);
const reasons = ['QA_PRIMARY_PROVISION_FAILURE', 'QA_SECONDARY_CLEANUP_FAILURE',
  'DISPOSAL_INCOMPLETE', 'LIFECYCLE_DISPOSAL_INCOMPLETE', 'ENOSPC', 'EACCES',
  'EPERM', 'ENOENT', 'EIO', 'EROFS', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED'];
function reasonCodes(value) {
  const text = String(value ?? '').slice(0, 4096);
  const found = reasons.filter(code => text.includes(code));
  if (/no space left on device/i.test(text)) found.push('ENOSPC');
  if (/permission denied/i.test(text)) found.push('EACCES');
  if (/cannot connect to the docker daemon/i.test(text)) found.push('DAEMON_UNAVAILABLE');
  if (/is (?:being used|in use)|is running/i.test(text)) found.push('RESOURCE_IN_USE');
  return [...new Set(found)].slice(0, 4);
}
class CommandFailure extends Error {
  constructor(detail) { super(detail.code); this.detail = Object.freeze(detail); }
}
export function commandFailure(binary, args, { code = 'COMMAND_FAILED', exitCode = null, stderr = '' } = {}) {
  const words = args[0]?.startsWith('--host=') ? args.slice(1) : args;
  const operation = ['volume', 'image'].includes(words[0]) ? words.slice(0, 2).join(':') : words[0];
  return new CommandFailure({ code: codes.has(code) ? code : 'COMMAND_FAILED',
    command: ['docker', 'git', 'tar'].includes(binary) ? binary : 'other',
    operation: operations.has(operation) ? operation : 'other',
    exitCode: Number.isInteger(exitCode) && Math.abs(exitCode) <= 255 ? exitCode : null,
    reasons: reasonCodes(stderr) });
}
function diagnostic(error) {
  if (error instanceof CommandFailure) return error.detail;
  const code = codes.has(error?.code) ? error.code : codes.has(error?.message) ? error.message : 'UNCLASSIFIED_FAILURE';
  return { code, reasons: reasonCodes(error?.message) };
}
class CleanupFailure extends Error {
  constructor(failures, total) { super('CLEANUP_FAILED'); this.failures = failures; this.total = total; }
}
class ProofFailure extends Error {
  constructor(primary, cleanup) { super('PROOF_FAILED'); this.primary = primary; this.cleanup = cleanup; }
}
// Complete all bounded teardown/verification steps even when one fails. Keep at
// most eight redacted contexts and a count; never retry a publication or cleanup.
export async function cleanupSteps(steps) {
  const failures = []; let total = 0;
  for (const step of steps) {
    try { await step(); }
    catch (error) { total++; if (failures.length < limit) failures.push(diagnostic(error)); }
  }
  if (total) throw new CleanupFailure(failures, total);
}
export async function runWithCleanup(primary, cleanup) {
  let primaryError, cleanupError, primaryFailed = false, cleanupFailed = false;
  try { await primary(); } catch (error) { primaryFailed = true; primaryError = diagnostic(error); }
  try { await cleanup(); }
  catch (error) {
    cleanupFailed = true;
    cleanupError = error instanceof CleanupFailure
      ? { failures: error.failures, total: error.total }
      : { failures: [diagnostic(error)], total: 1 };
  }
  if (primaryFailed || cleanupFailed) throw new ProofFailure(primaryFailed ? primaryError : null, cleanupFailed ? cleanupError : null);
}
export function failureReport(error) {
  const failure = error instanceof ProofFailure ? error : new ProofFailure(diagnostic(error), null);
  // Shape and strings are bounded by construction; arbitrary error properties,
  // causes and stderr never enter this report (including Node's error inspector).
  return JSON.stringify({ schemaVersion: 1, code: 'PROOF_FAILED', retry: false,
    production: 'LIVE_APPLY_BLOCKED', primary: failure.primary, cleanup: failure.cleanup });
}
export function missingResource(stderr, kind, name) {
  // Only exact expected idempotent removal responses are benign. All other
  // nonzero exits are cleanup failures even if later inventory finds nothing.
  const text = stderr.toString().trim();
  const noun = { container: 'container', volume: 'volume', image: 'image' }[kind];
  return text === `Error response from daemon: No such ${noun}: ${name}`
    || kind === 'volume' && text === `Error response from daemon: get ${name}: no such volume`;
}
