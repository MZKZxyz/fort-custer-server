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

test('QA P2: old-only progress is absent from every public board and original UUID recovery is read-only', async () => {
  await provision(); const app = await launch(await snapshot(freshFixture())); assert.ok(app.port);
  await rs.db.collection('mazes').insertOne({ date, seed: 'original', grid, width: 3, height: 1 });
  const owner = await account(app), attemptId = '12345678-1234-1234-1234-123456789abc';
  const receipt = { message: 'Maze complete', time: '12.345', reward: null, today: date, attemptId };
  await rs.db.collection('users').updateOne({ email: owner.email }, { $set: {
    [`subProfiles.0.progress.${date}`]: { completed: true, time: '12.345' },
    [`subProfiles.0.attempts.${date}`]: [{ attemptId, completed: true, started: new Date('2025-05-26T00:00:00Z'), result: receipt }],
    'subProfiles.0.rewards': { synthetic: 3 },
  } });
  const user = await rs.db.collection('users').findOne({ email: owner.email });
  const mazes = await rs.db.collection('mazes').find({}).toArray(), before = await stats(app);
  for (const path of ['weekly?start=2025-05-26', 'weekly?start=2026-06-01', 'weekly', 'alltime']) {
    const board = await request(app, '/api/leaderboard/' + path); assert.equal(board.status, 200); assert.deepEqual(board.data, []);
  }
  assert.equal((await request(app, '/api/leaderboard/daily?date=' + date)).data.code, 'MAZE_NOT_PUBLISHED');
  assert.equal((await request(app, '/api/maze/start', { token: owner.token, body: { date, subProfileId: owner.subProfileId } })).data.code, 'MAZE_NOT_PUBLISHED');
  assert.deepEqual((await request(app, '/api/maze/archive?month=2025-05')).data.items, []);
  for (let n = 0; n < 3; n++) assert.deepEqual((await request(app, '/api/maze/complete', { token: owner.token,
    body: { date, subProfileId: owner.subProfileId, attemptId } })).data, receipt);
  assert.deepEqual(await rs.db.collection('users').findOne({ email: owner.email }), user);
  assert.deepEqual(await rs.db.collection('mazes').find({}).toArray(), mazes);
  assert.deepEqual((await stats(app)).writes, before.writes); assert.deepEqual((await stats(app)).ddl, []);
});

test('all public rankings verify mixed fresh/historical/missing/corrupt/release-bound dates without leaking profile data', async () => {
  await provision(); const app = await launch(await snapshot(freshFixture()), '2026-06-13T23:59:59.999Z');
  const owner = await account(app);
  const documents = [modern(), modern('2026-06-06', '2026-06-06T12:00:00.000Z'), modern('2026-06-07', '2026-06-07T12:00:00.000Z')];
  for (const [target, mutate] of [
    ['2026-06-03', m => { m.provenance.releaseId = 'wrong-release'; }],
    ['2026-06-04', m => { m.provenance.releaseDecisionHash = '0'.repeat(64); }],
    ['2026-06-05', m => { m.provenance.gridHash = '0'.repeat(64); }],
    ['2026-06-08', m => { delete m.provenance.releaseId; }],
    ['2026-06-09', m => { m.publishedAt = new Date('2026-05-31T00:00:00.000Z'); }],
    ['2026-06-10', m => { m.publishedAt = new Date('2026-06-14T00:00:00.000Z'); }],
  ]) { const m = modern(target, '2026-06-13T12:00:00.000Z'); mutate(m); documents.push(m); }
  documents.push({ date, seed: 'old', grid, width: 3, height: 1 });
  await rs.db.collection('mazes').insertMany(documents);
  const progress = Object.fromEntries([date, ...Array.from({ length: 14 }, (_, i) => `2026-06-${String(i + 1).padStart(2, '0')}`)]
    .map(target => [target, { completed: true, time: '100.000' }]));
  Object.assign(progress, { '2026-06-01': { completed: true, time: '1.111' },
    '2026-06-06': { completed: true, time: 2.222 }, '2026-06-07': { completed: true, time: '3.333' },
    malformed: { completed: true, time: '1.000' }, '2026-02-30': { completed: true, time: '1.000' } });
  await rs.db.collection('users').updateOne({ email: owner.email }, { $set: { 'subProfiles.0.progress': progress } });
  const saved = await rs.db.collection('users').find({}).toArray(), mazeSnapshot = await rs.db.collection('mazes').find({}).toArray(), before = await stats(app);
  const expected = (time, count) => [{ name: 'Synthetic fresh player', subProfileId: owner.subProfileId, time, completedMazes: count }];
  for (const [path, value] of [['daily?date=2026-06-01', expected('1.111', 1)],
    ['weekly?start=2026-06-03', expected('3.333', 2)], ['weekly?start=2026-06-13', expected('3.333', 1)],
    ['weekly?start=2025-05-26', []], ['weekly?start=2026-06-21', []], ['alltime', expected('6.666', 3)]]) {
    const board = await request(app, '/api/leaderboard/' + path); assert.equal(board.status, 200); assert.deepEqual(board.data, value);
  }
  const own = await request(app, '/api/maze/archive?month=2026-06&subProfileId=' + owner.subProfileId, { token: owner.token });
  assert.deepEqual(own.data.items.map(m => m.date), ['2026-06-01', '2026-06-06', '2026-06-07']);
  assert.ok(own.data.items.every(m => m.progress.completed));
  assert.deepEqual(await rs.db.collection('users').find({}).toArray(), saved);
  assert.deepEqual(await rs.db.collection('mazes').find({}).toArray(), mazeSnapshot);
  assert.deepEqual((await stats(app)).writes, before.writes); assert.deepEqual((await stats(app)).ddl, []);
});

