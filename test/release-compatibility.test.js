import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { replicaSet } from '../tools/transaction-feasibility/replica-set.mjs';
import { freshFixture } from '../tools/test-support/fresh-fixtures.mjs';
import { validateFreshRelease } from '../services/publication/fresh-release.js';
import { approvedFixture } from '../tools/test-support/release-fixtures.mjs';
import { readIndexReadiness } from '../services/publication/readiness.js';
import { validateCatalog, catalogProblem, catalogFresh } from '../tools/test-support/archive-client/catalog.js';
import { publicationDocument } from '../services/publication/policy.js';
import { generateDaily, hash } from '../lib/maze/engine.js';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const grid = [['S', ' ', 'E']], date = '2025-05-26';
let rs, children = [], roots = [];

async function snapshot(manifest, legacy) {
  const root = await mkdtemp(join(tmpdir(), 'fc-release-app-')); roots.push(root);
  for (const file of ['app.js', 'index.js', 'package.json', 'models', 'routes', 'services', 'lib', 'middleware', 'config']) {
    await cp(join(sourceRoot, file), join(root, file), { recursive: true });
  }
  await symlink(join(sourceRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
  if (manifest === null) await rm(join(root, 'config/fresh-release.json'));
  else if (manifest !== undefined) await writeFile(join(root, 'config/fresh-release.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  if (legacy) await writeFile(join(root, 'config/legacy-publications.json'), JSON.stringify(legacy));
  return root;
}
async function launch(root, at = '2026-06-01T13:00:00.000Z') {
  const child = fork(new URL('../tools/test-support/release-app.mjs', import.meta.url), [],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH, TZ: 'UTC' } });
  children.push(child);
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('RELEASE_FIXTURE_TIMEOUT')), 12000);
    child.on('message', message => { if (message.port || message.failure) { clearTimeout(timer); resolve(message); } });
    child.on('error', reject); child.on('exit', code => { if (code) { clearTimeout(timer); reject(Error('RELEASE_FIXTURE_EXIT')); } });
  });
  child.send({ root, uri: rs.uri, at });
  const result = await ready;
  return { child, ...result, base: result.port ? `http://127.0.0.1:${result.port}` : null };
}
async function provision() {
  await rs.db.dropDatabase();
  await rs.db.createCollection('mazes'); await rs.db.createCollection('users'); await rs.db.createCollection('rewarditems');
  await rs.db.collection('mazes').createIndex({ date: 1 }, { unique: true });
  await rs.db.collection('mazes').createIndex({ publicationEra: 1, date: 1, publishedAt: 1 });
  await rs.db.collection('users').createIndex({ email: 1 }, { unique: true });
  await rs.db.collection('rewarditems').createIndex({ id: 1 }, { unique: true });
}
const request = async (app, path, { token, body } = {}) => {
  const response = await fetch(app.base + path, { method: body ? 'POST' : 'GET', headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
};

before(async () => { rs = await replicaSet(); }, { timeout: 40000 });
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve)); child.disconnect(); await exited;
  }
  children = [];
  for (const root of roots) await rm(root, { recursive: true, force: true }); roots = [];
});
after(async () => { await rs?.close(); });

