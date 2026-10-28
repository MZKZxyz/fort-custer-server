import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, chmod, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, fork } from 'node:child_process';
import mongoose from 'mongoose';
import Maze from '../models/Maze.js';
import { replicaSet } from '../tools/transaction-feasibility/replica-set.mjs';
import { operatorFixture, fixtureNow as now } from '../tools/test-support/operator-fixtures.mjs';
import { canonicalConfig, algorithmVersion, hash, generationIdentity } from '../lib/maze/engine.js';
import { digest } from '../tools/operator-publication/artifacts.mjs';
import { inspectDisposableTarget, previewOperatorPublication, operateDisposable } from '../tools/operator-publication/rehearsal.mjs';
import { RehearsalLedger } from '../tools/operator-publication/ledger.mjs';
import { applyProduction } from '../tools/operator-publication/live-boundary.mjs';

let rs, connection, model, commands, root, fixture, ledger, command;
const input = () => ({ date: '2026-06-01', seed: 'fortcuster-2026-06-01', version: algorithmVersion, config: { ...canonicalConfig() } });
const preview = async extras => {
  const target = extras?.target ?? await inspectDisposableTarget(model);
  return previewOperatorPublication({ context: fixture.context, input: input(), target,
    notBefore: '2026-06-01T12:00:00.000Z', expiresAt: '2026-06-02T12:00:00.000Z', now, ...extras });
};
const apply = (plan, approval, extras) => operateDisposable({ model, context: fixture.context, plan, approval: approval ?? fixture.approve(plan), ledger, clock: () => now, ...extras });
const inserts = () => commands.filter(c => c.insert);

before(async () => {
  rs = await replicaSet();
  // Owned sequential loopback rehearsal only: one connection, no hidden retries,
  // 2s discovery/connect/queue; socket 3s exceeds the 2s command budget.
  connection = await mongoose.createConnection(rs.uri.replace('/fc_synthetic?', '/fc_publication_synthetic_operator?'), {
    autoCreate: false, autoIndex: false, retryWrites: false, retryReads: false, maxPoolSize: 1, waitQueueTimeoutMS: 2000,
    serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000, socketTimeoutMS: 3000, monitorCommands: true,
  }).asPromise();
  model = connection.model('OperatorMazeFixture', Maze.schema, 'mazes');
  connection.getClient().on('commandStarted', e => commands.push(e.command));
  command = connection.db.command.bind(connection.db);
}, { timeout: 40000 });
beforeEach(async () => {
  commands = []; connection.db.command = command;
  await connection.db.dropDatabase(); await connection.db.createCollection('mazes');
  await model.collection.createIndex({ date: 1 }, { unique: true });
  await model.collection.createIndex({ publicationEra: 1, date: 1, publishedAt: 1 });
  root = await mkdtemp(join(tmpdir(), 'fc-operator-ledger-')); await chmod(root, 0o700);
  ledger = new RehearsalLedger(root); fixture = operatorFixture(); commands = [];
});
afterEach(async () => { connection.db.command = command; await rs.failOff(); await rm(root, { recursive: true, force: true }); });
after(async () => { await connection?.close(); await rs?.close(); });

test('production apply is unconditionally blocked without inspecting selectors, files, secrets, or arguments', () => {
  const hostile = new Proxy({}, { get() { throw Error('argument inspected'); } });
  assert.equal(applyProduction(hostile).code, 'LIVE_APPLY_BLOCKED');
  for (const mode of ['status', 'apply']) {
    const child = spawnSync(process.execPath, ['tools/operator-publication/cli.mjs', mode, '--uri', 'synthetic-canary'], {
      encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, MONGO_URI: 'synthetic-canary', LIVE_APPLY: 'true' },
    });
    assert.equal(child.status, mode === 'apply' ? 2 : 0); assert.equal(child.stderr, '');
    assert.equal(JSON.parse(child.stdout).code, 'LIVE_APPLY_BLOCKED'); assert.ok(!child.stdout.includes('canary'));
  }
  assert.deepEqual(commands, []);
});

