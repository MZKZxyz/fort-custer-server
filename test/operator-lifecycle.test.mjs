import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, chmod, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare, receipt, containerLabels, recover, status, readRecord, appendRecord } from '../tools/operator-publication/isolation/lifecycle.mjs';

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
