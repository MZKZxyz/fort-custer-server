import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { operatorFixture, fixtureNow } from '../tools/test-support/operator-fixtures.mjs';
import { previewOperatorPublication } from '../tools/operator-publication/rehearsal.mjs';
import { canonicalConfig, algorithmVersion } from '../lib/maze/engine.js';
import { digest } from '../tools/operator-publication/artifacts.mjs';
import { provisionAuthorityFixture, runAuthorityFixture, inspectAuthorityFixture, reconcileAuthorityFixture } from '../tools/operator-publication/authority-fixture.mjs';
import { applyProduction } from '../tools/operator-publication/live-boundary.mjs';

const clock = () => new Date(fixtureNow);
let originalPlan;
before(async () => {
  const f = operatorFixture();
  originalPlan = (await previewOperatorPublication({ context: f.context,
    input: { date: '2026-06-01', seed: 'fortcuster-2026-06-01', version: algorithmVersion, config: canonicalConfig() },
    target: { mode: 'disposable', host: '127.0.0.1', port: 12345, replicaSet: 'fcSynthetic', database: 'fc_publication_synthetic_operator',
      collection: 'mazes', uuid: '1'.repeat(32), indexesHash: '2'.repeat(64), optionsHash: '3'.repeat(64) },
    notBefore: '2026-06-01T12:00:00.000Z', expiresAt: '2026-06-02T12:00:00.000Z', now: fixtureNow })).plan;
});
function scenario() {
  const f = operatorFixture();
  const plan = { ...structuredClone(originalPlan), releaseCertificateHash: digest(f.context.certificate) };
  const policy = { context: f.context, imageId: `sha256:${'a'.repeat(64)}`, target: plan.target, namespace: 'synthetic:fort-custer/mazes',
    resources: { account: 'synthetic-authority-account', region: 'synthetic-region', table: 'synthetic-table', tableId: randomUUID(),
      auditAccount: 'synthetic-independent-audit', bucket: 'synthetic-bucket', epoch: randomUUID() } };
  const requestFor = (p = plan, approval = f.approve(p), policyFor = policy) => {
    const image = f.seal({ kind: 'authority-fixture-image-v1', sourceSha: f.context.sourceSha, imageId: policyFor.imageId,
      releaseHash: digest(f.context.certificate), resourcesHash: digest(policyFor.resources) }, 'release');
    return { plan: p, approval, image, binding: f.seal({ kind: 'authority-fixture-scope-v1', approvalHash: digest(approval),
      imageHash: digest(image), namespace: policyFor.namespace, attemptId: randomUUID() }, 'publish') };
  };
  const request = requestFor(), root = provisionAuthorityFixture(policy);
  return { ...f, plan, root, policy, request, requestFor };
}
const withScenario = async fn => {
  const s = scenario();
  try { await fn(s); } finally { await rm(s.root, { recursive: true, force: true }); }
};
function child(s, request, hold, barrier) {
  const process = fork(new URL('../tools/test-support/authority-process.mjs', import.meta.url), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { PATH: globalThis.process.env.PATH },
  });
  process.stderr.resume();
  const timer = setTimeout(() => process.kill('SIGKILL'), 10000);
  process.once('exit', () => clearTimeout(timer));
  process.send({ root: s.root, policy: s.policy, request, hold, barrier });
  return process;
}
async function worker(s, request = s.request) {
  const process = child(s, request);
  let timer;
  try {
    const result = await Promise.race([once(process, 'message').then(([x]) => x),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('FIXTURE_WORKER_TIMEOUT')), 10000); })]);
    const exited = once(process, 'exit'); await exited;
    return result;
  } finally { clearTimeout(timer); if (process.exitCode === null) process.kill('SIGKILL'); }
}
const run = (s, extras = {}) => runAuthorityFixture(s.root, s.policy, s.request, { clock, ...extras });
function admin(s, name, fn) {
  const db = new DatabaseSync(join(s.root, `${name}.sqlite`));
  try { return fn(db); } finally { db.close(); }
}