test('DB-free deterministic preview binds exact release/source, target fingerprint, full config, solver and content', async () => {
  const target = await inspectDisposableTarget(model); commands = [];
  const a = await preview({ target }), b = await preview({ target });
  assert.deepEqual(a.plan, b.plan); assert.equal(a.planHash, b.planHash);
  assert.equal(a.plan.gridHash, hash(a.candidate.grid)); assert.equal(a.plan.contentHash, digest(a.candidate));
  assert.equal(a.plan.solver.status, 'solved'); assert.deepEqual(commands, []);
  assert.ok(!Object.hasOwn(a, 'approval')); assert.ok(!Object.hasOwn(a.candidate, 'publishedAt'));
  const changed = structuredClone(target); changed.indexesHash = '0'.repeat(64);
  assert.notEqual((await preview({ target: changed })).planHash, a.planHash);
});

test('release and one-date signatures fail closed before DB operations; no environment or self-generated approval', async () => {
  const { plan } = await preview(); commands = [];
  const valid = fixture.approve(plan);
  for (const mutate of [a => { a.signature = 'A'.repeat(86) + '=='; }, a => { a.payload.date = '2026-06-02'; },
    a => { a.payload.kind = 'production-apply'; }, a => { a.payload.approvedAt = '2026-06-01T14:00:00.000Z'; },
    a => { a.payload.approvalId = '*'; }, a => { a.keyId = 'synthetic-release'; }, a => { a.payload.planHash = '0'.repeat(64); }]) {
    const approval = structuredClone(valid); mutate(approval);
    assert.ok(['CERTIFICATE_INVALID', 'APPROVAL_INVALID'].includes((await apply(plan, approval)).code));
  }
  const wrong = structuredClone(fixture.context); wrong.sourceSha = '0'.repeat(40);
  assert.equal((await apply(plan, valid, { context: wrong })).code, 'CERTIFICATE_INVALID');
  const forged = structuredClone(fixture.context); forged.certificate.payload.decisionRef = 'synthetic/forged';
  assert.equal((await apply(plan, valid, { context: forged })).code, 'CERTIFICATE_INVALID');
  const pending = structuredClone(fixture.context); pending.release = JSON.parse(await readFile(new URL('../config/fresh-release.json', import.meta.url)));
  assert.equal((await apply(plan, valid, { context: pending })).code, 'CERTIFICATE_INVALID');
  assert.deepEqual(commands, []); assert.deepEqual(await readdir(root), []);
});

test('correctly signed wrong-day/expired/zero windows and malformed source/target/input never reach a write', async () => {
  const { plan } = await preview(); commands = [];
  for (const mutate of [p => { p.input.date = '2026-06-02'; }, p => { p.notBefore = p.expiresAt; },
    p => { p.expiresAt = '2026-06-01T13:00:00.000Z'; }, p => { p.target.mode = 'production'; },
    p => { delete p.input.seed; }, p => { delete p.input.config.width; }, p => { p.sourceSha = '0'.repeat(40); },
    p => { p.expiresAt = '2026-06-03T12:00:00.000Z'; },
    p => { p.input.date = '2026-05-31'; p.identityHash = generationIdentity(p.input).identityHash; }]) {
    const changed = structuredClone(plan); mutate(changed);
    assert.notEqual((await apply(changed, fixture.approve(changed))).code, 'INSERTED_VERIFIED');
  }
  assert.equal(inserts().length, 0); assert.deepEqual(await readdir(root), []);
});

