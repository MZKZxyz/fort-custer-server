import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, chmod, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { missingResource, commandFailure, failureReport } from '../tools/operator-publication/isolation/proof-outcome.mjs';
import { prepare, receipt, containerLabels, recover, status, readRecord, appendRecord, assertPolicy } from '../tools/operator-publication/isolation/lifecycle.mjs';

const policy = { sourceSha: 'a'.repeat(40), imageId: `sha256:${'b'.repeat(64)}` };
const id = 'c'.repeat(64);
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fc18a-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const intent = await prepare(dir, policy); await receipt(dir, id);
  let present = true;
  const mutations = [];
  const spec = { Id: id, Name: `/${intent.name}`, Image: policy.imageId, Config: { Labels: containerLabels(intent) },
    HostConfig: { RestartPolicy: { Name: 'no' }, AutoRemove: false, CgroupParent: '' }, State: { Running: true, Pid: 123 } };
  const call = async args => {
    if (args[0] === 'ps') return present ? id + '\n' : '';
    if (args[0] === 'inspect') return JSON.stringify([spec]);
    if (args[0] === 'kill') { spec.State = { Running: false, Pid: 0 }; return id; }
    if (args[0] === 'rm') { mutations.push(args); present = false; return id; }
    throw Error('UNEXPECTED_COMMAND');
  };
  return { dir, intent, spec, mutations, call };
}
test('fixture cleanup is exact-ID only, idempotent, retains consumed and audit bytes', async t => {
  const f = await fixture(t);
  await appendRecord(f.dir, 'audit.json', { consumed: true });
  const before = await Promise.all(['spent.json', 'intent.json', 'receipt.json', 'audit.json'].map(n => readFile(join(f.dir, n), 'utf8')));
  let fenced = false;
  const call = args => { if (args[0] === 'rm') assert.equal(fenced, true); return f.call(args); };
  assert.equal((await recover(f.dir, { call, fence: async () => { fenced = true; } })).retry, false);
  await recover(f.dir, { call });
  assert.deepEqual(f.mutations, [['rm', id]]);
  assert.deepEqual(await Promise.all(['spent.json', 'intent.json', 'receipt.json', 'audit.json'].map(n => readFile(join(f.dir, n), 'utf8'))), before);
  await assert.rejects(prepare(f.dir, policy), /SPENT_OR_UNCERTAIN/);
});
test('status is read-only and cannot restore authority', async t => {
  const f = await fixture(t); const before = await readdir(f.dir);
  assert.deepEqual((await status(f.dir, f.call)).retry, false);
  assert.deepEqual(await readdir(f.dir), before); assert.deepEqual(f.mutations, []);
});
test('installed policy drift cannot authorize recovery of a different intent', async t => {
  const f = await fixture(t);
  const expected = { ...policy, cgroupParent: '' };
  assert.doesNotThrow(() => assertPolicy(f.intent, expected));
  for (const change of [{ sourceSha: 'd'.repeat(40) }, { imageId: `sha256:${'d'.repeat(64)}` }, { cgroupParent: 'fc18aproof.slice' }]) {
    assert.throws(() => assertPolicy(f.intent, { ...expected, ...change }), /POLICY_DRIFT/);
  }
  assert.deepEqual(f.mutations, []);
});
for (const [name, mutate] of Object.entries({
  'bad labels': s => { s.Config.Labels['org.fort-custer.intent'] = 'wrong'; },
  'wrong image': s => { s.Image = `sha256:${'d'.repeat(64)}`; },
  'wrong name': s => { s.Name = '/unrelated'; },
  'wrong ID': s => { s.Id = 'd'.repeat(64); },
  'restart enabled': s => { s.HostConfig.RestartPolicy.Name = 'always'; },
  'auto remove': s => { s.HostConfig.AutoRemove = true; },
  'wrong cgroup': s => { s.HostConfig.CgroupParent = 'other.slice'; },
})) test(`fixture refuses ${name} without deletion`, async t => {
  const f = await fixture(t); mutate(f.spec);
  await assert.rejects(recover(f.dir, { call: f.call }), /DRIFT/);
  assert.deepEqual(f.mutations, []); assert.equal((await readRecord(f.dir, 'STOP.json')).retry, false);
});
test('extra job-scoped ID, changed label inventory and missing receipt quarantine', async t => {
  const f = await fixture(t);
  await assert.rejects(recover(f.dir, { call: async args => args[0] === 'ps' ? `${id}\n${'d'.repeat(64)}` : f.call(args) }), /INVENTORY_DRIFT/);
  let queries = 0;
  await assert.rejects(recover(f.dir, { call: async args => args[0] === 'ps' ? (++queries === 1 ? '' : id) : f.call(args) }), /LABEL_DRIFT/);
  await rm(join(f.dir, 'receipt.json'));
  await assert.rejects(recover(f.dir, { call: f.call }), { code: 'ENOENT' });
  assert.deepEqual(f.mutations, []);
});
test('daemon loss and failure during cleanup stay spent; reconnect only cleans', async t => {
  const f = await fixture(t);
  for (const failAt of ['ps', 'inspect', 'kill', 'rm']) {
    await assert.rejects(recover(f.dir, { call: args => args[0] === failAt ? Promise.reject(Error('DAEMON_UNCERTAIN')) : f.call(args) }), /DAEMON_UNCERTAIN/);
    await assert.rejects(prepare(f.dir, policy), /SPENT_OR_UNCERTAIN/);
  }
  await recover(f.dir, { call: f.call }); assert.equal(f.mutations.length, 1);
});
test('stopped state with nonzero PID refuses removal', async t => {
  const f = await fixture(t); f.spec.State = { Running: false, Pid: 123 };
  await assert.rejects(recover(f.dir, { call: f.call }), /TERMINATION_UNCERTAIN/);
  assert.deepEqual(f.mutations, []);
});
test('failed fence or STOP persistence prevents any daemon operation', async t => {
  const f = await fixture(t); let called = false;
  const call = async () => { called = true; throw Error('SHOULD_NOT_CALL'); };
  await assert.rejects(recover(f.dir, { call, fence: async () => { throw Error('FENCE_UNAVAILABLE'); } }), /FENCE_UNAVAILABLE/);
  await rm(join(f.dir, 'STOP.json')); await symlink('/dev/null', join(f.dir, 'STOP.json'));
  // Existing STOP must itself be verified, not silently trusted.
  await assert.rejects(recover(f.dir, { call }));
  assert.equal(called, false);
});
test('exclusive claim serializes concurrent prepares and incomplete state never rearms', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fc18a-concurrent-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const results = await Promise.allSettled([prepare(dir, policy), prepare(dir, policy)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await rm(join(dir, 'intent.json'));
  await assert.rejects(prepare(dir, policy), /SPENT_OR_UNCERTAIN/);
});
test('bad permissions, symlink receipt, corrupt/oversize state fail closed', async t => {
  const f = await fixture(t);
  await chmod(f.dir, 0o755); await assert.rejects(status(f.dir, f.call), /UNPROTECTED/); await chmod(f.dir, 0o700);
  await rm(join(f.dir, 'receipt.json')); await symlink('/dev/null', join(f.dir, 'receipt.json'));
  await assert.rejects(status(f.dir, f.call)); await rm(join(f.dir, 'receipt.json'));
  await writeFile(join(f.dir, 'receipt.json'), 'x'.repeat(16385), { mode: 0o600 });
  await assert.rejects(status(f.dir, f.call), /UNPROTECTED/);
  await writeFile(join(f.dir, 'receipt.json'), '{'); await assert.rejects(status(f.dir, f.call));
  assert.deepEqual(f.mutations, []);
});
test('corrupt STOP refuses cleanup; no full-disk guarantee asserted', async t => {
  const f = await fixture(t);
  // A corrupt existing record exercises the exclusive-file failure path without
  // exhausting the shared filesystem. ENOSPC power-loss behavior is NOT proven.
  await writeFile(join(f.dir, 'STOP.json'), 'corrupt', { mode: 0o600 });
  await assert.rejects(recover(f.dir, { call: f.call })); assert.deepEqual(f.mutations, []);
});

async function failureProcess(t, scenario) {
  const dir = await mkdtemp(join(tmpdir(), 'fc18a-outcome-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const evidence = join(dir, 'success.json'), trace = join(dir, 'trace.jsonl');
  const child = spawn(process.execPath, ['tools/test-support/proof-failure-process.mjs', scenario, evidence, trace]);
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const [code, signal] = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve([code, signal]));
  });
  clearTimeout(timer);
  assert.equal(signal, null); assert.equal(stdout, '');
  assert.ok(stderr.length < 4096);
  for (const value of ['synthetic-private-canary', 'mongodb://', 'private-key=', 'grid=', 'signature=', 'spawnargs', 'stack']) assert.ok(!stderr.includes(value));
  return { code, stderr, evidence, trace: (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse) };
}
for (const scenario of ['primary', 'cleanup', 'combined']) test(`proof ${scenario} failure exits nonzero, preserves phase contexts and never publishes`, async t => {
  const result = await failureProcess(t, scenario);
  assert.equal(result.code, 1);
  await assert.rejects(readFile(result.evidence), { code: 'ENOENT' });
  const report = JSON.parse(result.stderr);
  assert.equal(report.code, 'PROOF_FAILED'); assert.equal(report.retry, false);
  assert.equal(report.production, 'LIVE_APPLY_BLOCKED');
  assert.deepEqual(result.trace, [{ phase: 'primary' }, { phase: 'cleanup', args: ['rm', '-f', 'a'.repeat(64)] }, { phase: 'verify' }]);
  if (scenario !== 'cleanup') {
    assert.equal(report.primary.operation, 'start'); assert.equal(report.primary.exitCode, 31);
    assert.deepEqual(report.primary.reasons, ['QA_PRIMARY_PROVISION_FAILURE']);
  } else assert.equal(report.primary, null);
  if (scenario !== 'primary') {
    assert.equal(report.cleanup.total, 2);
    assert.equal(report.cleanup.failures[0].operation, 'rm'); assert.equal(report.cleanup.failures[0].exitCode, 32);
    assert.deepEqual(report.cleanup.failures[0].reasons, ['QA_SECONDARY_CLEANUP_FAILURE']);
    assert.deepEqual(report.cleanup.failures[1].reasons, ['DISPOSAL_INCOMPLETE']);
  } else assert.equal(report.cleanup, null);
});
test('proof success publishes only after primary, cleanup and verification finish', async t => {
  const result = await failureProcess(t, 'success');
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(await readFile(result.evidence)), { synthetic: true });
  assert.equal(result.trace.at(-1).phase, 'verify');
});
test('cleanup failure collection stays bounded and still attempts every step', async t => {
  const result = await failureProcess(t, 'overflow');
  assert.equal(result.code, 1); await assert.rejects(readFile(result.evidence), { code: 'ENOENT' });
  const report = JSON.parse(result.stderr);
  assert.equal(report.cleanup.total, 20); assert.equal(report.cleanup.failures.length, 8);
  assert.equal(result.trace.filter(row => row.phase === 'additional-cleanup').length, 20);
});
for (const scenario of ['unknown', 'falsy']) test(`proof ${scenario} exception cannot leak secrets or become success`, async t => {
  const result = await failureProcess(t, scenario);
  assert.equal(result.code, 1); await assert.rejects(readFile(result.evidence), { code: 'ENOENT' });
  assert.equal(JSON.parse(result.stderr).primary.code, 'UNCLASSIFIED_FAILURE');
  assert.equal(result.trace.at(-1).phase, 'verify');
});
test('only exact already-absent resource responses are benign cleanup', () => {
  const expected = 'Error response from daemon: No such container: owned-id';
  assert.equal(missingResource(Buffer.from(expected), 'container', 'owned-id'), true);
  assert.equal(missingResource(Buffer.from(expected), 'container', 'other-id'), false);
  assert.equal(missingResource(Buffer.from(expected + '\nQA_SECONDARY_CLEANUP_FAILURE'), 'container', 'owned-id'), false);
  assert.equal(missingResource(Buffer.from('Error response from daemon: get owned-volume: no such volume'), 'volume', 'owned-volume'), true);
});
test('command diagnostics cannot print arbitrary command arguments or error properties', () => {
  const error = commandFailure('secret-binary', ['secret-operation', 'password=synthetic-private-canary'], { exitCode: 999, stderr: 'synthetic-private-canary' });
  error.secret = 'synthetic-private-canary';
  const text = failureReport(error), report = JSON.parse(text);
  assert.ok(!text.includes('synthetic-private-canary'));
  assert.equal(report.primary.command, 'other'); assert.equal(report.primary.operation, 'other'); assert.equal(report.primary.exitCode, null);
});

