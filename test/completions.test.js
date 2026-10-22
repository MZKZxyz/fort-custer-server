import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Maze from '../models/Maze.js';
import RewardItem from '../models/RewardItem.js';

let db, dir, server, base, user, token, loseResponse = false;
const date = '2025-05-26';
const secret = 'synthetic-test-signing-key';
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
before(async () => {
  // Never consume MONGO_URI: tests own a fresh loopback database and temporary directory.
  dir = await mkdtemp(join(tmpdir(), 'fort-custer-test-'));
  const portServer = net.createServer();
  await listen(portServer);
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  db = spawn(process.env.MONGOD_BINARY || 'mongod', [
    '--dbpath', dir, '--bind_ip', '127.0.0.1', '--port', String(port),
    '--logpath', join(dir, 'mongo.log'),
  ], { stdio: 'ignore' });
  let failure;
  db.on('error', error => { failure = error; });
  db.on('exit', code => { failure = new Error(`mongod exited (${code})`); });
  const deadline = Date.now() + 15000;
  while (true) {
    if (failure) throw failure;
    try {
      await mongoose.connect(`mongodb://127.0.0.1:${port}/synthetic`, { serverSelectionTimeoutMS: 200 });
      break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  process.env.JWT_SECRET = secret;
  const { default: routes } = await import('../routes/mazeRoutes.js');
  const app = express();
  app.use(express.json());
  app.use('/maze', (req, res, next) => {
    const json = res.json.bind(res);
    res.json = value => {
      if (loseResponse && req.path === '/complete' && res.statusCode === 200) {
        loseResponse = false;
        res.socket.destroy();
        return res;
      }
      return json(value);
    };
    next();
  }, routes);
  const { default: leaderboard } = await import('../routes/leaderboardRoutes.js');
  const { default: users } = await import('../routes/userRoutes.js');
  app.use('/leaderboard', leaderboard);
  app.use('/users', users);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/maze`;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (db && db.exitCode === null && db.pid) {
    const exited = new Promise(resolve => db.once('exit', resolve));
    db.kill('SIGTERM');
    await exited;
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Maze.deleteMany({}), RewardItem.deleteMany({})]);
  user = await User.create({ email: 'synthetic@example.invalid', password: 'unused', subProfiles: [{ name: 'Synthetic player' }] });
  token = jwt.sign({ id: user.id }, secret);
  await Maze.create({ date, seed: 'synthetic', grid: [['S', ' ', 'E']], width: 3, height: 1 });
  await RewardItem.create({ id: 'synthetic', name: 'Test reward', image: 'test.png', description: 'Synthetic fixture', category: 'artifact', rarity: 'common' });
});
async function request(path, body = {}, auth = token) {
  const response = await fetch(base + path, { method: 'POST', headers: {
    'Content-Type': 'application/json', Authorization: `Bearer ${auth}`,
  }, body: JSON.stringify({ subProfileId: user.subProfiles[0].id, date, ...body }) });
  return { status: response.status, data: await response.json() };
}
async function readyAttempt() {
  const start = await request('/start');
  assert.equal(start.status, 200);
  const saved = await User.findById(user.id);
  saved.subProfiles[0].attempts.get(date)[0].started = new Date(Date.now() - 10000);
  await saved.save();
  return start.data.attemptId;
}
test('rejects malformed dates and profile identifiers on both endpoints', async () => {
  for (const endpoint of ['/start', '/complete']) {
    for (const body of [{ date: 'invalid' }, { date: '2025-02-30' }, { date: null }, { date: {} }, { subProfileId: 'invalid' }]) {
      assert.equal((await request(endpoint, body)).status, 400);
    }
  }
});
test('missing users and profiles return 404', async () => {
  assert.equal((await request('/complete', { subProfileId: new mongoose.Types.ObjectId().toString() })).status, 404);
  await User.deleteOne({ _id: user.id });
  assert.equal((await request('/complete')).status, 404);
});
test('completion requires an existing attempt and minimum duration', async () => {
  assert.equal((await request('/complete')).status, 400);
  assert.equal((await request('/start')).status, 200);
  assert.equal((await request('/complete')).status, 400);
});
test('completion records progress and awards a reward only once', async () => {
  await readyAttempt();
  const result = await request('/complete');
  assert.equal(result.status, 200);
  assert.equal(result.data.reward.id, 'synthetic');
  assert.deepEqual(await request('/complete'), result);
  const saved = await User.findById(user.id);
  assert.equal(saved.subProfiles[0].rewards.get('synthetic'), 1);
  assert.equal(saved.subProfiles[0].progress.get(date).completed, true);
});
test('concurrent completion requests replay one committed result', async () => {
  await readyAttempt();
  const results = await Promise.all([request('/complete'), request('/complete')]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 200]);
  const saved = await User.findById(user.id);
  assert.equal(saved.subProfiles[0].rewards.get('synthetic'), 1);
});
test('a new attempt after completion is playable', async () => {
  await readyAttempt();
  assert.equal((await request('/complete')).status, 200);
  assert.equal((await request('/start')).status, 200);
  const saved = await User.findById(user.id);
  assert.equal(saved.subProfiles[0].attempts.get(date).length, 2);
  assert.equal(saved.subProfiles[0].attempts.get(date)[1].completed, false);
});

test('stable attempt retries replay the exact response even after another start and reward catalog changes', async () => {
  const attemptId = await readyAttempt();
  const result = await request('/complete', { attemptId, time: 0.001 });
  assert.equal(result.status, 200);
  assert.ok(Number(result.data.time) >= 10);
  await request('/start');
  await RewardItem.deleteMany({});
  for (let i = 0; i < 4; i++) assert.deepEqual(await request('/complete', { attemptId }), result);
  const saved = await User.findById(user.id);
  assert.equal(saved.subProfiles[0].attempts.get(date)[1].completed, false);
  assert.equal(saved.subProfiles[0].rewards.get('synthetic'), 1);
  const scores = await (await fetch(base.replace('/maze', '/leaderboard/daily') + '?date=' + date)).json();
  assert.equal(scores[0].time, result.data.time);
  assert.equal(scores[0].completedMazes, 1);
});

test('many concurrent identical IDs return one persisted result and one reward', async () => {
  const attemptId = await readyAttempt();
  const results = await Promise.all(Array.from({ length: 12 }, () => request('/complete', { attemptId })));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal(results[0].status, 200);
  const saved = await User.findById(user.id);
  const sub = saved.subProfiles[0];
  assert.equal(sub.attempts.get(date).filter(a => a.completed).length, 1);
  assert.equal(sub.rewards.get('synthetic'), 1);
  assert.equal(Number(sub.progress.get(date).time), sub.attempts.get(date)[0].time);
});

test('response lost after persistence is recoverable without another reward', async () => {
  const attemptId = await readyAttempt();
  loseResponse = true;
  await assert.rejects(request('/complete', { attemptId }));
  const saved = await User.findById(user.id);
  const original = saved.subProfiles[0].attempts.get(date)[0].result;
  assert.deepEqual((await request('/complete', { attemptId })).data, JSON.parse(JSON.stringify(original)));
  assert.equal((await User.findById(user.id)).subProfiles[0].rewards.get('synthetic'), 1);
});

test('error before persistence leaves all effects absent and the same attempt retryable', async () => {
  const attemptId = await readyAttempt();
  const save = User.prototype.save;
  User.prototype.save = async function () { throw new Error('synthetic pre-persistence failure'); };
  try { assert.equal((await request('/complete', { attemptId })).status, 500); }
  finally { User.prototype.save = save; }
  const saved = await User.findById(user.id);
  assert.equal(saved.subProfiles[0].attempts.get(date)[0].completed, false);
  assert.equal(saved.subProfiles[0].progress.size, 0);
  assert.equal(saved.subProfiles[0].rewards.size, 0);
  assert.equal((await request('/complete', { attemptId })).status, 200);
});

test('invalid, expired and foreign attempts never mutate progress or inventory', async () => {
  const attemptId = await readyAttempt();
  assert.equal((await request('/complete', { attemptId: 'bad' })).status, 400);
  assert.equal((await request('/complete', { attemptId, date: '2025-05-27' })).status, 400);
  const foreign = await User.create({ email: 'other@example.invalid', password: 'unused', subProfiles: [{ name: 'Other' }] });
  const foreignToken = jwt.sign({ id: foreign.id }, secret);
  assert.equal((await request('/complete', { attemptId }, foreignToken)).status, 404);
  assert.equal((await request('/complete', { attemptId, subProfileId: foreign.subProfiles[0].id })).status, 404);
  const saved = await User.findById(user.id);
  saved.subProfiles[0].attempts.get(date)[0].expiresAt = new Date(Date.now() - 1);
  await saved.save();
  assert.equal((await request('/complete', { attemptId })).status, 410);
  assert.equal((await User.findById(user.id)).subProfiles[0].rewards.size, 0);
});

test('legacy active attempts can finish; historical completed attempts cannot award again', async () => {
  await readyAttempt();
  let saved = await User.findById(user.id);
  saved.subProfiles[0].attempts.get(date)[0].attemptId = undefined;
  await saved.save();
  assert.equal((await request('/complete')).status, 200);
  saved = await User.findById(user.id);
  saved.subProfiles[0].attempts.get(date)[0].result = undefined;
  await saved.save();
  assert.equal((await request('/complete')).status, 409);
  assert.equal((await User.findById(user.id)).subProfiles[0].rewards.get('synthetic'), 1);
});

test('legacy progress endpoint cannot inject client times into leaderboard', async () => {
  const response = await fetch(base.replace('/maze', '/users/subprofile/') + user.subProfiles[0].id + '/progress', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ date, time: 0.001 }),
  });
  assert.equal(response.status, 409);
  assert.equal((await User.findById(user.id)).subProfiles[0].progress.size, 0);
});

test('distinct concurrent attempts keep both results and consistent reward inventory', async () => {
  const firstId = await readyAttempt();
  const secondId = (await request('/start')).data.attemptId;
  const initial = await User.findById(user.id);
  initial.subProfiles[0].attempts.get(date)[1].started = new Date(Date.now() - 12000);
  await initial.save();
  await RewardItem.create({ id: 'second', name: 'Second', image: 'second.png', description: 'Synthetic', category: 'artifact', rarity: 'common' });
  const results = await Promise.all([request('/complete', { attemptId: firstId }), request('/complete', { attemptId: secondId })]);
  assert.ok(results.every(r => r.status === 200));
  assert.notEqual(results[0].data.reward.id, results[1].data.reward.id);
  const saved = await User.findById(user.id);
  const sub = saved.subProfiles[0];
  assert.equal(sub.rewards.size, 2);
  assert.ok([...sub.rewards.values()].every(quantity => quantity === 1));
  assert.ok(sub.attempts.get(date).every(a => a.completed && a.result));
  const progress = sub.progress.get(date);
  assert.ok(results.some(r => r.data.time === progress.time));
});

test('a saved result replays after expiration and does not change the latest daily score', async () => {
  const attemptId = await readyAttempt();
  const original = await request('/complete', { attemptId });
  const nextId = (await request('/start')).data.attemptId;
  const initial = await User.findById(user.id);
  initial.subProfiles[0].attempts.get(date)[0].expiresAt = new Date(Date.now() - 1);
  initial.subProfiles[0].attempts.get(date)[1].started = new Date(Date.now() - 15000);
  await initial.save();
  const latest = await request('/complete', { attemptId: nextId });
  assert.deepEqual(await request('/complete', { attemptId }), original);
  const saved = await User.findById(user.id);
  assert.equal(saved.subProfiles[0].progress.get(date).time, latest.data.time);
});

test('missing document versions fail safely without silently rewriting imported player data', async () => {
  const attemptId = await readyAttempt();
  await User.collection.updateOne({ _id: user._id }, { $unset: { __v: '' } });
  const results = await Promise.all([request('/complete', { attemptId }), request('/complete', { attemptId })]);
  assert.ok(results.every(r => r.status === 409 && r.data.code === 'PROFILE_VERSION_REQUIRED'));
  const saved = await User.findById(user.id);
  assert.equal(saved.subProfiles[0].rewards.size, 0);
  assert.equal(saved.subProfiles[0].progress.size, 0);
  assert.equal(saved.subProfiles[0].attempts.get(date)[0].completed, false);
});