test('one signed date inserts one immutable winner, consumes approval durably and reconciles read-only after expiry', async () => {
  const { plan, candidate } = await preview(), approval = fixture.approve(plan); commands = [];
  const result = await apply(plan, approval); assert.equal(result.code, 'INSERTED_VERIFIED');
  assert.deepEqual(Object.keys(result).sort(), ['approvalId', 'code', 'date', 'mode', 'planHash', 'schemaVersion', 'sourceSha']);
  const stored = await model.collection.findOne({ date: plan.input.date }); assert.deepEqual(stored.grid, candidate.grid);
  assert.equal(inserts().length, 1); assert.equal(inserts()[0].writeConcern.w, 'majority');
  assert.equal(inserts()[0].documents.length, 1); assert.equal(inserts()[0].collectionUUID.sub_type, 4);
  assert.ok(!commands.some(c => c.create || c.createIndexes || c.update || c.delete || c.collMod));
  const writesBefore = inserts().length;
  assert.equal((await apply(plan, approval)).code, 'APPROVAL_OR_DATE_SPENT');
  const restarted = new RehearsalLedger(root);
  assert.equal((await apply(plan, approval, { ledger: restarted, reconcile: true, clock: () => new Date('2026-06-03T00:00:00Z') })).code, 'VERIFIED_WINNER');
  assert.equal(inserts().length, writesBefore); assert.deepEqual(await model.collection.findOne({ date: plan.input.date }), stored);
  const journal = (await Promise.all((await readdir(root)).map(name => readFile(join(root, name), 'utf8')))).join('');
  assert.ok(!journal.includes('grid"') && !journal.includes('mongodb:') && !journal.includes('signature'));
});

test('existing old rows STOP unchanged; changed grid/certificate cannot be approved into another candidate', async () => {
  const { plan } = await preview();
  await model.collection.insertOne({ date: plan.input.date, seed: 'original', grid: [['S', 'E']], width: 2, height: 1 });
  const original = await model.collection.findOne({ date: plan.input.date }); commands = [];
  assert.equal((await apply(plan)).code, 'DATE_COLLISION'); assert.equal(inserts().length, 0);
  assert.deepEqual(await model.collection.findOne({ date: plan.input.date }), original);
  await model.collection.deleteOne({ date: plan.input.date }); commands = [];
  const changed = structuredClone(plan); changed.contentHash = '0'.repeat(64);
  assert.equal((await apply(changed)).code, 'PREVIEW_MISMATCH'); assert.equal(inserts().length, 0);
});

test('index/validator/UUID drift is refused; guard rejects ambient/remote/authenticated handles', async () => {
  const { plan } = await preview();
  await model.collection.createIndex({ seed: 1 }); commands = [];
  assert.equal((await apply(plan)).code, 'TARGET_DRIFT'); assert.equal(inserts().length, 0);
  await model.collection.dropIndex('seed_1');
  await connection.db.command({ collMod: 'mazes', validator: { date: { $type: 'string' } } }); commands = [];
  assert.equal((await apply(plan)).code, 'TARGET_DRIFT'); assert.equal(inserts().length, 0);
  for (const target of [{}, { db: { readyState: 0, getClient: () => ({ options: {} }) } }]) {
    assert.equal((await apply(plan, undefined, { model: target })).code, 'LIVE_PUBLICATION_NOT_AUTHORIZED');
  }
});

test('lost ACK/wtimeout ambiguity reconciles majority winner once; network insert failure never retries', async () => {
  const { plan } = await preview(), approval = fixture.approve(plan);
  connection.db.command = async (c, ...args) => { if (c.insert) { await command(c, ...args); throw Error('synthetic private ACK loss'); } return command(c, ...args); };
  const recovered = await apply(plan, approval); assert.equal(recovered.code, 'RECONCILED_VERIFIED'); assert.equal(inserts().length, 1);
  assert.equal((await apply(plan, approval, { reconcile: true })).code, 'VERIFIED_WINNER');
  assert.equal(inserts().length, 1);
});

