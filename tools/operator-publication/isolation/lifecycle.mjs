// Trusted fixture supervisor helpers, not a publication API or production authority.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, lstat, mkdir, realpath, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const labels = { scope: 'org.fort-custer.proof', job: 'org.fort-custer.job', intent: 'org.fort-custer.intent' };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refuse = code => { throw Error(code); };
const exact = (value, keys) => {
  if (!value || Object.keys(value).sort().join() !== keys.sort().join()) refuse('STATE_INVALID');
};

// Each CLI child is bounded independently of Docker availability. This timer is
// NOT a durable job deadline. systemd and the dedicated frozen cgroup are external.
export async function docker(args, { timeout = 5000, input, max = 256 * 1024 } = {}) {
  const env = { ...process.env };
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete env[key];
  return new Promise((resolvePromise, reject) => {
    const child = spawn('docker', ['--host=unix:///var/run/docker.sock', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', size = 0, failure;
    const timer = setTimeout(() => { failure = Error('DAEMON_UNCERTAIN'); child.kill('SIGKILL'); }, timeout);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
      size += bytes.length;
      if (size > max) { failure = Error('DAEMON_OUTPUT_LIMIT'); child.kill('SIGKILL'); }
      else if (stream === child.stdout) out += bytes;
    });
    child.once('error', () => { clearTimeout(timer); reject(Error('DAEMON_UNAVAILABLE')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0) reject(failure ?? Error('DAEMON_UNCERTAIN'));
      else resolvePromise(out);
    });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}

// State is private to the trusted supervisor. Ancestors must also be protected
// for the installed fixture; the fixed host entrypoint checks those separately.
export async function privateDirectory(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
      || (stat.mode & 0o077) || await realpath(path) !== resolve(path)) refuse('STATE_UNPROTECTED');
}
export async function readRecord(dir, name) {
  await privateDirectory(dir);
  const file = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.nlink !== 1 || stat.size > 16384) refuse('STATE_UNPROTECTED');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}
export async function appendRecord(dir, name, value) {
  await privateDirectory(dir);
  const file = await open(join(dir, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); }
  finally { await file.close(); }
  const directory = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function quarantine(dir) {
  try { await appendRecord(dir, 'STOP.json', { disposition: 'STOP_READ_ONLY_RECONCILIATION', retry: false }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readRecord(dir, 'STOP.json');
    exact(existing, ['disposition', 'retry']);
    if (existing.disposition !== 'STOP_READ_ONLY_RECONCILIATION' || existing.retry !== false) refuse('STOP_INVALID');
  }
}
function validateIntent(intent) {
  exact(intent, ['kind', 'jobId', 'name', 'imageId', 'sourceSha', 'cgroupParent']);
  if (intent.kind !== 'fc18a-disposable-v1' || !/^[a-f0-9-]{36}$/.test(intent.jobId)
      || intent.name !== `fc18a-${intent.jobId}` || !/^sha256:[a-f0-9]{64}$/.test(intent.imageId)
      || !/^[a-f0-9]{40}$/.test(intent.sourceSha)
      || !['', 'fc18aproof.slice'].includes(intent.cgroupParent)) refuse('INTENT_INVALID');
  return intent;
}
export async function loadIntent(dir) {
  const intent = validateIntent(await readRecord(dir, 'intent.json'));
  const spent = await readRecord(dir, 'spent.json');
  exact(spent, ['intentHash']);
  if (spent.intentHash !== hash(intent)) refuse('SPENT_STATE_INVALID');
  return intent;
}
export async function prepare(dir, { imageId, sourceSha, cgroupParent = '' }) {
  // Existing spent state (even a partial/corrupt one) refuses before any daemon call.
  await privateDirectory(dir);
  if ((await readdir(dir)).length) refuse('ATTEMPT_SPENT_OR_UNCERTAIN');
  const jobId = randomUUID();
  const intent = validateIntent({ kind: 'fc18a-disposable-v1', jobId, name: `fc18a-${jobId}`, imageId, sourceSha, cgroupParent });
  await appendRecord(dir, 'spent.json', { intentHash: hash(intent) });
  await appendRecord(dir, 'intent.json', intent);
  return intent;
}
export function containerLabels(intent) {
  return { [labels.scope]: intent.kind, [labels.job]: intent.jobId, [labels.intent]: hash(intent) };
}
export async function receipt(dir, id) {
  const intent = await loadIntent(dir);
  if (!/^[a-f0-9]{64}$/.test(id)) refuse('RECEIPT_INVALID');
  await appendRecord(dir, 'receipt.json', { intentHash: hash(intent), id });
}
async function inventory(dir, call) {
  const intent = await loadIntent(dir), record = await readRecord(dir, 'receipt.json');
  exact(record, ['intentHash', 'id']);
  if (record.intentHash !== hash(intent) || !/^[a-f0-9]{64}$/.test(record.id)) refuse('RECEIPT_INVALID');
  const ids = (await call(['ps', '-aq', '--no-trunc', '--filter', `label=${labels.scope}=${intent.kind}`,
    '--filter', `label=${labels.job}=${intent.jobId}`])).trim().split(/\s+/).filter(Boolean);
  if (ids.some(id => id !== record.id) || ids.length > 1) refuse('INVENTORY_DRIFT');
  // Exact-ID lookup distinguishes absence from drift without a global inventory.
  const all = (await call(['ps', '-aq', '--no-trunc', '--filter', `id=${record.id}`])).trim().split(/\s+/).filter(Boolean);
  if (!ids.length) {
    if (all.includes(record.id)) refuse('LABEL_DRIFT');
    return { intent, id: record.id, present: false };
  }
  const rows = JSON.parse(await call(['inspect', record.id]));
  if (!Array.isArray(rows) || rows.length !== 1) refuse('INSPECT_INVALID');
  const spec = rows[0], expected = containerLabels(intent);
  if (spec.Id !== record.id || spec.Name !== `/${intent.name}` || spec.Image !== intent.imageId
      || Object.entries(expected).some(([key, value]) => spec.Config?.Labels?.[key] !== value)
      || spec.HostConfig?.RestartPolicy?.Name !== 'no' || spec.HostConfig?.AutoRemove
      || (spec.HostConfig?.CgroupParent ?? '') !== intent.cgroupParent) refuse('CONTAINER_DRIFT');
  return { intent, id: record.id, present: true, state: spec.State };
}
export async function status(dir, call = docker) {
  const result = await inventory(dir, call);
  return { jobId: result.intent.jobId, id: result.id, present: result.present,
    running: result.state?.Running ?? false, spent: true, retry: false, production: 'LIVE_APPLY_BLOCKED' };
}
export async function recover(dir, { call = docker, fence = async () => {} } = {}) {
  // STOP must be durable BEFORE any destructive action. Failed retention => stop.
  await quarantine(dir);
  await fence(); // host freezes and kills the dedicated subtree even without daemon
  const result = await inventory(dir, call);
  if (result.present) {
    if (result.state?.Running === true) await call(['kill', '--signal=KILL', result.id]);
    const stopped = await inventory(dir, call);
    if (!stopped.present || stopped.state?.Running !== false || stopped.state?.Pid !== 0) refuse('TERMINATION_UNCERTAIN');
    await call(['rm', result.id]); // one exact, validated, observed stopped ID
    const after = await inventory(dir, call);
    if (after.present) refuse('CLEANUP_UNCERTAIN');
  }
  return { code: 'RESOURCES_ABSENT_AUTHORITY_STILL_SPENT', retry: false };
}
export async function makeState(parent) {
  const dir = join(parent, randomUUID()); await mkdir(dir, { mode: 0o700 }); return dir;
}
