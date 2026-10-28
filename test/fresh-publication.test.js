import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Maze from '../models/Maze.js';
import { replicaSet } from '../tools/transaction-feasibility/replica-set.mjs';
import { freshFixture } from '../tools/test-support/fresh-fixtures.mjs';
import { canonicalConfig, algorithmVersion, hash, generateDaily } from '../lib/maze/engine.js';
import { previewFreshPublication, publishApprovedDisposable, publicationPlanHash } from '../services/publication/controlled-publication.js';
import { validateFreshRelease } from '../services/publication/fresh-release.js';
import { publicationDocument, isPublished } from '../services/publication/policy.js';

let rs, connection, model, commands;
const now = new Date('2026-06-01T13:00:00.000Z');
const input = () => ({ date: '2026-06-01', version: algorithmVersion, seed: 'fortcuster-2026-06-01', config: { ...canonicalConfig() } });
const preview = () => previewFreshPublication({ release: freshFixture(), input: input(),
  notBefore: '2026-06-01T12:00:00.000Z', expiresAt: '2026-06-02T12:00:00.000Z', now });
function approve(plan) {
  return { schemaVersion: 1, scope: 'one-date-disposable-insert', decisionRef: 'synthetic/one-date-approval',
    approvedAt: '2026-06-01T12:30:00.000Z', planHash: publicationPlanHash(plan) };
}
const apply = (plan, approval = approve(plan), extras = {}) => publishApprovedDisposable({ model, release: freshFixture(), plan, approval, now, ...extras });

before(async () => {
  rs = await replicaSet();
  connection = await mongoose.createConnection(rs.uri.replace('/fc_synthetic?', '/fc_publication_synthetic_fresh?'), {
    autoCreate: false, autoIndex: false, retryWrites: false, retryReads: false, maxPoolSize: 1, waitQueueTimeoutMS: 2000, monitorCommands: true,
    serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000, socketTimeoutMS: 3000,
  }).asPromise();
  model = connection.model('FreshMazeFixture', Maze.schema, 'mazes');
  connection.getClient().on('commandStarted', event => commands.push({ name: event.commandName, command: event.command }));
}, { timeout: 40000 });
beforeEach(async () => {
  commands = [];
  await connection.db.dropDatabase(); await connection.db.createCollection('mazes');
  await connection.db.collection('mazes').createIndex({ date: 1 }, { unique: true });
  await connection.db.collection('mazes').createIndex({ publicationEra: 1, date: 1, publishedAt: 1 });
  commands = [];
});
after(async () => { await connection?.close(); await rs?.close(); });

test('fresh artifact is a strict reviewed decision; pending and malformed sources never grant admission', () => {
  const pending = { schemaVersion: 1, status: 'pending', scope: 'fresh-only-no-legacy', releaseId: null, startDate: null, startsAt: null, approval: null };
  const denied = validateFreshRelease(pending, now); assert.equal(denied.status.approved, false);
  assert.equal(denied.policy.modernMatches(publicationDocument(generateDaily(input()), now)), false);
  for (const mutate of [m => { m.scope = 'legacy'; }, m => { m.status = 'approved'; },
    m => { m.startDate = '2026-02-30'; }, m => { m.startsAt = '2026-06-01T12:00:00+00:00'; },
    m => { m.releaseId = '*'; }, m => { m.approval.approvedAt = '2026-06-02T00:00:00.000Z'; },
    m => { m.approval.decisionHash = '0'.repeat(64); }, m => { m.extra = true; },
    m => { m[Symbol('hidden')] = true; }, m => { Object.defineProperty(m, 'scope', { get() { throw Error('accessor'); } }); },
    m => { Object.setPrototypeOf(m.approval, { forged: true }); }, m => { m.approval.decisionRef = ''; }]) {
    const fixture = freshFixture(); mutate(fixture);
    assert.throws(() => validateFreshRelease(fixture, now), { code: 'FRESH_RELEASE_INVALID' });
  }
  const fixture = freshFixture(), checked = validateFreshRelease(fixture, now), stored = publicationDocument(generateDaily(input()), now);
  Object.assign(stored.provenance, { releaseId: fixture.releaseId, releaseDecisionHash: fixture.approval.decisionHash });
  fixture.releaseId = 'mutated'; assert.equal(checked.policy.modernMatches(stored), true);
  assert.ok(Object.isFrozen(checked.policy)); assert.ok(Object.isFrozen(checked.status));
  assert.equal(checked.policy.matches(stored.date, hash(stored.grid)), false);
});

