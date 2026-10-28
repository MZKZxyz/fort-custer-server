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
import { approvedFixture } from '../tools/test-support/release-fixtures.mjs';
import { readIndexReadiness } from '../services/publication/readiness.js';
import { validateCatalog, catalogProblem, catalogFresh } from '../tools/test-support/archive-client/catalog.js';
import { publicationDocument } from '../services/publication/policy.js';
import { generateDaily, hash } from '../lib/maze/engine.js';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const grid = [['S', ' ', 'E']], date = '2025-05-26';
let rs, children = [], roots = [];

async function snapshot(manifest) {
  const root = await mkdtemp(join(tmpdir(), 'fc-release-app-')); roots.push(root);
  for (const file of ['app.js', 'index.js', 'package.json', 'models', 'routes', 'services', 'lib', 'middleware', 'config']) {
    await cp(join(sourceRoot, file), join(root, file), { recursive: true });
  }
  await symlink(join(sourceRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
  if (manifest === null) await rm(join(root, 'config/legacy-publications.json'));
  else if (manifest !== undefined) await writeFile(join(root, 'config/legacy-publications.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  return root;
}
async function launch(root) {
  const child = fork(new URL('../tools/test-support/release-app.mjs', import.meta.url), [],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH, TZ: 'UTC' } });
  children.push(child);
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('RELEASE_FIXTURE_TIMEOUT')), 12000);
    child.on('message', message => { if (message.port || message.failure) { clearTimeout(timer); resolve(message); } });
    child.on('error', reject); child.on('exit', code => { if (code) { clearTimeout(timer); reject(Error('RELEASE_FIXTURE_EXIT')); } });
  });
  child.send({ root, uri: rs.uri });
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

test('actual entrypoint refuses empty/missing/malformed/unapproved inventory before MongoDB access', async () => {
  const notYetApproved = approvedFixture(); notYetApproved.approval.approvedAt = new Date(Date.now() + 86400000).toISOString();
  for (const [manifest, failure] of [[undefined, 'LEGACY_RELEASE_APPROVAL_REQUIRED'],
    [null, 'LEGACY_MANIFEST_INVALID'], ['{broken', 'LEGACY_MANIFEST_INVALID'],
    [notYetApproved, 'LEGACY_MANIFEST_INVALID'],
    [{ ...approvedFixture(), status: 'unapproved' }, 'LEGACY_MANIFEST_INVALID']]) {
    const app = await launch(await snapshot(manifest));
    assert.equal(app.failure, failure); assert.equal(app.connectCalls, 0); assert.deepEqual(app.ddl, []);
  }
});

test('readiness and actual startup reject absent archive index without automatic DDL or data mutation', async () => {
  await provision();
  await rs.db.collection('mazes').insertOne({ date, seed: 'original', grid, width: 3, height: 1 });
  await rs.db.collection('mazes').dropIndex('publicationEra_1_date_1_publishedAt_1');
  const before = await rs.db.collection('mazes').findOne({ date });
  const readiness = await readIndexReadiness(rs.db);
  assert.equal(readiness.ready, false); assert.equal(readiness.checks.mazeArchive, false);
  const app = await launch(await snapshot(approvedFixture()));
  assert.equal(app.failure, 'SERVER_RELEASE_NOT_READY'); assert.equal(app.connectCalls, 1); assert.deepEqual(app.ddl, []);
  assert.deepEqual(await rs.db.collection('mazes').findOne({ date }), before);
  assert.equal((await rs.db.collection('mazes').indexes()).length, 2);
});