test('real Mongo insert/read faults, timeout and write concern errors never produce phantom success', async () => {
  const { plan } = await preview();
  await rs.client.db('admin').command({ configureFailPoint: 'failCommand', mode: { times: 1 }, data: { failCommands: ['insert'], errorCode: 50 } });
  assert.equal((await apply(plan)).code, 'WRITE_UNCERTAIN'); assert.equal(inserts().length, 1); assert.equal(await model.countDocuments({}), 0);
  await rs.failOff();
  // Burned date is read-only after uncertainty, even if a new approval is signed.
  assert.equal((await apply(plan)).code, 'APPROVAL_OR_DATE_SPENT');
  const otherLedgerRoot = await mkdtemp(join(tmpdir(), 'fc-operator-fault-')); await chmod(otherLedgerRoot, 0o700);
  try {
    const otherLedger = new RehearsalLedger(otherLedgerRoot);
    await rs.client.db('admin').command({ configureFailPoint: 'failCommand', mode: { times: 1 }, data: { failCommands: ['find'], errorCode: 2 } });
    assert.equal((await apply(plan, undefined, { ledger: otherLedger })).code, 'VERIFICATION_UNAVAILABLE'); assert.equal(inserts().length, 1);
  } finally { await rm(otherLedgerRoot, { recursive: true, force: true }); }
});

test('drop/recreate during insert does not implicitly create or target a replacement collection', async () => {
  const { plan } = await preview();
  connection.db.command = async (c, ...args) => { if (c.insert) { await connection.db.dropCollection('mazes'); await connection.db.createCollection('mazes'); } return command(c, ...args); };
  assert.equal((await apply(plan)).code, 'WRITE_UNCERTAIN'); assert.equal(await model.countDocuments({}), 0);
});

test('clock reversal/expiry while waits are pending aborts before insert; audit intent survives', async () => {
  const { plan } = await preview(); let at = now;
  const originalClaim = ledger.claim.bind(ledger);
  ledger.claim = async record => { await originalClaim(record); at = new Date('2026-06-02T12:00:00.000Z'); };
  assert.equal((await apply(plan, undefined, { clock: () => at })).code, 'APPROVAL_INVALID'); assert.equal(inserts().length, 0);
  assert.ok((await readdir(root)).some(name => name.startsWith('approval-')));
});

test('local one-date intent resists concurrent approval reuse and unsafe ledger permissions', async () => {
  const { plan } = await preview(), approval = fixture.approve(plan);
  const outcomes = await Promise.all([apply(plan, approval), apply(plan, approval)]);
  assert.equal(outcomes.filter(r => r.code === 'INSERTED_VERIFIED').length, 1); assert.equal(inserts().length, 1);
  assert.ok(outcomes.some(r => ['GENERATOR_BUSY', 'APPROVAL_OR_DATE_SPENT'].includes(r.code)));
  await chmod(root, 0o755);
  assert.equal((await apply(plan, approval)).code, 'LEDGER_UNSAFE');
});

for (const kind of ['crash-before-insert', 'crash-after-insert', 'kill-worker']) {
  test(`real process ${kind} preserves durable authority and allows only read-only reconciliation`, async () => {
    const { plan } = await preview(), approval = fixture.approve(plan);
    const child = fork(new URL('../tools/test-support/operator-process.mjs', import.meta.url), [], {
      env: { PATH: process.env.PATH, TZ: 'UTC' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let message, errors = '';
    child.on('message', value => { message = value; }); child.stderr.on('data', chunk => { errors += chunk; });
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('OPERATOR_FIXTURE_TIMEOUT')); }, 12000);
      child.once('error', reject); child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    child.send({ uri: rs.uri.replace('/fc_synthetic?', '/fc_publication_synthetic_operator?'), context: fixture.context, plan, approval, root, kind });
    const exit = await done;
    if (kind === 'kill-worker') {
      assert.equal(exit.code, 0, errors); assert.ok(['GENERATOR_FAILED', 'WORKER_RSS_MONITOR_UNAVAILABLE'].includes(message.code), JSON.stringify(message));
      assert.equal(await model.countDocuments({}), 0); assert.deepEqual(await readdir(root), []);
      assert.equal((await apply(plan, approval)).code, 'INSERTED_VERIFIED');
    } else {
      assert.equal(exit.signal, 'SIGKILL');
      assert.equal(await model.countDocuments({}), kind === 'crash-after-insert' ? 1 : 0);
      assert.equal((await apply(plan, approval)).code, 'APPROVAL_OR_DATE_SPENT');
      const reconciliation = await apply(plan, approval, { ledger: new RehearsalLedger(root), reconcile: true });
      assert.equal(reconciliation.code, kind === 'crash-after-insert' ? 'VERIFIED_WINNER' : 'NO_WINNER_UNCERTAIN');
    }
  });
}

