// Failure diagnostics for the disposable proof only. Never serialize raw errors,
// stderr, arguments, paths, stacks, causes, credentials or signed request bytes.
import { types } from 'node:util';

const limit = 8;
const isProxy = types.isProxy;
const unclassified = Object.freeze({ code: 'UNCLASSIFIED_FAILURE', reasons: Object.freeze([]) });
const commandDetails = new WeakMap(), cleanupDetails = new WeakMap(), proofDetails = new WeakMap();
const objectLike = value => value !== null && (typeof value === 'object' || typeof value === 'function');
const owned = (map, value) => objectLike(value) ? map.get(value) : undefined;
function dataProperty(value, key) {
  // No prototype walk, getter execution or Proxy trap (including revoked Proxies).
  if (!objectLike(value) || isProxy(value)) throw unclassified;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !Object.hasOwn(descriptor, 'value')) throw unclassified;
  return descriptor?.value;
}
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
  // The command runner decodes its own bounded Buffer. Never coerce exceptions
  // or caller objects with toString/Symbol.toPrimitive here.
  const text = typeof value === 'string' ? value.slice(0, 4096) : '';
  const found = reasons.filter(code => text.includes(code));
  if (/no space left on device/i.test(text)) found.push('ENOSPC');
  if (/permission denied/i.test(text)) found.push('EACCES');
  if (/cannot connect to the docker daemon/i.test(text)) found.push('DAEMON_UNAVAILABLE');
  if (/is (?:being used|in use)|is running/i.test(text)) found.push('RESOURCE_IN_USE');
  return Object.freeze([...new Set(found)].slice(0, 4));
}
function trackedError(map, code, detail) {
  // Use ordinary Errors: exposing a custom error.constructor must not let a
  // caller forge a trusted snapshot by instantiating that constructor directly.
  const error = new Error(code);
  map.set(error, Object.freeze(detail));
  return error;
}
export function commandFailure(binary, args, options = {}) {
  try {
    const first = dataProperty(args, '0');
    const offset = typeof first === 'string' && first.startsWith('--host=') ? 1 : 0;
    const verb = dataProperty(args, String(offset)), subverb = dataProperty(args, String(offset + 1));
    const operation = ['volume', 'image'].includes(verb)
      ? (typeof subverb === 'string' ? `${verb}:${subverb}` : 'other') : verb;
    const code = dataProperty(options, 'code'), exitCode = dataProperty(options, 'exitCode');
    const detail = { code: codes.has(code) ? code : 'COMMAND_FAILED',
      command: ['docker', 'git', 'tar'].includes(binary) ? binary : 'other',
      operation: operations.has(operation) ? operation : 'other',
      exitCode: Number.isInteger(exitCode) && Math.abs(exitCode) <= 255 ? exitCode : null,
      reasons: reasonCodes(dataProperty(options, 'stderr')) };
    return trackedError(commandDetails, detail.code, detail);
  } catch { return trackedError(commandDetails, unclassified.code, unclassified); }
}
function diagnostic(error) {
  try {
    const trusted = owned(commandDetails, error);
    if (trusted) return trusted;
    const code = dataProperty(error, 'code'), message = dataProperty(error, 'message');
    if (code !== undefined && typeof code !== 'string' || message !== undefined && typeof message !== 'string') return unclassified;
    return Object.freeze({ code: codes.has(code) ? code : codes.has(message) ? message : 'UNCLASSIFIED_FAILURE', reasons: reasonCodes(message) });
  } catch { return unclassified; }
}
// Complete all bounded teardown/verification steps even when one fails. Keep at
// most eight redacted contexts and a count; never retry a publication or cleanup.
export async function cleanupSteps(steps) {
  const failures = []; let total = 0;
  for (const step of steps) {
    try { await step(); }
    catch (error) { total++; if (failures.length < limit) failures.push(error); }
  }
  // Formatting is not on the execution path to any remaining cleanup step.
  if (total) throw trackedError(cleanupDetails, 'CLEANUP_FAILED', { failures: Object.freeze(failures.map(diagnostic)), total });
}
export async function runWithCleanup(primary, cleanup) {
  let primaryError, cleanupError, primaryFailed = false, cleanupFailed = false;
  try { await primary(); } catch (error) { primaryFailed = true; primaryError = error; }
  try { await cleanup(); }
  catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }
  // Cleanup entry does not depend on primary error classification. Private
  // identity maps replace instanceof/property reads on possibly hostile errors.
  if (primaryFailed || cleanupFailed) throw trackedError(proofDetails, 'PROOF_FAILED', {
    primary: primaryFailed ? diagnostic(primaryError) : null,
    cleanup: cleanupFailed ? owned(cleanupDetails, cleanupError) ?? { failures: [diagnostic(cleanupError)], total: 1 } : null });
}
export function failureReport(error) {
  try {
    const failure = owned(proofDetails, error) ?? { primary: diagnostic(error), cleanup: null };
    return JSON.stringify({ schemaVersion: 1, code: 'PROOF_FAILED', retry: false,
      production: 'LIVE_APPLY_BLOCKED', primary: failure.primary, cleanup: failure.cleanup });
  } catch {
    return '{"schemaVersion":1,"code":"PROOF_FAILED","retry":false,"production":"LIVE_APPLY_BLOCKED","primary":{"code":"UNCLASSIFIED_FAILURE","reasons":[]},"cleanup":null}';
  }
}
export function missingResource(stderr, kind, name) {
  // Only exact expected idempotent removal responses are benign. All other
  // nonzero exits are cleanup failures even if later inventory finds nothing.
  const text = stderr.toString().trim();
  const noun = { container: 'container', volume: 'volume', image: 'image' }[kind];
  return text === `Error response from daemon: No such ${noun}: ${name}`
    || kind === 'volume' && text === `Error response from daemon: get ${name}: no such volume`;
}