test('preview is deterministic and explicit, never approval or database access', async () => {
  const a = await preview(), b = await preview();
  assert.deepEqual(a.plan, b.plan); assert.deepEqual(a.grid, b.grid); assert.equal(a.planHash, b.planHash);
  assert.equal(a.plan.gridHash, hash(a.grid)); assert.equal(a.mode, 'disposable-review-required');
  assert.equal(a.analysis.solution.solvable, true); assert.deepEqual(commands, []);
  for (const change of [i => { delete i.seed; }, i => { delete i.version; }, i => { delete i.config.width; },
    i => { i.config.maxStates = Infinity; }, i => { i.date = '9999-12-31'; }, i => { i.seed = 'x'.repeat(257); }]) {
    const value = input(); change(value);
    await assert.rejects(previewFreshPublication({ release: freshFixture(), input: value, now,
      notBefore: a.plan.notBefore, expiresAt: a.plan.expiresAt }));
  }
  assert.deepEqual(commands, []);
});

test('approved one-date insert preserves deterministic provenance, exact idempotency, schema and bounded native commands', async () => {
  const { plan, grid } = await preview(), result = await apply(plan);
  assert.equal(result.created, true); assert.equal(result.reconciled, false); assert.deepEqual(result.maze.grid, grid);
  assert.equal(isPublished(result.maze, now, validateFreshRelease(freshFixture(), now).policy), true);
  await new model(result.maze).validate();
  const original = await model.collection.findOne({ date: plan.input.date }, { maxTimeMS: 2000 });
  const twice = await apply(plan); assert.equal(twice.created, false); assert.deepEqual(twice.maze, original);
  assert.deepEqual(await model.collection.findOne({ date: plan.input.date }, { maxTimeMS: 2000 }), original);
  const writes = commands.filter(c => ['insert', 'update', 'delete', 'findAndModify'].includes(c.name));
  assert.equal(writes.length, 1); assert.equal(writes[0].name, 'insert');
  assert.equal(writes[0].command.documents.length, 1); assert.equal(writes[0].command.writeConcern.w, 'majority');
  assert.ok(!commands.some(c => ['create', 'createIndexes', 'drop', 'collMod'].includes(c.name)));
  for (const c of commands.filter(c => c.name === 'find')) {
    assert.deepEqual(c.command.filter, { date: plan.input.date }); assert.equal(c.command.maxTimeMS, 2000);
    if (c.command.collectionUUID) { assert.equal(c.command.readConcern.level, 'majority'); assert.equal(c.command.collectionUUID.sub_type, 4); }
  }
  assert.equal(commands.filter(c => c.name === 'find' && c.command.collectionUUID).length, 3);
});

test('approval tampering/expiry/unsafe scope stops before any DB command and actual regeneration detects forged grid hash', async () => {
  const { plan } = await preview();
  for (const mutate of [a => { a.planHash = '0'.repeat(64); }, a => { a.scope = 'production'; }, a => { a.decisionRef = ''; },
    a => { a.approvedAt = '2026-06-01T14:00:00.000Z'; }, a => { a.schemaVersion = 2; }]) {
    const approval = approve(plan); mutate(approval); await assert.rejects(apply(plan, approval), { code: 'PUBLICATION_APPROVAL_REQUIRED' });
  }
  for (const change of [p => { p.input.seed = 'changed'; }, p => { p.releaseDecisionHash = '0'.repeat(64); },
    p => { p.notBefore = '2026-06-01T14:00:00.000Z'; }, p => { p.expiresAt = '2026-06-03T12:00:00.000Z'; }]) {
    const changed = structuredClone(plan); change(changed); await assert.rejects(apply(changed), { code: 'PUBLICATION_APPROVAL_REQUIRED' });
  }
  await assert.rejects(apply(plan, approve(plan), { now: new Date(plan.expiresAt) }), { code: 'PUBLICATION_APPROVAL_REQUIRED' });
  assert.deepEqual(commands, []);
  const forged = structuredClone(plan); forged.gridHash = '0'.repeat(64);
  await assert.rejects(apply(forged), { code: 'PUBLICATION_PREVIEW_MISMATCH' });
  assert.equal(await model.countDocuments({}), 0);
});

test('markerless, prototype or different-identity date collision is STOP without deleting/replacing data', async () => {
  const { plan } = await preview();
  for (const candidate of [
    { date: plan.input.date, seed: 'old-test', grid: [['S', 'E']], width: 2, height: 1 },
    publicationDocument(generateDaily(input()), now),
    (() => { const d = publicationDocument(generateDaily({ ...input(), seed: 'other' }), now); Object.assign(d.provenance, {
      releaseId: freshFixture().releaseId, releaseDecisionHash: freshFixture().approval.decisionHash }); return d; })(),
  ]) {
    await model.collection.insertOne(candidate); const original = await model.collection.findOne({ date: plan.input.date }, { maxTimeMS: 2000 }); commands = [];
    await assert.rejects(apply(plan), { code: 'PUBLICATION_DATE_COLLISION' });
    assert.ok(!commands.some(c => ['insert', 'update', 'delete'].includes(c.name)));
    assert.deepEqual(await model.collection.findOne({ date: plan.input.date }, { maxTimeMS: 2000 }), original);
    await model.collection.deleteOne({ date: plan.input.date }); // owned fixture cleanup only
  }
});

