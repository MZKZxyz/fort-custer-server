import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import mongoose from 'mongoose';
import { assessSchema, assessmentPlans, MAX_TIME_MS, SHARED_COLLECTIONS } from '../tools/release/schema-assessment.mjs';
import { until } from '../tools/transaction-feasibility/replica-set.mjs';

const { MongoClient, Int32, Double, Long, Decimal128 } = mongoose.mongo;
const databaseName = 'fc_audit_synthetic';
const scope = { databaseName, collectionNames: ['users', 'mazes', 'rewarditems'], dedicatedDatabaseConfirmed: true };
const timeouts = { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, socketTimeoutMS: 15000 };
const canary = 'PRIVATE_SYNTHETIC_CANARY';
const uuid = '12345678-1234-1234-1234-123456789abc';
let dir, child, admin, reader, writer, db, adminDb;

before(async () => {
  // Authenticated, isolated replica set: no environment URI, shared dbpath or production roles.
  dir = await mkdtemp(join(tmpdir(), 'fc-audit-test-'));
  const keyFile = join(dir, 'key');
  await writeFile(keyFile, randomBytes(96).toString('base64'), { mode: 0o600 });
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  child = spawn(process.env.MONGOD_BINARY || 'mongod', ['--dbpath', dir, '--bind_ip', '127.0.0.1',
    '--port', String(port), '--replSet', 'fcAudit', '--auth', '--keyFile', keyFile,
    '--setParameter', 'enableTestCommands=1', '--wiredTigerCacheSizeGB', '0.25', '--logpath', join(dir, 'mongo.log')], { stdio: 'ignore' });
  let failed = false;
  child.once('error', () => { failed = true; }); child.once('exit', () => { failed = true; });
  const direct = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, timeouts);
  try {
    await until(async () => { if (failed) throw Error('Synthetic Mongo startup failed'); await direct.connect(); return (await direct.db('admin').command({ ping: 1 })).ok; });
    await direct.db('admin').command({ replSetInitiate: { _id: 'fcAudit', members: [{ _id: 0, host: `127.0.0.1:${port}` }] } });
    await until(async () => (await direct.db('admin').command({ hello: 1 })).isWritablePrimary);
    // Localhost exception creates only the owned fixture's bootstrap principal.
    await direct.db('admin').command({ createUser: 'synthetic-bootstrap', pwd: 'synthetic-bootstrap-password', roles: ['root'] });
  } finally { await direct.close(); }
  const uri = `mongodb://127.0.0.1:${port}/?replicaSet=fcAudit`;
  const connect = async (username, password) => {
    const client = new MongoClient(uri, { ...timeouts, authSource: 'admin', auth: { username, password } });
    await client.connect(); return client;
  };
  admin = await connect('synthetic-bootstrap', 'synthetic-bootstrap-password'); adminDb = admin.db(databaseName);
  for (const name of scope.collectionNames) await adminDb.createCollection(name);
  for (const [user, role] of [['synthetic-reader', 'read'], ['synthetic-writer', 'readWrite']]) {
    await admin.db('admin').command({ createUser: user, pwd: 'synthetic-only-password', roles: [{ role, db: databaseName }] });
  }
  reader = await connect('synthetic-reader', 'synthetic-only-password'); db = reader.db(databaseName);
  writer = await connect('synthetic-writer', 'synthetic-only-password');
}, { timeout: 50000 });

after(async () => {
  await Promise.all([admin, reader, writer].filter(Boolean).map(client => client.close()));
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited;
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const name of scope.collectionNames) await adminDb.collection(name).deleteMany({});
  await adminDb.collection('mazes').insertOne({ date: '2025-05-26' });
});
async function legacyFixture() {
  await adminDb.collection('users').insertOne({ __v: new Int32(0), email: canary, password: canary,
    subProfiles: [{ _id: canary, name: canary, rewards: { retired: 7, zero: 0, compass: 2 },
      progress: { '2025-05-26': { completed: true, time: '12.345' } },
      attempts: { '2025-05-26': [
        { started: new Date('2025-05-26T12:00:00Z'), completed: false },
        { started: new Date('2025-05-26T12:00:00Z'), completed: true },
        { started: new Date('2025-05-26T12:00:00Z'), attemptId: uuid, completed: true, result: { private: canary } },
      ] } }, { name: canary }] });
  await adminDb.collection('rewarditems').insertOne({ id: canary, name: canary, image: canary,
    description: canary, category: 'tool', rarity: 'common' });
}
const assess = approval => assessSchema(db, approval ?? scope);

