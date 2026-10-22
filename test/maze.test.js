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

let db, dir, server, base, user, token;
const date = '2025-05-26';
const secret = 'synthetic-test-signing-key';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
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
  app.use('/maze', routes);
  server = app.listen();
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
  assert.equal((await request('/start')).status, 200);
  const saved = await User.findById(user.id);
  saved.subProfiles[0].attempts.get(date)[0].started = new Date(Date.now() - 10000);
  await saved.save();
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
  assert.equal((await request('/complete')).status, 409);
  const saved = await User.findById(user.id);
  assert.equal(saved.subProfiles[0].rewards.get('synthetic'), 1);
  assert.equal(saved.subProfiles[0].progress.get(date).completed, true);
});
test('concurrent completion requests cannot both commit', async () => {
  await readyAttempt();
  const results = await Promise.all([request('/complete'), request('/complete')]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
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