for (const phase of ['primary', 'cleanup']) for (const kind of ['code-getter', 'message-getter', 'proxy', 'revoked-proxy', 'nested-proxy', 'unprintable', 'symbol', 'prototype-proxy']) {
  test(`hostile ${kind} in ${phase} cannot prevent cleanup or verification`, async t => {
    const result = await failureProcess(t, `hostile-${phase}-${kind}`);
    assert.equal(result.code, 1); await assert.rejects(readFile(result.evidence), { code: 'ENOENT' });
    const report = JSON.parse(result.stderr), fallback = { code: 'UNCLASSIFIED_FAILURE', reasons: [] };
    assert.deepEqual(result.trace, [{ phase: 'primary' }, { phase: 'cleanup', args: ['rm', '-f', 'a'.repeat(64)] },
      { phase: 'verify' }, { phase: 'format-traps', calls: 0 }]);
    assert.equal(report.code, 'PROOF_FAILED'); assert.equal(report.retry, false);
    if (phase === 'primary') { assert.deepEqual(report.primary, fallback); assert.equal(report.cleanup, null); }
    else { assert.equal(report.primary, null); assert.equal(report.cleanup.total, 1); assert.deepEqual(report.cleanup.failures, [fallback]); }
  });
}
test('hostile primary and cleanup exceptions retain separate fallback contexts', async t => {
  const result = await failureProcess(t, 'hostile-combined-proxy');
  assert.equal(result.code, 1); await assert.rejects(readFile(result.evidence), { code: 'ENOENT' });
  const report = JSON.parse(result.stderr), fallback = { code: 'UNCLASSIFIED_FAILURE', reasons: [] };
  assert.deepEqual(report.primary, fallback); assert.deepEqual(report.cleanup.failures, [fallback]);
  assert.equal(report.cleanup.total, 1);
  assert.deepEqual(result.trace.slice(-2), [{ phase: 'verify' }, { phase: 'format-traps', calls: 0 }]);
});
test('hostile cleanup overflow attempts all 25 steps and final inventory before bounded formatting', async t => {
  const result = await failureProcess(t, 'hostile-overflow-proxy');
  assert.equal(result.code, 1); await assert.rejects(readFile(result.evidence), { code: 'ENOENT' });
  const report = JSON.parse(result.stderr);
  assert.equal(report.cleanup.total, 25); assert.equal(report.cleanup.failures.length, 8);
  assert.ok(report.cleanup.failures.every(f => f.code === 'UNCLASSIFIED_FAILURE'));
  assert.equal(result.trace.filter(row => row.phase === 'additional-cleanup').length, 25);
  assert.deepEqual(result.trace.slice(-2), [{ phase: 'verify' }, { phase: 'format-traps', calls: 0 }]);
});
test('direct failure reporting rejects hostile objects without executing their code', () => {
  let calls = 0; const trap = () => { calls++; throw Error('synthetic-private-canary'); };
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const error of [{ get code() { return trap(); } }, new Proxy({}, { getPrototypeOf: trap, get: trap }), revoked.proxy,
    { message: { toString: trap, [Symbol.toPrimitive]: trap } }, Symbol('synthetic-private-canary'), 0n, null, undefined]) {
    const text = failureReport(error), report = JSON.parse(text);
    assert.ok(text.length < 512); assert.ok(!text.includes('synthetic-private-canary'));
    assert.deepEqual(report.primary, { code: 'UNCLASSIFIED_FAILURE', reasons: [] });
  }
  assert.equal(calls, 0);
});
test('trusted diagnostic snapshots cannot be poisoned by public error accessors', async t => {
  const result = await failureProcess(t, 'hostile-primary-branded');
  assert.equal(result.code, 1); await assert.rejects(readFile(result.evidence), { code: 'ENOENT' });
  const report = JSON.parse(result.stderr);
  assert.equal(report.primary.code, 'COMMAND_FAILED'); assert.equal(report.primary.operation, 'start');
  assert.deepEqual(report.primary.reasons, ['QA_PRIMARY_PROVISION_FAILURE']);
  assert.deepEqual(result.trace.slice(-2), [{ phase: 'verify' }, { phase: 'format-traps', calls: 0 }]);
});
test('reason extraction never coerces caller-supplied objects', () => {
  let calls = 0; const trap = () => { calls++; throw Error('synthetic-private-canary'); };
  const error = commandFailure('docker', ['start'], { stderr: { toString: trap, [Symbol.toPrimitive]: trap } });
  const report = JSON.parse(failureReport(error));
  assert.equal(calls, 0); assert.deepEqual(report.primary.reasons, []);
});
test('public error constructors and forged prototypes cannot mint trusted diagnostics', () => {
  const genuine = commandFailure('docker', ['start']);
  let calls = 0; const trap = () => { calls++; throw Error('synthetic-private-canary'); };
  const forged = Object.create(Object.getPrototypeOf(genuine));
  Object.defineProperty(forged, 'detail', { get: trap });
  const constructed = new genuine.constructor('synthetic-private-canary');
  constructed.detail = { code: 'synthetic-private-canary', reasons: ['synthetic-private-canary'] };
  for (const error of [forged, constructed]) {
    const text = failureReport(error);
    assert.ok(!text.includes('synthetic-private-canary'));
    assert.deepEqual(JSON.parse(text).primary, { code: 'UNCLASSIFIED_FAILURE', reasons: [] });
  }
  assert.equal(calls, 0);
});