test('default production app shares one approved policy: legacy login/start/UUID recovery/daily and private archive', async () => {
  await provision();
  await rs.db.collection('mazes').insertMany([date, '2025-05-27'].map(value => ({ date: value, seed: 'stored-legacy', grid, width: 3, height: 1 })));
  await rs.db.collection('rewarditems').insertOne({ id: 'fixture', name: 'Fixture', image: 'x', description: 'Fixture', category: 'artifact', rarity: 'common' });
  const originalMazes = await rs.db.collection('mazes').find({}).sort({ date: 1 }).toArray();
  const root = await snapshot(approvedFixture()), app = await launch(root);
  assert.ok(app.port); assert.equal(app.connectCalls, 1); assert.deepEqual(app.ddl, []);
  assert.equal((await readIndexReadiness(rs.db)).ready, true);
  const archive = await request(app, '/api/maze/archive?month=2025-05');
  assert.equal(archive.status, 200); validateCatalog(archive.data, '2025-05');
  assert.deepEqual(archive.data.items, [{ date, publicationEra: 'legacy' }]);
  assert.equal(archive.data.todayMaze.available, false);
  assert.equal(await rs.db.collection('users').countDocuments({}), 0);
  // Manifest is loaded once; replacing its file never hot-grants/revokes this process.
  await writeFile(join(root, 'config/legacy-publications.json'), JSON.stringify({ schemaVersion: 1,
    policyVersion: 'synthetic-unapproved', status: 'unapproved', approval: null, entries: [] }));
  assert.deepEqual((await request(app, '/api/maze/archive?month=2025-05')).data.items, archive.data.items);
  const email = 'release-fixture@example.invalid', password = 'synthetic-password';
  assert.equal((await request(app, '/api/users/register', { body: { email, password } })).status, 201);
  const login = await request(app, '/api/users/login', { body: { email, password } }); assert.equal(login.status, 200);
  const token = login.data.token;
  const profile = await request(app, '/api/users/subprofile', { token, body: { name: 'Synthetic legacy player' } });
  assert.equal(profile.status, 201); const subProfileId = profile.data[0]._id;
  const started = await request(app, '/api/maze/start', { token, body: { subProfileId, date } });
  assert.equal(started.status, 200);
  assert.deepEqual(Object.keys(started.data).sort(), ['attemptId', 'attemptIndex', 'maze', 'seed', 'today']);
  assert.deepEqual(started.data.maze.grid, grid); assert.equal(started.data.seed, 'stored-legacy');
  await rs.db.collection('users').updateOne({ email }, { $set: { [`subProfiles.0.attempts.${date}.0.started`]: new Date(Date.now() - 10000) } });
  const payload = { subProfileId, date, attemptId: started.data.attemptId };
  const completed = await request(app, '/api/maze/complete', { token, body: payload }); assert.equal(completed.status, 200);
  assert.deepEqual(Object.keys(completed.data).sort(), ['attemptId', 'message', 'reward', 'time', 'today']);
  for (let i = 0; i < 3; i++) assert.deepEqual((await request(app, '/api/maze/complete', { token, body: payload })).data, completed.data);
  const scores = await request(app, '/api/leaderboard/daily?date=' + date);
  assert.equal(scores.status, 200); assert.equal(scores.data.length, 1);
  assert.deepEqual(Object.keys(scores.data[0]).sort(), ['completedMazes', 'name', 'subProfileId', 'time']);
  const own = await request(app, `/api/maze/archive?month=2025-05&subProfileId=${subProfileId}`, { token });
  validateCatalog(own.data, '2025-05'); assert.deepEqual(own.data.items[0].progress, { completed: true });
  const beforeRejected = await rs.db.collection('users').findOne({ email });
  for (const target of ['2025-05-27', '9999-12-31']) {
    assert.equal((await request(app, '/api/maze/start', { token, body: { subProfileId, date: target } })).data.code, 'MAZE_NOT_PUBLISHED');
    assert.equal((await request(app, '/api/leaderboard/daily?date=' + target)).data.code, 'MAZE_NOT_PUBLISHED');
  }
  assert.deepEqual(await rs.db.collection('users').findOne({ email }), beforeRejected);
  assert.equal(beforeRejected.subProfiles[0].attempts[date].length, 1); assert.equal(beforeRejected.subProfiles[0].rewards.fixture, 1);
  assert.deepEqual(await rs.db.collection('mazes').find({}).sort({ date: 1 }).toArray(), originalMazes);
  // A late, positively marked synthetic current-day record becomes visible on read.
  const today = archive.data.today, generated = generateDaily({ date: today });
  await rs.db.collection('mazes').insertOne(publicationDocument(generated, new Date()));
  const fresh = await request(app, '/api/maze/archive?month=' + today.slice(0, 7));
  validateCatalog(fresh.data, today.slice(0, 7)); assert.ok(fresh.data.items.some(item => item.date === today));
  assert.equal(await rs.db.collection('mazes').countDocuments({ date: '2025-05-28' }), 0);
  const stats = await new Promise(resolve => { app.child.once('message', resolve); app.child.send({ op: 'stats' }); });
  assert.deepEqual(stats.ddl, []); assert.equal(stats.connectCalls, 1);
  // Restarts revalidate the artifact; this now-unapproved snapshot cannot listen.
  const restarted = await launch(root); assert.equal(restarted.failure, 'LEGACY_RELEASE_APPROVAL_REQUIRED'); assert.equal(restarted.connectCalls, 0);
});

test('exact-date hash mismatch is hidden in every default route; saved receipt still recovers without another award', async () => {
  await provision();
  await rs.db.collection('mazes').insertOne({ date, seed: 'original', grid: [['S', '#', 'E']], width: 3, height: 1 });
  const app = await launch(await snapshot(approvedFixture())); assert.ok(app.port);
  const archive = await request(app, '/api/maze/archive?month=2025-05'); assert.deepEqual(archive.data.items, []);
  assert.equal((await request(app, '/api/leaderboard/daily?date=' + date)).data.code, 'MAZE_NOT_PUBLISHED');
  const account = new mongoose.Types.ObjectId(), profile = new mongoose.Types.ObjectId();
  const attemptId = '12345678-1234-1234-1234-123456789abc';
  const receipt = { message: 'Maze complete', time: '10.000', reward: null, today: date, attemptId };
  await rs.db.collection('users').insertOne({ _id: account, email: 'saved-fixture@example.invalid', password: 'unused', __v: 0,
    subProfiles: [{ _id: profile, name: 'Synthetic saved player', rewards: { fixture: 1 }, progress: { [date]: { completed: true, time: '10.000' } },
      attempts: { [date]: [{ attemptId, completed: true, started: new Date('2025-05-26T00:00:00Z'), result: receipt }] } }] });
  const token = jwt.sign({ id: account.toString() }, 'synthetic-release-test-key');
  const before = await rs.db.collection('users').findOne({ _id: account });
  const payload = { subProfileId: profile.toString(), date, attemptId };
  assert.equal((await request(app, '/api/maze/start', { token, body: payload })).data.code, 'MAZE_NOT_PUBLISHED');
  assert.deepEqual((await request(app, '/api/maze/complete', { token, body: payload })).data, receipt);
  assert.deepEqual(await rs.db.collection('users').findOne({ _id: account }), before);
  assert.equal(hash((await rs.db.collection('mazes').findOne({ date })).grid), hash([['S', '#', 'E']]));
});

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