test('accepted client catalog contract rejects old-server HTML 404 without fabricating availability', async () => {
  const old = express().listen(0, '127.0.0.1'); await new Promise(resolve => old.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${old.address().port}/api/maze/archive`);
    assert.equal(response.status, 404);
    assert.throws(() => validateCatalog('old server HTML'), /INVALID_CATALOG/);
    const problem = catalogProblem({ response: { status: response.status } });
    assert.equal(problem.kind, 'unavailable'); assert.match(problem.message, /retry/i);
    assert.equal(catalogFresh({ status: 'error' }), false);
  } finally { old.closeAllConnections(); await new Promise(resolve => old.close(resolve)); }
});

test('client validation fixtures retain the accepted logic and pinned source blobs', async () => {
  const blobHash = bytes => createHash('sha1').update(`blob ${Buffer.byteLength(bytes)}\0`).update(bytes).digest('hex');
  const catalog = (await readFile(new URL('../tools/test-support/archive-client/catalog.js', import.meta.url), 'utf8')).replace("from './dates.js'", "from './dates'");
  const dates = await readFile(new URL('../tools/test-support/archive-client/dates.js', import.meta.url), 'utf8');
  assert.equal(blobHash(catalog), '7d64cd1f48ad582ed9d880896ffbbd0daf68d575');
  assert.equal(blobHash(dates), '91ab7ee2285f683d400d2b87e0aad9b8843c224d');
});

const freshDate = '2026-06-01';
function modern(target = freshDate, at = '2026-06-01T12:00:00.000Z', release = freshFixture()) {
  const document = publicationDocument(generateDaily({ date: target }), new Date(at));
  Object.assign(document.provenance, { releaseId: release.releaseId, releaseDecisionHash: release.approval.decisionHash });
  return document;
}
const stats = app => new Promise(resolve => { app.child.once('message', resolve); app.child.send({ op: 'stats' }); });
const clock = (app, at) => new Promise(resolve => { app.child.once('message', resolve); app.child.send({ op: 'clock', at }); });
async function account(app) {
  const email = 'fresh-fixture@example.invalid', password = 'synthetic-password';
  assert.equal((await request(app, '/api/users/register', { body: { email, password } })).status, 201);
  const token = (await request(app, '/api/users/login', { body: { email, password } })).data.token;
  const profiles = await request(app, '/api/users/subprofile', { token, body: { name: 'Synthetic fresh player' } });
  return { email, token, subProfileId: profiles.data[0]._id };
}

test('actual entrypoint refuses pending/missing/malformed/forged/conflicting approvals before connect/listen', async () => {
  const invalids = [null, '{broken', { ...freshFixture(), scope: 'include-legacy' }];
  for (const mutate of [m => { m.approval.decisionHash = '0'.repeat(64); },
    m => { m.startDate = '2025-05-26'; }, m => { m.approval.approvedAt = '9999-01-01T00:00:00.000Z'; },
    m => { m.approval.decisionRef = ''; }, m => { m.status = 'approved'; }, m => { m.releaseId = '*'; }]) {
    const m = freshFixture(); mutate(m); invalids.push(m);
  }
  for (const manifest of [undefined, ...invalids]) {
    const app = await launch(await snapshot(manifest));
    assert.equal(app.failure, manifest === undefined ? 'FRESH_RELEASE_APPROVAL_REQUIRED' : 'FRESH_RELEASE_INVALID');
    assert.equal(app.connectCalls, 0); assert.deepEqual(app.ddl, []); assert.deepEqual(app.writes, []);
  }
  const conflict = await launch(await snapshot(freshFixture(), approvedFixture()));
  assert.equal(conflict.failure, 'FRESH_RELEASE_INVALID'); assert.equal(conflict.connectCalls, 0);
  const futureApproval = await launch(await snapshot(freshFixture()), '2026-05-30T00:00:00.000Z');
  assert.equal(futureApproval.failure, 'FRESH_RELEASE_INVALID'); assert.equal(futureApproval.connectCalls, 0);
});

test('approved fresh startup still requires all indexes, without automatic DDL or writes', async () => {
  await provision();
  await rs.db.collection('mazes').dropIndex('publicationEra_1_date_1_publishedAt_1');
  const app = await launch(await snapshot(freshFixture()));
  assert.equal(app.failure, 'SERVER_RELEASE_NOT_READY'); assert.equal(app.connectCalls, 1);
  assert.deepEqual(app.ddl, []); assert.deepEqual(app.writes, []);
  assert.equal((await readIndexReadiness(rs.db)).ready, false);
});

test('real default app launches empty, denies every 2025 summer day, excludes old modern rows and keeps stored receipts', async () => {
  await provision();
  const oldModern = modern('2026-05-31', '2026-06-01T12:00:00.000Z');
  const prototype = modern('2026-06-02', '2026-06-02T12:00:00.000Z'); delete prototype.provenance.releaseId;
  await rs.db.collection('mazes').insertMany([{ date, seed: 'original-test-grid', grid, width: 3, height: 1 }, oldModern, prototype]);
  const original = await rs.db.collection('mazes').find({}).sort({ date: 1 }).toArray();
  const root = await snapshot(freshFixture()), app = await launch(root);
  assert.ok(app.port); assert.equal(app.connectCalls, 1); assert.deepEqual(app.ddl, []); assert.deepEqual(app.writes, []);
  for (const month of ['2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2026-05', '2026-06']) {
    const catalog = await request(app, '/api/maze/archive?month=' + month);
    validateCatalog(catalog.data, month); assert.deepEqual(catalog.data.items, []);
    assert.equal(catalog.data.firstPublishedDate, null); assert.equal(catalog.data.lastPublishedDate, null);
    assert.deepEqual(catalog.data.todayMaze, { date: freshDate, available: false });
  }
  assert.deepEqual((await stats(app)).writes, []);
  const owner = await account(app);
  const before = await rs.db.collection('users').findOne({ email: owner.email });
  // Old deployed client clamps every choice to May 26–September 1, inclusive: 99 days.
  for (let t = Date.parse(date + 'T00:00:00Z'), n = 0; n < 99; n++, t += 86400000) {
    const target = new Date(t).toISOString().slice(0, 10);
    assert.equal((await request(app, '/api/maze/start', { token: owner.token, body: { subProfileId: owner.subProfileId, date: target } })).data.code, 'MAZE_NOT_PUBLISHED');
    assert.equal((await request(app, '/api/leaderboard/daily?date=' + target)).data.code, 'MAZE_NOT_PUBLISHED');
  }
  for (const target of [oldModern.date, prototype.date, freshDate]) {
    assert.equal((await request(app, '/api/maze/start', { token: owner.token, body: { subProfileId: owner.subProfileId, date: target } })).data.code, 'MAZE_NOT_PUBLISHED');
  }
  assert.deepEqual(await rs.db.collection('users').findOne({ email: owner.email }), before);
  const attemptId = '12345678-1234-1234-1234-123456789abc';
  const receipt = { message: 'Maze complete', time: '10.000', reward: null, today: date, attemptId };
  await rs.db.collection('users').updateOne({ email: owner.email }, { $set: {
    [`subProfiles.0.attempts.${date}`]: [{ attemptId, completed: true, started: new Date('2025-05-26T00:00:00Z'), result: receipt }],
    [`subProfiles.0.progress.${date}`]: { completed: true, time: '10.000' }, 'subProfiles.0.rewards': { synthetic: 1 },
  } });
  const saved = await rs.db.collection('users').findOne({ email: owner.email }), commands = await stats(app);
  for (let i = 0; i < 3; i++) assert.deepEqual((await request(app, '/api/maze/complete', { token: owner.token,
    body: { subProfileId: owner.subProfileId, date, attemptId } })).data, receipt);
  assert.deepEqual((await stats(app)).writes, commands.writes);
  assert.deepEqual(await rs.db.collection('users').findOne({ email: owner.email }), saved);
  assert.deepEqual(await rs.db.collection('mazes').find({}).sort({ date: 1 }).toArray(), original);
  // File changes do not hot-unlock the running process; pending rollback requires restart.
  await writeFile(join(root, 'config/fresh-release.json'), await readFile(join(sourceRoot, 'config/fresh-release.json')));
  assert.equal((await request(app, '/api/maze/archive')).status, 200);
  const restarted = await launch(root); assert.equal(restarted.failure, 'FRESH_RELEASE_APPROVAL_REQUIRED'); assert.equal(restarted.connectCalls, 0);
});

test('first positively bound stored grid enables default start/daily/owner progress; midnight and late publishing preserve holes', async () => {
  await provision(); const app = await launch(await snapshot(freshFixture()), '2026-06-01T11:59:59.999Z'); assert.ok(app.port);
  const candidate = modern();
  await rs.db.collection('mazes').insertOne(candidate); // synthetic publisher output only
  assert.equal((await request(app, '/api/maze/archive')).data.todayMaze.available, false);
  await clock(app, '2026-06-01T12:00:00.000Z');
  let catalog = (await request(app, '/api/maze/archive')).data;
  validateCatalog(catalog, '2026-06'); assert.equal(catalog.todayMaze.available, true);
  assert.equal(catalog.firstPublishedDate, freshDate); assert.equal(catalog.lastPublishedDate, freshDate);
  const owner = await account(app);
  await rs.db.collection('rewarditems').insertOne({ id: 'fixture', name: 'Fixture', image: 'x', description: 'Fixture', category: 'artifact', rarity: 'common' });
  const payload = { subProfileId: owner.subProfileId, date: freshDate };
  const started = await request(app, '/api/maze/start', { token: owner.token, body: payload }); assert.equal(started.status, 200);
  assert.deepEqual(started.data.maze.grid, candidate.grid);
  assert.deepEqual(Object.keys(started.data).sort(), ['attemptId', 'attemptIndex', 'maze', 'seed', 'today']);
  await clock(app, '2026-06-01T12:00:10.000Z');
  payload.attemptId = started.data.attemptId;
  const completion = await request(app, '/api/maze/complete', { token: owner.token, body: payload }); assert.equal(completion.status, 200);
  for (let i = 0; i < 3; i++) assert.deepEqual((await request(app, '/api/maze/complete', { token: owner.token, body: payload })).data, completion.data);
  const scores = await request(app, '/api/leaderboard/daily?date=' + freshDate); assert.equal(scores.data.length, 1);
  const own = await request(app, '/api/maze/archive?month=2026-06&subProfileId=' + owner.subProfileId, { token: owner.token });
  assert.deepEqual(own.data.items[0].progress, { completed: true }); assert.equal(own.data.todayMaze.progress.completed, true);
  assert.equal((await request(app, '/api/maze/archive?month=2026-06&subProfileId=' + owner.subProfileId)).status, 401);
  const foreign = jwt.sign({ id: new mongoose.Types.ObjectId().toString() }, 'synthetic-release-test-key');
  assert.equal((await request(app, '/api/maze/archive?month=2026-06&subProfileId=' + owner.subProfileId, { token: foreign })).status, 404);
  await clock(app, '2026-06-01T23:59:59.999Z'); assert.equal((await request(app, '/api/maze/archive')).data.todayMaze.available, true);
  await clock(app, '2026-06-02T00:00:00.000Z');
  catalog = (await request(app, '/api/maze/archive')).data; assert.equal(catalog.today, '2026-06-02');
  assert.equal(catalog.todayMaze.available, false); assert.equal(catalog.lastPublishedDate, freshDate);
  await clock(app, '2026-06-03T12:00:00.000Z');
  await rs.db.collection('mazes').insertOne(modern('2026-06-03', '2026-06-03T12:00:00.000Z'));
  catalog = (await request(app, '/api/maze/archive')).data;
  assert.deepEqual(catalog.items.map(x => x.date), [freshDate, '2026-06-03']); assert.equal(catalog.todayMaze.available, true);
  assert.equal(await rs.db.collection('mazes').countDocuments({ date: '2026-06-02' }), 0);
  const original = await rs.db.collection('mazes').findOne({ date: freshDate });
  assert.deepEqual(original.grid, candidate.grid); assert.equal(original.provenance.gridHash, hash(candidate.grid));
  assert.deepEqual((await stats(app)).ddl, []);
});

test('exact admission rejects preapproval/time/date/release/hash prototypes and bounded edges ignore over 32 pre-cutover rows', async () => {
  await provision();
  const release = freshFixture(), policy = validateFreshRelease(release, new Date('2026-06-01T13:00:00Z')).policy;
  const { isPublished } = await import('../services/publication/policy.js');
  const bad = [];
  for (const mutate of [m => { m.publishedAt = new Date('2026-05-31T11:59:59.999Z'); },
    m => { m.publishedAt = new Date('2026-06-01T11:59:59.999Z'); },
    m => { m.provenance.releaseId = 'other-release'; }, m => { delete m.provenance.releaseDecisionHash; },
    m => { m.provenance.releaseDecisionHash = '0'.repeat(64); }, m => { m.provenance.gridHash = '0'.repeat(64); }]) {
    const m = modern(); mutate(m); bad.push(m);
    assert.equal(isPublished(m, new Date('2026-06-01T13:00:00Z'), policy), false);
  }
  for (let n = 1; n <= 40; n++) {
    const target = new Date(Date.parse('2026-06-01T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
    await rs.db.collection('mazes').insertOne(modern(target));
  }
  const app = await launch(await snapshot(release));
  for (const m of bad) {
    await rs.db.collection('mazes').deleteOne({ date: freshDate }); await rs.db.collection('mazes').insertOne(m);
    const catalog = await request(app, '/api/maze/archive'); assert.equal(catalog.status, 200);
    assert.deepEqual(catalog.data.items, []); assert.equal(catalog.data.firstPublishedDate, null); assert.equal(catalog.data.lastPublishedDate, null);
    assert.equal(catalog.data.todayMaze.available, false);
    assert.equal((await request(app, '/api/leaderboard/daily?date=' + freshDate)).data.code, 'MAZE_NOT_PUBLISHED');
  }
  assert.deepEqual((await stats(app)).writes, []); assert.deepEqual((await stats(app)).ddl, []);
});