for (const sameApproval of [true, false]) test(`independent processes atomically consume one date: same approval=${sameApproval}`, () => withScenario(async s => {
  const requests = [s.request, sameApproval ? s.requestFor(s.plan, s.request.approval) : s.requestFor()];
  const children = requests.map(r => child(s, r, undefined, true));
  const exited = children.map(p => once(p, 'exit'));
  let results;
  try {
    const ready = await Promise.all(children.map(p => once(p, 'message', { signal: AbortSignal.timeout(10000) })));
    assert.ok(ready.every(([m]) => m.state === 'PREPARED')); // both passed the non-authorizing fast read
    const pending = Promise.all(children.map(p => once(p, 'message', { signal: AbortSignal.timeout(10000) })));
    for (const p of children) p.send({ go: true });
    results = (await pending).map(([r]) => r);
    await Promise.all(exited);
  } finally {
    for (const p of children) if (p.exitCode === null) p.kill('SIGKILL');
    await Promise.all(exited);
  }
  assert.deepEqual(results.map(r => r.code).sort(), ['APPROVAL_OR_DATE_SPENT', 'INSERTED_VERIFIED']);
  assert.equal(inspectAuthorityFixture(s.root).claims, 1);
  assert.equal(inspectAuthorityFixture(s.root).submissions, 1);
  assert.equal(inspectAuthorityFixture(s.root).mazes, 1);
  const refused = results.findIndex(r => r.code === 'APPROVAL_OR_DATE_SPENT');
  if (!sameApproval) admin(s, 'authority', db => assert.equal(db.prepare('SELECT count(*) AS n FROM claims WHERE approval=?').get(requests[refused].approval.payload.approvalId).n, 0));
}));

test('approval ID independently excludes a different namespace/date key', () => withScenario(async s => {
  assert.equal((await run(s)).code, 'INSERTED_VERIFIED');
  const policy = { ...s.policy, namespace: 'synthetic:other/mazes' };
  const request = s.requestFor(s.plan, s.request.approval, policy);
  assert.equal((await runAuthorityFixture(s.root, policy, request, { clock })).code, 'APPROVAL_OR_DATE_SPENT');
  assert.equal(inspectAuthorityFixture(s.root).submissions, 1);
}));

test('fresh host/local rewind and target recreation never free logical date', () => withScenario(async s => {
  assert.equal((await worker(s)).code, 'INSERTED_VERIFIED');
  assert.equal((await worker(s)).code, 'APPROVAL_OR_DATE_SPENT');
  admin(s, 'maze', db => db.exec("DELETE FROM mazes; UPDATE target SET uuid='44444444444444444444444444444444'"));
  const policy = { ...s.policy, target: { ...s.policy.target, uuid: '4'.repeat(32) } };
  const plan = { ...s.plan, target: policy.target };
  const request = s.requestFor(plan, s.approve(plan), policy);
  assert.equal((await runAuthorityFixture(s.root, policy, request, { clock })).code, 'APPROVAL_OR_DATE_SPENT');
  assert.equal(inspectAuthorityFixture(s.root).submissions, 1);
}));

test('unknown claim ACK produces zero submits; later observed claim never becomes permission', () => withScenario(async s => {
  assert.equal((await run(s, { fault: 'claim-ack' })).code, 'CLAIM_UNCERTAIN');
  assert.equal(inspectAuthorityFixture(s.root).claims, 1);
  assert.equal(inspectAuthorityFixture(s.root).submissions, 0);
  assert.equal((await worker(s)).code, 'APPROVAL_OR_DATE_SPENT');
  assert.equal(reconcileAuthorityFixture(s.root, s.policy, s.request, fixtureNow), 'INTENT_UNCERTAIN');
}));