test('UTC Sunday week rollover and delayed publication never clamp to summer or count unpublished progress', async () => {
  await provision(); const app = await launch(await snapshot(freshFixture()), '2026-06-06T23:59:59.999Z');
  const owner = await account(app);
  await rs.db.collection('mazes').insertMany([modern(), modern('2026-06-06', '2026-06-06T12:00:00.000Z'),
    modern('2026-06-07', '2026-06-07T00:00:00.000Z')]);
  await rs.db.collection('users').updateOne({ email: owner.email }, { $set: { 'subProfiles.0.progress': {
    '2026-06-01': { completed: true, time: '1.000' }, '2026-06-06': { completed: true, time: '2.000' },
    '2026-06-07': { completed: true, time: '4.000' }, '2026-06-08': { completed: true, time: '8.000' },
  } } });
  let board = await request(app, '/api/leaderboard/weekly'); assert.equal(board.data[0].time, '3.000');
  assert.deepEqual((await request(app, '/api/leaderboard/weekly?start=2026-06-07')).data, []);
  await clock(app, '2026-06-07T00:00:00.000Z');
  board = await request(app, '/api/leaderboard/weekly'); assert.equal(board.data[0].time, '4.000'); assert.equal(board.data[0].completedMazes, 1);
  assert.equal((await request(app, '/api/leaderboard/weekly?start=2026-06-06')).data[0].time, '3.000');
  await clock(app, '2026-06-08T00:00:00.000Z'); assert.equal((await request(app, '/api/leaderboard/weekly')).data[0].time, '4.000');
  await rs.db.collection('mazes').insertOne(modern('2026-06-08', '2026-06-08T00:00:00.000Z'));
  assert.equal((await request(app, '/api/leaderboard/weekly')).data[0].time, '12.000');
  assert.equal((await request(app, '/api/leaderboard/alltime')).data[0].completedMazes, 4);
  for (const query of ['start=2026-02-30', 'start=', 'start=2026-06-07T00%3A00%3A00Z']) {
    const response = await request(app, '/api/leaderboard/weekly?' + query); assert.equal(response.status, 400); assert.equal(response.data.code, 'INVALID_DATE');
  }
  for (const path of ['weekly?start=2026-06-01&start=2026-06-02', 'weekly?start[]=2026-06-01', 'alltime?start=2025-05-26']) {
    const response = await request(app, '/api/leaderboard/' + path); assert.equal(response.status, 400); assert.equal(response.data.code, 'INVALID_QUERY');
  }
});

test('ranking verification failures return retryable 503 rather than partial/empty scores; reads never mutate records', async () => {
  await provision(); const app = await launch(await snapshot(freshFixture())); const owner = await account(app);
  await rs.db.collection('mazes').insertOne(modern());
  await rs.db.collection('users').updateOne({ email: owner.email }, { $set: { 'subProfiles.0.progress': { [freshDate]: { completed: true, time: '5.000' } } } });
  const original = await rs.db.collection('users').findOne({ email: owner.email }), before = await stats(app);
  for (const command of ['aggregate', 'find']) {
    for (const path of ['weekly?start=2026-06-01', 'alltime']) {
      await rs.client.db('admin').command({ configureFailPoint: 'failCommand', mode: { times: 2 }, data: { failCommands: [command], errorCode: 2 } });
      try {
        const response = await request(app, '/api/leaderboard/' + path);
        assert.equal(response.status, 503); assert.deepEqual(response.data, { error: 'Published rankings could not be verified. Retry shortly.', code: 'LEADERBOARD_UNAVAILABLE' });
      } finally { await rs.failOff(); }
      assert.equal((await request(app, '/api/leaderboard/' + path)).data[0].time, '5.000');
    }
  }
  assert.deepEqual(await rs.db.collection('users').findOne({ email: owner.email }), original);
  assert.deepEqual((await stats(app)).writes, before.writes); assert.deepEqual((await stats(app)).ddl, []);
});