test('duplicate-key race reconciles exact candidate without an alternate seed', async () => {
  const { plan } = await preview();
  connection.db.command = async (c, ...args) => { if (c.insert) await command(c, ...args); return command(c, ...args); };
  assert.equal((await apply(plan)).code, 'RECONCILED_VERIFIED'); assert.equal(await model.countDocuments({}), 1);
});

test('actual write-concern ambiguity, absent primary/read failure and unsafe approvals are bounded and sanitized', async () => {
  const { plan } = await preview(), approval = fixture.approve(plan);
  await rs.client.db('admin').command({ configureFailPoint: 'failCommand', mode: { times: 1 }, data: { failCommands: ['insert'],
    writeConcernError: { code: 64, codeName: 'WriteConcernFailed', errmsg: 'synthetic-private-canary' } } });
  const result = await apply(plan, approval); assert.ok(['RECONCILED_VERIFIED', 'WRITE_UNCERTAIN'].includes(result.code));
  assert.equal(inserts().length, 1); assert.ok(!JSON.stringify(result).includes('canary'));
  await rs.failOff();
  const before = await model.collection.findOne({ date: plan.input.date });
  await rs.stepDown();
  const files = await readdir(root), intent = files.find(name => name.startsWith('approval-'));
  assert.ok(intent);
  // Preserve the original actual authority rather than creating a second insert.
  assert.deepEqual(await model.collection.findOne({ date: plan.input.date }), before);
  const disposition = await apply(plan, approval, { reconcile: true });
  assert.ok(['VERIFIED_WINNER', 'NO_WINNER_UNCERTAIN'].includes(disposition.code));
  // A write-concern fault may leave a locally visible row without a current
  // majority-visible winner. Unknown is conservative, never permission to retry.
  if (disposition.code === 'VERIFIED_WINNER') assert.ok(before);
  assert.equal(inserts().length, 1);
});

test('expired-after-generation and backwards trusted clock refuse before insert', async () => {
  const { plan } = await preview(); let samples = 0;
  const result = await apply(plan, undefined, { clock: () => ++samples === 1 ? now : new Date(now.getTime() - 1) });
  assert.equal(result.code, 'CLOCK_REVERSED'); assert.equal(inserts().length, 0); assert.deepEqual(await readdir(root), []);
});

test('offline preview CLI refuses malformed requests, redacts failures, uses exclusive private outputs and never connects', async () => {
  const { plan } = await preview(), request = { context: fixture.context, input: plan.input, target: plan.target,
    notBefore: plan.notBefore, expiresAt: plan.expiresAt };
  // Preview uses real UTC now. A synthetic past window is permitted for review,
  // but the rehearsal apply still rejects it as expired at that actual instant.
  const path = join(root, 'request.json'), output = join(root, 'review.json');
  await writeFile(path, JSON.stringify(request), { mode: 0o600 });
  commands = [];
  const run = () => spawnSync(process.execPath, ['tools/operator-publication/cli.mjs', 'preview', '--request', path, '--out', output], {
    encoding: 'utf8', timeout: 6000, env: { PATH: process.env.PATH, MONGO_URI: 'private-canary', DATABASE_URL: 'private-canary' },
  });
  const first = run(); assert.equal(first.status, 0, first.stderr); assert.equal(JSON.parse(first.stdout).planHash, digest(plan));
  assert.ok(!first.stdout.includes('grid') && !first.stdout.includes('canary'));
  assert.equal(run().status, 1); assert.equal(JSON.parse(await readFile(output)).planHash, digest(plan));
  await writeFile(path, 'x'.repeat(256 * 1024 + 1));
  assert.equal(run().status, 1);
  assert.deepEqual(commands, []);
});