test('authenticated read-only replica-set assessment preserves valid legacy shapes and emits counts only', async () => {
  await legacyFixture();
  const before = await adminDb.collection('users').find().toArray();
  const report = await assess();
  assert.equal(report.complete, true); assert.equal(report.disposition, 'OWNER_REVIEW_REQUIRED');
  assert.deepEqual(report.metadata, { mongoMajor: 8, mongoMinor: 0, mongoPatch: 16,
    topology: 'replica-set', readConcern: 'majority', atomicSnapshot: false });
  assert.equal(report.counts.users.versionInt, 1); assert.equal(report.counts.users.versionInvalid, 0);
  assert.equal(report.counts.profiles.rewardsMissing, 1); assert.equal(report.counts.profiles.rewardsMalformed, 0);
  assert.equal(report.counts.inventory.zeroQuantities, 1); assert.equal(report.counts.inventory.multipleQuantities, 2);
  assert.equal(report.counts.inventory.invalidQuantities, 0); assert.equal(report.counts.attempts.activeIdless, 1);
  assert.equal(report.counts.attempts.completedWithoutSnapshot, 1); assert.equal(report.counts.attempts.savedSnapshots, 1);
  assert.equal(report.counts.attempts.withUuid, 1); assert.equal(report.counts.attempts.withoutId, 2);
  assert.equal(JSON.stringify(report).includes(canary), false); assert.equal(JSON.stringify(report).includes(uuid), false);
  assert.equal(JSON.stringify(report).includes(databaseName), false);
  assert.deepEqual(await adminDb.collection('users').find().toArray(), before);
  await assert.rejects(db.collection('users').insertOne({}), { code: 13 });
});

test('raw BSON versions are classified before casting, including non-finite and unsafe numbers', async () => {
  const versions = [undefined, null, new Int32(0), Long.fromNumber(2), new Double(1), Decimal128.fromString('2'),
    -1, 1.5, '0', 'bad', NaN, Infinity, Long.fromString('9007199254740992'), true, {}];
  await adminDb.collection('users').insertMany(versions.map(version => ({
    ...(version === undefined ? {} : { __v: version }), subProfiles: [], email: canary,
  })));
  const c = (await assess()).counts.users;
  assert.equal(c.total, 15); assert.equal(c.versionMissing, 1); assert.equal(c.versionNull, 1);
  assert.equal(c.versionString, 2); assert.equal(c.versionOther, 2); assert.equal(c.versionInvalid, 11);
});

test('malformed containers, map rows, quantities and attempts are counted without discarding malformed parents', async () => {
  await adminDb.collection('users').insertMany([
    { __v: 0, subProfiles: 'bad' }, { __v: 0 },
    { __v: 0, subProfiles: [null, ['bad'], 3, { attempts: null, progress: [], rewards: 'bad' },
      { rewards: { negative: -1, fraction: 0.5, castable: '2', bad: 'bad', 'a.b': 1, constructor: 1 },
        progress: { 'bad-date': 'bad', '2025-05-26': { completed: true, time: '9.000' } },
        attempts: { 'bad-date': 'bad', '2025-05-26': [null, 7,
          { started: 'bad', completed: 'yes', attemptId: canary, result: canary },
          { started: new Date('2099-01-01T00:00:00Z'), completed: false },
        ] } },
    ] },
  ]);
  const { counts: c } = await assess();
  assert.equal(c.users.profilesMalformed, 1); assert.equal(c.users.profilesMissing, 1);
  assert.equal(c.profiles.malformedElements, 3); assert.equal(c.profiles.rewardsMalformed, 1);
  assert.equal(c.inventory.invalidQuantities, 4); assert.equal(c.inventory.numericStringQuantities, 1);
  assert.equal(c.inventory.unsafeKeys, 2); assert.equal(c.attemptDates.malformedArrays, 1);
  assert.equal(c.attemptDates.invalidDateKeys, 1); assert.equal(c.attempts.malformedElements, 2);
  assert.equal(c.attempts.invalidStarts, 1); assert.equal(c.attempts.futureStarts, 1);
  assert.equal(c.attempts.invalidCompletedFlags, 1); assert.equal(c.attempts.malformedSnapshots, 1);
  assert.equal(c.progress.malformedEntries, 1); assert.equal(c.progress.invalidDateKeys, 1);
});