test('alltime deduplicates shared progress dates into bounded indexed batches and never scans the maze collection', async () => {
  await provision(); const app = await launch(await snapshot(freshFixture()), '2026-07-15T12:00:00.000Z');
  const owner = await account(app);
  const dates = Array.from({ length: 40 }, (_, i) => new Date(Date.parse('2026-06-01T00:00:00Z') + i * 86400000).toISOString().slice(0, 10));
  await rs.db.collection('mazes').insertMany(dates.map(target => modern(target, '2026-07-15T12:00:00.000Z')));
  const progress = Object.fromEntries(dates.map(target => [target, { completed: true, time: '1.000' }]));
  await rs.db.collection('users').updateOne({ email: owner.email }, { $set: { 'subProfiles.0.progress': progress } });
  await rs.db.collection('users').insertOne({ email: 'synthetic-second@example.invalid', password: 'unused', __v: 0,
    subProfiles: [{ _id: new mongoose.Types.ObjectId(), name: 'Second synthetic player', progress }] });
  const before = await stats(app), board = await request(app, '/api/leaderboard/alltime');
  assert.equal(board.status, 200); assert.equal(board.data.length, 2);
  assert.ok(board.data.every(row => row.time === '40.000' && row.completedMazes === 40));
  const reads = (await stats(app)).rankingReads.slice(before.rankingReads.length);
  assert.equal(reads.length, 3); assert.deepEqual(reads.map(r => r.kind), ['players', 'mazes', 'mazes']);
  assert.equal(reads[0].limit, 1001); assert.equal(reads[0].profileLimit, 1001);
  assert.deepEqual(reads.slice(1).map(r => r.dateCount), [32, 8]);
  assert.ok(reads.every(r => r.maxTimeMS > 0 && r.maxTimeMS <= 2000));
  assert.ok(reads.slice(1).every(r => r.limit === r.dateCount && r.hint.date === 1));
  // Fail the second distinct maze batch after the first 32 dates verified.
  await rs.client.db('admin').command({ configureFailPoint: 'failCommand', mode: { skip: 1 },
    data: { failCommands: ['find'], errorCode: 2 } });
  try {
    const unavailable = await request(app, '/api/leaderboard/alltime');
    assert.equal(unavailable.status, 503); assert.equal(unavailable.data.code, 'LEADERBOARD_UNAVAILABLE');
  } finally { await rs.failOff(); }
});

test('finite ranking budget refuses oversized player populations rather than publishing a partial top 25', async () => {
  await provision(); const app = await launch(await snapshot(freshFixture()));
  await rs.db.collection('users').insertMany(Array.from({ length: 1001 }, (_, n) => ({
    email: `synthetic-budget-${n}@example.invalid`, password: 'unused', __v: 0, subProfiles: [],
  })));
  const before = await stats(app), response = await request(app, '/api/leaderboard/alltime');
  assert.equal(response.status, 503); assert.equal(response.data.code, 'LEADERBOARD_UNAVAILABLE');
  assert.deepEqual((await stats(app)).writes, before.writes); assert.deepEqual((await stats(app)).ddl, []);
  assert.equal(await rs.db.collection('users').countDocuments({}), 1001);
  const oldWeek = await request(app, '/api/leaderboard/weekly?start=2025-05-26');
  assert.equal(oldWeek.status, 200); assert.deepEqual(oldWeek.data, []);
});

test('malformed or incomplete saved times never become public ranks even on verified fresh dates', async () => {
  await provision(); const app = await launch(await snapshot(freshFixture()), '2026-06-10T12:00:00.000Z'); const owner = await account(app);
  const times = ['1.000', '2garbage', '-1', '0', 'Infinity', { value: 2 }, '1.000' + '0'.repeat(100), '3.000'];
  const dates = times.map((_, i) => `2026-06-${String(i + 1).padStart(2, '0')}`);
  await rs.db.collection('mazes').insertMany(dates.map(target => modern(target, '2026-06-10T12:00:00.000Z')));
  await rs.db.collection('users').updateOne({ email: owner.email }, { $set: { 'subProfiles.0.progress': Object.fromEntries(dates.map((target, i) =>
    [target, { completed: i !== 7, time: times[i] }])) } });
  const before = await rs.db.collection('users').findOne({ email: owner.email });
  const response = await request(app, '/api/leaderboard/alltime'); assert.equal(response.status, 200);
  assert.deepEqual(response.data, [{ name: 'Synthetic fresh player', subProfileId: owner.subProfileId, time: '1.000', completedMazes: 1 }]);
  assert.deepEqual(await rs.db.collection('users').findOne({ email: owner.email }), before);
});