test('lost ACK and failed insert reconcile once, with no driver retry or alternate seed', async () => {
  const { plan } = await preview(), command = connection.db.command.bind(connection.db);
  try {
    connection.db.command = async (value, ...args) => {
      if (value.insert) { await command(value, ...args); throw Error('synthetic lost acknowledgement'); }
      return command(value, ...args);
    };
    const reconciled = await apply(plan); assert.equal(reconciled.reconciled, true); assert.equal(reconciled.created, false);
    assert.equal(commands.filter(c => c.name === 'insert').length, 1);
    assert.equal(commands.filter(c => c.name === 'find').length, 2);
    await model.collection.deleteOne({ date: plan.input.date }); commands = [];
    connection.db.command = async (value, ...args) => {
      if (value.insert) throw Error('synthetic failure before insert');
      return command(value, ...args);
    };
    await assert.rejects(apply(plan), { code: 'PUBLICATION_UNCERTAIN' });
    assert.equal(commands.filter(c => c.name === 'find').length, 2);
    assert.equal(await model.countDocuments({}), 0);
  } finally { connection.db.command = command; }
});

test('unique-index readiness, disposable guard and single publication slot fail closed', async () => {
  const { plan } = await preview();
  await assert.rejects(publishApprovedDisposable({ model: {}, release: freshFixture(), plan, approval: approve(plan), now }), { code: 'LIVE_PUBLICATION_NOT_AUTHORIZED' });
  const first = apply(plan); await assert.rejects(apply(plan), { code: 'PUBLICATION_BUSY' }); await first;
  await model.collection.deleteOne({ date: plan.input.date });
  await model.collection.dropIndex('date_1'); commands = [];
  await assert.rejects(apply(plan), { code: 'PUBLICATION_INDEX_REQUIRED' });
  assert.ok(!commands.some(c => c.name === 'insert'));
});

test('duplicate insert race reconciles the exact winner, but a competing test-era grid remains a collision', async () => {
  const { plan } = await preview(), command = connection.db.command.bind(connection.db);
  try {
    connection.db.command = async (value, ...args) => {
      if (value.insert) await command(value, ...args);
      return command(value, ...args);
    };
    const same = await apply(plan); assert.equal(same.reconciled, true); assert.equal(await model.countDocuments({}), 1);
    await model.collection.deleteOne({ date: plan.input.date });
    connection.db.command = async (value, ...args) => {
      if (value.insert) await model.collection.insertOne({ date: plan.input.date, seed: 'synthetic-competing-test', grid: [['S', 'E']], width: 2, height: 1 });
      return command(value, ...args);
    };
    await assert.rejects(apply(plan), { code: 'PUBLICATION_DATE_COLLISION' });
    assert.equal((await model.collection.findOne({ date: plan.input.date })).seed, 'synthetic-competing-test');
    assert.equal(await model.countDocuments({}), 1);
  } finally { connection.db.command = command; }
});

test('approval bindings are captured before awaits; later caller mutation cannot change the reviewed candidate', async () => {
  const { plan } = await preview(), approval = approve(plan);
  const originalCommand = connection.db.command.bind(connection.db);
  connection.db.command = async (...args) => {
    const result = await originalCommand(...args);
    if (args[0].listIndexes) { plan.gridHash = '0'.repeat(64); plan.input.seed = 'mutated-after-approval'; }
    return result;
  };
  try {
    const originalHash = plan.gridHash, result = await apply(plan, approval);
    assert.equal(result.maze.provenance.gridHash, originalHash); assert.equal(result.maze.seed, input().seed);
  } finally { connection.db.command = originalCommand; }
});

test('collection UUID prevents implicit creation and publication into a concurrently replaced namespace', async () => {
  const { plan } = await preview(), command = connection.db.command.bind(connection.db);
  for (const recreate of [false, true]) {
    connection.db.command = async (value, ...args) => {
      if (value.insert) {
        await connection.db.dropCollection('mazes');
        if (recreate) await connection.db.createCollection('mazes');
      }
      return command(value, ...args);
    };
    await assert.rejects(apply(plan), { code: 'PUBLICATION_UNCERTAIN' });
    connection.db.command = command;
    assert.equal((await connection.db.listCollections({ name: 'mazes' }).toArray()).length, recreate ? 1 : 0);
    if (recreate) assert.equal(await model.countDocuments({}), 0);
    else {
      await connection.db.createCollection('mazes');
      await model.collection.createIndex({ date: 1 }, { unique: true });
      await model.collection.createIndex({ publicationEra: 1, date: 1, publishedAt: 1 });
    }
  }
});