test('any adoption sentinel including null or unknown is a hard no-go', async () => {
  for (const value of [null, 'shared-date-v1', canary]) {
    await adminDb.collection('users').insertOne({ __v: 0, subProfiles: [{ collectibleWriterVersion: value }] });
  }
  const report = await assess();
  assert.equal(report.disposition, 'HARD_NO_GO'); assert.equal(report.counts.profiles.writerSentinelPresent, 3);
  assert.equal(JSON.stringify(report).includes(canary), false);
  await adminDb.collection('users').insertOne({ __v: 0, subProfiles: { collectibleWriterVersion: null } });
  const malformed = await assess();
  assert.equal(malformed.counts.users.nonArrayWriterSentinelPresent, 1);
  assert.equal(malformed.disposition, 'HARD_NO_GO');
});

test('catalog raw types, unsafe keys, legacy rows and cast collisions yield only aggregate counts', async () => {
  await adminDb.collection('rewarditems').insertMany([
    { id: 42 }, { id: '42' }, {}, { id: null }, { id: { private: canary } },
    { id: 'a.b' }, { id: '$bad' }, { id: '__proto__' }, { id: 'legacy' },
  ]);
  const { counts: c } = await assess();
  assert.equal(c.catalog.total, 9); assert.equal(c.catalog.numericIds, 1); assert.equal(c.catalog.missingIds, 1);
  assert.equal(c.catalog.nullIds, 1); assert.equal(c.catalog.otherIdTypes, 1); assert.equal(c.catalog.unsafeStringIds, 3);
  assert.equal(c.catalog.legacyDisplayVariants, 9); assert.equal(c.catalogDuplicates.duplicateGroups, 1);
  assert.equal(c.catalogDuplicates.extraRows, 1);
});

test('empty existing collections remain count-only owner review, never a production compatibility PASS', async () => {
  const report = await assess();
  assert.equal(report.counts.users.total, 0); assert.equal(report.counts.catalog.total, 0);
  assert.equal(report.disposition, 'OWNER_REVIEW_REQUIRED');
});

test('shared-writer state is checked only in the exact reviewed collection inventory', async () => {
  const name = SHARED_COLLECTIONS[0];
  await adminDb.createCollection(name);
  const approved = { ...scope, collectionNames: [...scope.collectionNames, name] };
  try {
    await assert.rejects(assess(), { message: 'AUDIT_SCOPE_REFUSED' });
    let report = await assess(approved); assert.equal(report.counts.sharedWriter.collectionsPresent, 1);
    assert.equal(report.counts.sharedWriter.documents, 0);
    await adminDb.collection(name).insertOne({ private: canary });
    report = await assess(approved); assert.equal(report.disposition, 'HARD_NO_GO');
    assert.equal(report.counts.sharedWriter.documents, 1); assert.equal(JSON.stringify(report).includes(canary), false);
  } finally { await adminDb.collection(name).drop(); }
});

test('write-capable authenticated principal and wrong database scope are refused before data aggregation', async () => {
  await assert.rejects(assessSchema(writer.db(databaseName), scope), { message: 'AUDIT_READ_ONLY_PRIVILEGES_REQUIRED' });
  await assert.rejects(assess({ ...scope, databaseName: 'unexpected' }), { message: 'AUDIT_SCOPE_REFUSED' });
  await assert.rejects(assess({ ...scope, dedicatedDatabaseConfirmed: false }), { message: 'AUDIT_SCOPE_REFUSED' });
  await assert.rejects(assess({ ...scope, collectionNames: ['users'] }), { message: 'AUDIT_SCOPE_REFUSED' });
});

test('views and unexpected namespaces fail closed without returning collection names', async () => {
  await adminDb.createCollection('unexpected_private_namespace');
  try { await assert.rejects(assess(), { message: 'AUDIT_SCOPE_REFUSED' }); }
  finally { await adminDb.collection('unexpected_private_namespace').drop(); }
  await adminDb.collection('rewarditems').drop();
  try {
    await adminDb.createCollection('rewarditems', { viewOn: 'mazes', pipeline: [] });
    await assert.rejects(assess(), { message: 'AUDIT_SCOPE_REFUSED' });
  } finally { await adminDb.collection('rewarditems').drop(); await adminDb.createCollection('rewarditems'); }
});

function fakeDb(change = () => {}) {
  const calls = [];
  return { databaseName, client: { options: timeouts }, calls,
    async command(body, options) {
      calls.push({ body, options });
      let response;
      if (body.connectionStatus) response = { authInfo: { authenticatedUsers: [{}], authenticatedUserPrivileges: [
        { resource: { db: databaseName, collection: '' }, actions: ['find', 'listCollections'] },
      ] } };
      else if (body.listCollections) response = { cursor: { id: 0, firstBatch: scope.collectionNames.map(name => ({ name, type: 'collection', options: {} })) } };
      else if (body.hello) response = { isWritablePrimary: true, setName: canary };
      else if (body.buildInfo) response = { version: '8.0.16', host: canary };
      else response = { cursor: { id: 0, firstBatch: [] } };
      return change(body, response) ?? response;
    },
  };
}