for (const fault of ['insert-ack', 'insert-before-commit', 'read-unavailable', 'result-audit']) test(`spent after ${fault}; recovery never writes`, () => withScenario(async s => {
  const expected = { 'insert-ack': 'RECONCILED_VERIFIED', 'insert-before-commit': 'NO_WINNER_UNCERTAIN',
    'read-unavailable': 'READ_UNCERTAIN', 'result-audit': 'AUDIT_UNCERTAIN' };
  assert.equal((await run(s, { fault })).code, expected[fault]);
  const before = inspectAuthorityFixture(s.root);
  assert.equal(before.submissions, 1);
  assert.equal(reconcileAuthorityFixture(s.root, s.policy, s.request, new Date('2026-06-03T13:00:00.000Z')),
    fault === 'insert-before-commit' ? 'NO_WINNER_UNCERTAIN'
      : ['read-unavailable', 'result-audit'].includes(fault) ? 'WINNER_VERIFIED_AUDIT_UNCERTAIN' : 'VERIFIED_WINNER');
  assert.deepEqual(inspectAuthorityFixture(s.root), before);
  assert.equal((await worker(s)).code, 'APPROVAL_OR_DATE_SPENT');
  assert.equal(inspectAuthorityFixture(s.root).submissions, 1);
}));

for (const fault of ['prepared-audit', 'intent-audit']) test(`audit unavailable at ${fault} authorizes zero inserts`, () => withScenario(async s => {
  assert.equal((await run(s, { fault })).code, fault === 'prepared-audit' ? 'AUDIT_UNAVAILABLE' : 'AUDIT_UNCERTAIN');
  assert.equal(inspectAuthorityFixture(s.root).submissions, 0);
  assert.equal(inspectAuthorityFixture(s.root).claims, fault === 'prepared-audit' ? 0 : 1);
  assert.equal((await worker(s)).code, fault === 'prepared-audit' ? 'ATTEMPT_UNCERTAIN' : 'APPROVAL_OR_DATE_SPENT');
  assert.equal(inspectAuthorityFixture(s.root).submissions, 0);
}));

for (const stage of ['PREPARED', 'CONSUMED', 'INTENT', 'SUBMITTED']) test(`expiry after ${stage} cannot lead to another submit`, () => withScenario(async s => {
  let now = fixtureNow;
  const result = await run(s, { clock: () => new Date(now), phase: async state => {
    if (state === stage) now = new Date(s.plan.expiresAt);
  } });
  assert.equal(result.code, stage === 'SUBMITTED' ? 'INSERTED_VERIFIED' : 'APPROVAL_INVALID');
  assert.equal(inspectAuthorityFixture(s.root).submissions, stage === 'SUBMITTED' ? 1 : 0);
}));

test('clock reversal and already expired approval refuse', () => withScenario(async s => {
  assert.equal((await run(s, { clock: () => new Date(s.plan.expiresAt) })).code, 'APPROVAL_INVALID');
  let now = fixtureNow;
  assert.equal((await run(s, { clock: () => new Date(now), phase: async () => { now = new Date('2026-06-01T12:59:59.000Z'); } })).code, 'CLOCK_REVERSED');
  assert.equal(inspectAuthorityFixture(s.root).claims, 0);
}));

for (const field of ['account', 'region', 'table', 'tableId', 'auditAccount', 'bucket', 'epoch']) test(`trusted resource ${field} drift refuses even with new fixture signatures`, () => withScenario(async s => {
  const policy = structuredClone(s.policy); policy.resources[field] = 'synthetic-drift';
  assert.equal((await runAuthorityFixture(s.root, policy, s.requestFor(s.plan, s.request.approval, policy), { clock })).code, 'RESOURCE_DRIFT');
  assert.equal(inspectAuthorityFixture(s.root).claims, 0);
}));