test('competing old date inserted after preflight is a collision and remains immutable', async () => {
  const { plan } = await preview();
  const old = { date: plan.input.date, seed: 'synthetic-collision', grid: [['S', 'E']], width: 2, height: 1 };
  connection.db.command = async (c, ...args) => {
    if (c.insert) await model.collection.insertOne(old);
    return command(c, ...args);
  };
  assert.equal((await apply(plan)).code, 'DATE_COLLISION');
  assert.equal(await model.countDocuments({}), 1);
  assert.equal((await model.collection.findOne({ date: plan.input.date })).seed, old.seed);
});

test('actual insert connection loss is uncertain with one submit and read-only follow-up', async () => {
  const { plan } = await preview(), approval = fixture.approve(plan);
  await rs.fail({ failCommands: ['insert'], closeConnection: true });
  const result = await apply(plan, approval); assert.equal(result.code, 'WRITE_UNCERTAIN');
  await rs.failOff();
  assert.equal(inserts().length, 1); assert.equal(await model.countDocuments({}), 0);
  assert.equal((await apply(plan, approval, { reconcile: true })).code, 'NO_WINNER_UNCERTAIN');
  assert.equal(inserts().length, 1); assert.equal((await apply(plan, approval)).code, 'APPROVAL_OR_DATE_SPENT');
});

test('not-primary verification fails before intent or insert and a later healthy authorized operation succeeds', async () => {
  const { plan } = await preview(), approval = fixture.approve(plan);
  await rs.fail({ failCommands: ['find'], errorCode: 13436 });
  assert.equal((await apply(plan, approval)).code, 'VERIFICATION_UNAVAILABLE');
  await rs.failOff(); assert.equal(inserts().length, 0); assert.deepEqual(await readdir(root), []);
  assert.equal((await apply(plan, approval)).code, 'INSERTED_VERIFIED'); assert.equal(inserts().length, 1);
});

test('post-insert write-concern error verifies the actual majority winner without retry', async () => {
  const { plan } = await preview();
  connection.db.command = async (c, ...args) => {
    const result = await command(c, ...args);
    if (c.insert) result.writeConcernError = { code: 64, errmsg: 'synthetic-wtimeout' };
    return result;
  };
  assert.equal((await apply(plan)).code, 'RECONCILED_VERIFIED'); assert.equal(inserts().length, 1);
  assert.equal(await model.countDocuments({}), 1);
});

test('missing unique index and changed standalone expected grid hash stop before insert', async () => {
  const { plan } = await preview();
  const changed = structuredClone(plan); changed.gridHash = '0'.repeat(64);
  assert.equal((await apply(changed)).code, 'PREVIEW_MISMATCH'); assert.equal(inserts().length, 0);
  await model.collection.dropIndex('date_1');
  assert.equal((await apply(plan)).code, 'INDEX_NOT_READY'); assert.equal(inserts().length, 0);
});

test('caller mutation during metadata await cannot alter snapshotted release/plan or redirect a write', async () => {
  const { plan } = await preview(), approval = fixture.approve(plan), expectedSeed = plan.input.seed;
  connection.db.command = async (c, ...args) => {
    const value = await command(c, ...args);
    if (c.listCollections) { plan.input.seed = 'mutated'; plan.target.host = 'untrusted.invalid'; fixture.context.release.releaseId = 'mutated'; }
    return value;
  };
  assert.equal((await apply(plan, approval)).code, 'INSERTED_VERIFIED');
  assert.equal((await model.collection.findOne({ date: '2026-06-01' })).seed, expectedSeed);
});

test('audit completion failure preserves intent and reports verified-winner uncertainty without replaying insert', async () => {
  const { plan } = await preview(), approval = fixture.approve(plan);
  ledger.finish = async () => { throw Error('synthetic-private-canary'); };
  const result = await apply(plan, approval); assert.equal(result.code, 'VERIFIED_WINNER_AUDIT_UNAVAILABLE');
  assert.ok(!JSON.stringify(result).includes('canary')); assert.equal(inserts().length, 1);
  assert.equal((await apply(plan, approval, { ledger: new RehearsalLedger(root), reconcile: true })).code, 'VERIFIED_WINNER');
  assert.equal(inserts().length, 1);
});