test('every metadata and data command is bounded, reads primary, and aggregates cannot spill or export rows', async () => {
  const mocked = fakeDb(); await assessSchema(mocked, scope);
  for (const { body, options } of mocked.calls) {
    assert.equal(body.maxTimeMS, MAX_TIME_MS); assert.equal(options.readPreference, 'primary');
    if (body.aggregate) {
      assert.deepEqual(body.readConcern, { level: 'majority' }); assert.equal(body.allowDiskUse, false);
      assert.deepEqual(body.cursor, { batchSize: 2 });
    }
  }
  const operators = new Set();
  function visit(value) { if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) { if (key.startsWith('$')) operators.add(key); visit(nested); } }
  assessmentPlans().forEach(plan => visit(plan.pipeline));
  for (const forbidden of ['$out', '$merge', '$function', '$accumulator', '$where', '$lookup']) assert.equal(operators.has(forbidden), false);
});

test('timeouts, auth failures, unsafe privileges, unsupported topology and private errors never return partial reports', async () => {
  for (const mutate of [
    (body) => { if (body.aggregate) throw Error(`private timeout ${canary}`); },
    (body) => { if (body.connectionStatus) throw Error(`private auth ${canary}`); },
    (body, r) => { if (body.connectionStatus) r.authInfo.authenticatedUsers = []; },
    (body, r) => { if (body.connectionStatus) r.authInfo.authenticatedUserPrivileges = []; },
    (body, r) => { if (body.connectionStatus) r.authInfo.authenticatedUserPrivileges[0].resource.db = ''; },
    (body, r) => { if (body.connectionStatus) r.authInfo.authenticatedUserPrivileges[0].actions.push('insert'); },
    (body, r) => { if (body.hello) r.msg = 'isdbgrid'; },
    (body, r) => { if (body.buildInfo) r.version = '9.0.0'; },
    (body, r) => { if (body.aggregate) r.cursor.id = 42; },
    (body, r) => { if (body.aggregate) r.cursor.firstBatch = [{ private: canary }]; },
    (body, r) => { if (body.listCollections) r.cursor.id = 42; },
    (body, r) => { if (body.connectionStatus) r.authInfo.authenticatedUserPrivileges[0].resource.collection = canary; },
    (body, r) => { if (body.connectionStatus) r.authInfo.authenticatedUserPrivileges[0].resource = { anyResource: true }; },
  ]) {
    const mocked = fakeDb(mutate);
    await assert.rejects(assessSchema(mocked, scope), error => /^AUDIT_[A-Z_]+$/.test(error.message)
      && !error.message.includes(canary) && error.cause === undefined);
  }
  const mocked = fakeDb(); mocked.client.options = { ...timeouts, socketTimeoutMS: 0 };
  await assert.rejects(assessSchema(mocked, scope), { message: 'AUDIT_TIMEOUT_CONFIGURATION_REQUIRED' });
  assert.equal(mocked.calls.length, 0);
});

test('scope and privilege drift at the end of the scan discard all accumulated counts', async () => {
  for (const kind of ['scope', 'privileges']) {
    let collections = 0, privileges = 0;
    const mocked = fakeDb((body, response) => {
      if (body.listCollections && ++collections === 2 && kind === 'scope') response.cursor.firstBatch.push({ name: canary, type: 'collection' });
      if (body.connectionStatus && ++privileges === 2 && kind === 'privileges') response.authInfo.authenticatedUserPrivileges[0].actions.push('update');
    });
    await assert.rejects(assessSchema(mocked, scope), { message: kind === 'scope' ? 'AUDIT_SCOPE_REFUSED' : 'AUDIT_READ_ONLY_PRIVILEGES_REQUIRED' });
  }
});

test('standalone metadata is sanitized and unsupported/missing introspection remains incomplete', async () => {
  const standalone = fakeDb((body, response) => { if (body.hello) delete response.setName; });
  const report = await assessSchema(standalone, scope);
  assert.equal(report.metadata.topology, 'standalone');
  for (const mutate of [
    body => { if (body.hello) throw null; },
    (body, response) => { if (body.connectionStatus) delete response.authInfo.authenticatedUserPrivileges; },
    (body, response) => { if (body.aggregate) response.cursor.firstBatch = [{ total: canary }]; },
  ]) {
    await assert.rejects(assessSchema(fakeDb(mutate), scope), error => /^AUDIT_[A-Z_]+$/.test(error.message));
  }
});