for (const change of ['source', 'image', 'target', 'signature', 'role']) test(`stale or forged ${change} cannot claim`, () => withScenario(async s => {
  const request = structuredClone(s.request), policy = structuredClone(s.policy);
  if (change === 'source') policy.context.sourceSha = '0'.repeat(40);
  if (change === 'image') policy.imageId = `sha256:${'b'.repeat(64)}`;
  if (change === 'target') policy.target.uuid = 'f'.repeat(32);
  if (change === 'signature') request.binding.signature = 'A'.repeat(86) + '==';
  if (change === 'role') request.binding = s.seal(request.binding.payload, 'release');
  assert.notEqual((await runAuthorityFixture(s.root, policy, request, { clock })).code, 'INSERTED_VERIFIED');
  assert.equal(inspectAuthorityFixture(s.root).claims, 0);
}));

test('runtime SQL guards deny update/delete of claims and external audit', () => withScenario(async s => {
  await run(s);
  for (const [name, table] of [['authority', 'claims'], ['audit', 'events']]) admin(s, name, db => {
    for (const statement of [`DELETE FROM ${table}`, `UPDATE ${table} SET body='{}'`]) assert.throws(() => db.exec(statement), /APPEND_ONLY/);
  });
  const audit = admin(s, 'audit', db => db.prepare('SELECT body FROM events').all());
  for (const row of audit) {
    const intent = JSON.parse(row.body).intent;
    assert.deepEqual(Object.keys(intent).sort(), ['kind','approvalId','namespace','attemptId','date','sourceSha','imageId','resourcesHash',
      'releaseHash','planHash','approvalHash','scopeHash','imageCertificateHash','releaseSigner','publishSigner','limitsHash','solverHash',
      'targetHash','uuid','contentHash','gridHash','notBefore','expiresAt'].sort());
    assert.ok(!/grid\"|secret|privateKey|mongodb:/.test(row.body));
  }
  assert.equal(applyProduction(s.request).code, 'LIVE_APPLY_BLOCKED');
}));

for (const stage of ['CONSUMED', 'SUBMITTED']) test(`actual worker SIGKILL at ${stage} retains claims/audit; cleanup never rearms`, () => withScenario(async s => {
  const process = child(s, s.request, stage);
  try {
    const [message] = await once(process, 'message', { signal: AbortSignal.timeout(10000) }); assert.equal(message.state, stage);
    const exited = once(process, 'exit'); process.kill('SIGKILL'); await exited;
    const snapshot = inspectAuthorityFixture(s.root);
    assert.equal(snapshot.claims, 1); assert.ok(snapshot.events >= 1);
    assert.equal(snapshot.submissions, stage === 'SUBMITTED' ? 1 : 0);
    assert.equal((await worker(s)).code, 'APPROVAL_OR_DATE_SPENT');
    assert.equal(inspectAuthorityFixture(s.root).submissions, snapshot.submissions);
  } finally { if (process.exitCode === null) process.kill('SIGKILL'); }
}));

test('missing/conflicting audit, claims and maze content never prove a winner', () => withScenario(async s => {
  await run(s);
  admin(s, 'maze', db => db.exec("UPDATE mazes SET body='{}'"));
  assert.equal(reconcileAuthorityFixture(s.root, s.policy, s.request, fixtureNow), 'CONFLICT_UNCERTAIN');
  admin(s, 'audit', db => { db.exec('DROP TRIGGER no_DELETE_events'); db.exec("DELETE FROM events WHERE kind='INTENT'"); });
  assert.equal(reconcileAuthorityFixture(s.root, s.policy, s.request, fixtureNow), 'INTENT_UNCERTAIN');
}));

test('central administrator rollback is explicitly NOT prevented by this local model', () => withScenario(async s => {
  const snapshot = await readFile(join(s.root, 'authority.sqlite'));
  await run(s);
  await writeFile(join(s.root, 'authority.sqlite'), snapshot);
  // New independently signed fixture attempt can reclaim the restored DB. This
  // negative proof prevents presenting FULL/fsync/triggers as admin rollback proof.
  const request = s.requestFor();
  assert.equal((await runAuthorityFixture(s.root, s.policy, request, { clock, fault: 'claim-ack' })).code, 'CLAIM_UNCERTAIN');
  assert.equal(inspectAuthorityFixture(s.root).submissions, 1); // original only
}));
