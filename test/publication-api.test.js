import { test, before, beforeEach, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import Maze from '../models/Maze.js';
import User from '../models/User.js';
import RewardItem from '../models/RewardItem.js';
import { replicaSet } from '../tools/transaction-feasibility/replica-set.mjs';
import { fixturePublications } from '../tools/test-support/legacy-publications.mjs';
import { generateDaily, generationIdentity, hash } from '../lib/maze/engine.js';
import { publicationDocument, isPublished } from '../services/publication/policy.js';
import { publishMaze } from '../services/publication/publisher.js';

const secret = 'synthetic-archive-test-key', legacyDate = '2025-05-26', legacyGrid = [['S', ' ', 'E']];
const legacy = fixturePublications([[legacyDate, legacyGrid]]);
let rs, server, base, user, other, token, clock, clockSamples, children = [];
const request = async (path, { auth, body } = {}) => {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: {
    ...(auth ? { Authorization: auth === true ? `Bearer ${token}` : auth } : {}),
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json(), headers: response.headers };
};
const document = (date, { at = clock, ...input } = {}) => publicationDocument(generateDaily({ date, ...input }), new Date(at));
const insert = async (date, options) => Maze.create(document(date, options));
const start = date => request('/api/maze/start', { auth: true, body: { subProfileId: user.subProfiles[0].id, date } });

before(async () => {
  process.env.JWT_SECRET = secret;
  const [{ createMazeRouter }, { createLeaderboardRouter }] = await Promise.all([
    import('../routes/mazeRoutes.js'), import('../routes/leaderboardRoutes.js'),
  ]);
  rs = await replicaSet();
  // Loopback fixture: 2s discovery/connect budgets and a 3s socket budget above the 2s command limit.
  await mongoose.connect(rs.uri.replace('/fc_synthetic?', '/fc_publication_synthetic_main?'), {
    serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000, socketTimeoutMS: 3000,
  });
  await Promise.all([Maze.init(), User.init(), RewardItem.init()]);
  const app = express(); app.use(express.json());
  const sample = () => { clockSamples++; return new Date(clock); };
  app.use('/api/maze', createMazeRouter({ now: sample, legacy }));
  app.use('/strict/maze', createMazeRouter({ now: () => new Date(clock) }));
  app.use('/api/leaderboard', createLeaderboardRouter({ now: sample, legacy }));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 40000 });
after(async () => {
  server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect(); await rs?.close();
});
beforeEach(async () => {
  clock = Date.parse('2028-03-01T12:00:00Z');
  clockSamples = 0;
  await Promise.all([Maze.deleteMany({}), User.deleteMany({}), RewardItem.deleteMany({})]);
  user = await User.create({ email: 'owner@example.invalid', password: 'unused', subProfiles: [
    { name: 'Private owner', age: 10, progress: { '2028-02-29': { completed: true, time: '4.000' } }, rewards: { private: 2 } },
    { name: 'Other owned profile', progress: { '2028-02-29': { completed: false } } },
  ] });
  other = await User.create({ email: 'foreign@example.invalid', password: 'unused', subProfiles: [{ name: 'Foreign private profile' }] });
  token = jwt.sign({ id: user.id }, secret);
});
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  children = [];
});

test('strict model persists complete provenance and unique date index; content cannot be overwritten', async () => {
  const record = await insert('2028-02-29');
  const before = await Maze.collection.findOne({ _id: record._id });
  assert.equal(before.provenance.gridHash, hash(before.grid));
  assert.ok(isPublished(before, new Date(clock)));
  const indexes = await Maze.collection.indexes();
  assert.ok(indexes.some(index => index.unique && index.key.date === 1));
  assert.ok(indexes.some(index => index.key.publicationEra === 1 && index.key.date === 1 && index.key.publishedAt === 1));
  const loaded = await Maze.findById(record.id);
  loaded.grid = [['S', 'E']]; loaded.seed = 'overwrite'; loaded.publishedAt = new Date(0);
  loaded.provenance = { invalid: true };
  await assert.rejects(loaded.save(), /MAZE_INSERT_ONLY/);
  const after = await Maze.collection.findOne({ _id: record._id });
  for (const key of ['grid', 'seed', 'date', 'publishedAt', 'provenance', 'width', 'height']) assert.deepEqual(after[key], before[key]);
  await assert.rejects(Maze.create(document('2028-02-29')), { code: 11000 });
  const bad = document('2028-02-28'); bad.provenance.gridHash = '0'.repeat(64);
  await assert.rejects(Maze.create(bad), /INVALID_PUBLICATION_MANIFEST/);
  const unknown = document('2028-02-28'); unknown.provenance.extra = 'refused';
  await assert.rejects(Maze.create(unknown));
  await Maze.create({ date: legacyDate, seed: 'original', grid: legacyGrid, width: 3, height: 1 });
  assert.equal((await Maze.findOne({ date: legacyDate })).publishedAt, undefined);
  const original = await Maze.findOne({ date: legacyDate }); original.grid[0][1] = '#';
  await assert.rejects(original.save(), /MAZE_INSERT_ONLY/);
  await assert.rejects(Maze.updateOne({ date: legacyDate }, { $set: { 'grid.0.1': '#' } }), /MAZE_INSERT_ONLY/);
  await assert.rejects(Maze.bulkWrite([{ updateOne: { filter: { date: legacyDate }, update: { $set: { seed: 'overwrite' } } } }]), /MAZE_INSERT_ONLY/);
});

test('monthly archive is sparse, chronological, read-only and excludes future/drafts/unknown legacy rows', async () => {
  await insert('2028-02-28'); await insert('2028-02-29'); await insert('2028-03-01');
  await insert('2028-03-02', { at: Date.parse('2028-03-02T00:00:00Z') });
  await Maze.create({ date: legacyDate, seed: 'original', grid: legacyGrid, width: 3, height: 1 });
  await Maze.create({ date: '2025-05-27', seed: 'unknown', grid: legacyGrid, width: 3, height: 1 });
  const corrupt = document('2028-02-27'); corrupt.grid[1][1] = 'S'; await Maze.collection.insertOne(corrupt);
  const before = await Maze.collection.find({}).sort({ date: 1 }).toArray();
  const response = await request('/api/maze/archive?month=2028-02');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.items, ['2028-02-28', '2028-02-29'].map(date => ({ date, publicationEra: 'year-round-v1' })));
  assert.equal(response.body.today, '2028-03-01'); assert.equal(response.body.serverNow, new Date(clock).toISOString());
  assert.equal(response.body.nextDayAt, '2028-03-02T00:00:00.000Z');
  assert.equal(response.body.firstPublishedDate, legacyDate); assert.equal(response.body.lastPublishedDate, '2028-03-01');
  assert.deepEqual(response.body.todayMaze, { date: '2028-03-01', publicationEra: 'year-round-v1', available: true });
  assert.equal(response.headers.get('cache-control'), 'public, max-age=60');
  assert.match(response.headers.get('vary'), /Authorization/i);
  const text = JSON.stringify(response.body);
  for (const key of ['grid', 'seed', 'attempt', 'reward', 'provenance', 'Private']) assert.ok(!text.includes(key));
  assert.equal((await request('/api/maze/archive')).body.month, '2028-03');
  for (const month of ['2027-01', '2029-01', '0001-01', '9999-12']) {
    const empty = await request(`/api/maze/archive?month=${month}`); assert.equal(empty.status, 200); assert.deepEqual(empty.body.items, []);
  }
  assert.deepEqual(await Maze.collection.find({}).sort({ date: 1 }).toArray(), before);
  assert.equal((await User.findById(user.id)).subProfiles[0].attempts.size, 0);
  const strict = await request('/strict/maze/archive?month=2025-05'); assert.deepEqual(strict.body.items, []);
});

test('all 31 dates form one complete month; 0001/9999 and Gregorian century endpoints stay addressable', async () => {
  clock = Date.parse('9999-12-31T23:59:59Z');
  for (let day = 1; day <= 31; day++) await insert(`2028-01-${String(day).padStart(2, '0')}`);
  await insert('0001-01-01'); await insert('9999-12-31');
  const r = await request('/api/maze/archive?month=2028-01');
  assert.equal(r.status, 200); assert.equal(r.body.items.length, 31);
  assert.equal(r.body.items[0].date, '2028-01-01'); assert.equal(r.body.items.at(-1).date, '2028-01-31');
  assert.equal(r.body.firstPublishedDate, '0001-01-01'); assert.equal(r.body.lastPublishedDate, '9999-12-31');
  assert.equal((await request('/api/maze/archive?month=9999-12')).body.items[0].date, '9999-12-31');
});

test('private completion projection is strictly owner-scoped; auth/errors never enter a public cache', async () => {
  await insert('2028-02-29'); await insert('2028-03-01');
  const path = `/api/maze/archive?month=2028-02&subProfileId=${user.subProfiles[0].id}`;
  for (const auth of [undefined, 'Bearer invalid']) {
    const r = await request(path, { auth }); assert.equal(r.status, 401); assert.equal(r.headers.get('cache-control'), 'private, no-store');
  }
  const own = await request(path, { auth: true });
  assert.equal(own.status, 200); assert.deepEqual(own.body.items[0].progress, { completed: true });
  assert.deepEqual(own.body.todayMaze.progress, { completed: false });
  assert.equal(own.headers.get('cache-control'), 'private, no-store');
  const sibling = await request(path.replace(user.subProfiles[0].id, user.subProfiles[1].id), { auth: true });
  assert.deepEqual(sibling.body.items[0].progress, { completed: false });
  const foreign = await request(path.replace(user.subProfiles[0].id, other.subProfiles[0].id), { auth: true });
  const missing = await request(path.replace(user.subProfiles[0].id, new mongoose.Types.ObjectId().toString()), { auth: true });
  assert.equal(foreign.status, 404); assert.deepEqual(foreign.body, missing.body);
  const malformed = await request(path.replace(user.subProfiles[0].id, 'bad'), { auth: true });
  assert.equal(malformed.status, 400); assert.equal(malformed.body.code, 'INVALID_PROFILE_ID');
  for (const word of ['Private', 'Foreign', 'age', 'reward', 'attempt', 'profileId', 'email']) assert.ok(!JSON.stringify(own.body).includes(word));
  const metadataWithAuth = await request('/api/maze/archive?month=2028-02', { auth: true });
  assert.equal(metadataWithAuth.headers.get('cache-control'), 'private, no-store');
  assert.equal(Object.hasOwn(metadataWithAuth.body.items[0], 'progress'), false);
});

test('query cardinality and calendar errors are stable across public/private reads and daily guards', async () => {
  for (const query of ['month=2028-02&month=2028-03', 'month[]=2028-02', 'subProfileId=x&subProfileId=y', 'extra=x']) {
    const r = await request('/api/maze/archive?' + query); assert.equal(r.status, 400); assert.equal(r.body.code, 'INVALID_QUERY');
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
  }
  for (const month of ['2028-2', '0000-01', '1900-02-29', '2028-13', '']) {
    const r = await request('/api/maze/archive?month=' + month); assert.equal(r.status, 400); assert.equal(r.body.code, 'INVALID_MONTH');
  }
  for (const query of ['date=2028-02-29&date=2028-02-28', 'date[]=2028-02-29']) {
    const r = await request('/api/leaderboard/daily?' + query); assert.equal(r.status, 400); assert.equal(r.body.code, 'INVALID_QUERY');
  }
  for (const date of ['1900-02-29', '0000-01-01', '2028-02-30', '2028-2-01', '']) {
    const r = await request('/api/leaderboard/daily?date=' + date); assert.equal(r.status, 400); assert.equal(r.body.code, 'INVALID_DATE');
  }
});

test('start and daily leaderboard enforce identical publication admission with no rejected attempt writes', async () => {
  await insert('2028-02-29'); await insert('2028-03-02', { at: Date.parse('2028-03-02T00:00:00Z') });
  await insert('2028-02-28', { at: Date.parse('2028-03-02T00:00:00Z') });
  await Maze.create({ date: '2028-02-27', seed: 'unknown', grid: legacyGrid, width: 3, height: 1 });
  const before = await User.collection.findOne({ _id: user._id });
  for (const date of ['2028-03-02', '2028-02-28', '2028-02-27', '2027-12-31']) {
    const a = await start(date), b = await request('/api/leaderboard/daily?date=' + date);
    for (const r of [a, b]) { assert.equal(r.status, 404); assert.equal(r.body.code, 'MAZE_NOT_PUBLISHED'); }
  }
  assert.deepEqual(await User.collection.findOne({ _id: user._id }), before);
  const accepted = await start('2028-02-29');
  assert.equal(accepted.status, 200); assert.deepEqual(Object.keys(accepted.body).sort(), ['attemptId', 'attemptIndex', 'maze', 'seed', 'today']);
  assert.equal(accepted.body.attemptIndex, 0); assert.equal(accepted.body.today, '2028-03-01');
  const scores = await request('/api/leaderboard/daily?date=2028-02-29');
  assert.equal(scores.status, 200); assert.ok(Array.isArray(scores.body)); assert.equal(scores.body[0].time, '4.000');
  await insert('2028-01-01'); assert.deepEqual((await request('/api/leaderboard/daily?date=2028-01-01')).body, []);
  for (const timeframe of ['weekly', 'alltime']) assert.equal((await request('/api/leaderboard/' + timeframe)).status, 200);
});

test('UTC rollover, late publication, empty catalog and bounded caches never fabricate a release', async () => {
  clock = Date.parse('2028-02-29T23:59:59.500Z');
  let r = await request('/api/maze/archive');
  assert.equal(r.status, 200); assert.equal(r.body.firstPublishedDate, null); assert.equal(r.body.lastPublishedDate, null);
  assert.deepEqual(r.body.todayMaze, { date: '2028-02-29', available: false });
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  await insert('2028-03-01', { at: Date.parse('2028-03-01T00:00:00Z') });
  assert.equal((await start('2028-03-01')).status, 404);
  clock = Date.parse('2028-03-01T00:00:00Z');
  r = await request('/api/maze/archive'); assert.equal(r.body.todayMaze.available, true); assert.equal(r.body.month, '2028-03');
  assert.equal((await start('2028-03-01')).status, 200);
  clock = Date.parse('2028-03-02T00:00:00Z');
  assert.equal((await request('/api/maze/archive')).body.todayMaze.available, false);
  await insert('2028-03-02');
  assert.equal((await request('/api/maze/archive')).body.todayMaze.available, true);
});

test('valid saved attempts complete after midnight/catalog loss and replay receipts without double awards', async () => {
  await insert('2028-02-29');
  const started = await start('2028-02-29'); assert.equal(started.status, 200);
  await User.collection.updateOne({ _id: user._id }, { $set: {
    'subProfiles.0.attempts.2028-02-29.0.started': new Date(Date.now() - 10000),
  } });
  await RewardItem.create({ id: 'synthetic-award', name: 'Fixture', image: 'x', description: 'x', category: 'artifact', rarity: 'common' });
  await Maze.collection.deleteOne({ date: '2028-02-29' });
  clock = Date.parse('2028-03-02T00:00:00Z');
  const body = { subProfileId: user.subProfiles[0].id, date: '2028-02-29', attemptId: started.body.attemptId };
  const saved = await request('/api/maze/complete', { auth: true, body }); assert.equal(saved.status, 200);
  const before = await User.collection.findOne({ _id: user._id });
  for (let i = 0; i < 3; i++) assert.deepEqual((await request('/api/maze/complete', { auth: true, body })).body, saved.body);
  assert.deepEqual(await User.collection.findOne({ _id: user._id }), before);
  const wrong = await request('/api/maze/complete', { auth: true, body: { ...body, subProfileId: user.subProfiles[1].id } });
  assert.equal(wrong.status, 400);
  assert.deepEqual(Object.keys(saved.body).sort(), ['attemptId', 'message', 'reward', 'time', 'today']);
});

test('each request samples one trusted instant across civil offsets and both DST transitions', async () => {
  for (const [instant, today] of [
    ['2028-03-12T01:59:59-08:00', '2028-03-12'], ['2028-03-12T03:00:00-07:00', '2028-03-12'],
    ['2028-11-05T01:30:00-07:00', '2028-11-05'], ['2028-11-05T01:30:00-08:00', '2028-11-05'],
    ['2028-01-01T00:15:00+14:00', '2027-12-31'],
  ]) {
    clock = Date.parse(instant); clockSamples = 0;
    const archive = await request('/api/maze/archive');
    assert.equal(archive.status, 200); assert.equal(archive.body.today, today); assert.equal(clockSamples, 1);
    assert.equal(Date.parse(archive.body.nextDayAt) - Date.parse(`${today}T00:00:00Z`), 86400000);
    clockSamples = 0; assert.equal((await start(today)).status, 404); assert.equal(clockSamples, 1);
    clockSamples = 0; assert.equal((await request('/api/leaderboard/daily')).status, 404); assert.equal(clockSamples, 1);
  }
});

test('catalog integrity/query failure is a private 503, never empty publication state', async () => {
  const original = Maze.find;
  try {
    Maze.find = () => { throw Error('private database diagnostic'); };
    const r = await request('/api/maze/archive'); assert.equal(r.status, 503); assert.equal(r.body.code, 'ARCHIVE_UNAVAILABLE');
    assert.equal(r.headers.get('cache-control'), 'private, no-store'); assert.ok(!JSON.stringify(r.body).includes('diagnostic'));
  } finally { Maze.find = original; }
  const bad = document('2028-01-01'); bad.provenance.gridHash = '0'.repeat(64);
  for (let day = 1; day <= 32; day++) {
    const date = day <= 31 ? `2028-01-${String(day).padStart(2, '0')}` : '2028-02-01';
    await Maze.collection.insertOne({ ...bad, date });
  }
  const r = await request('/api/maze/archive'); assert.equal(r.status, 503); assert.equal(r.body.code, 'ARCHIVE_UNAVAILABLE');
});

test('dormant publisher inserts atomically, reuses any stored winner unchanged and refuses live-shaped handles', async () => {
  const input = { date: '2028-02-29' };
  const first = await publishMaze({ model: Maze, input, now: new Date(clock) });
  assert.equal(first.created, true); assert.ok(isPublished(first.maze, new Date(clock))); assert.deepEqual(first.diagnostics, []);
  const before = await Maze.collection.findOne({ date: input.date });
  const retry = await publishMaze({ model: Maze, input, now: new Date(clock + 1000) });
  assert.equal(retry.created, false); assert.deepEqual(retry.maze, before);
  const conflict = await publishMaze({ model: Maze, input: { ...input, seed: 'different' }, now: new Date(clock) });
  assert.deepEqual(conflict.maze, before); assert.deepEqual(conflict.diagnostics, ['STORED_WINNER_IDENTITY_MISMATCH']);
  assert.deepEqual(await Maze.collection.findOne({ date: input.date }), before);
  // A conflicting future algorithm/hash on an existing row is never regenerated.
  await Maze.collection.updateOne({ date: input.date }, { $set: { 'provenance.algorithmVersion': 'future-unrecognized-version', 'provenance.gridHash': '0'.repeat(64) } });
  const conflicting = await Maze.collection.findOne({ date: input.date });
  const retainedConflict = await publishMaze({ model: Maze, input, now: clock });
  assert.deepEqual(retainedConflict.maze, conflicting);
  assert.deepEqual(retainedConflict.diagnostics, ['STORED_WINNER_IDENTITY_MISMATCH']);
  await assert.rejects(publishMaze({ model: { db: { readyState: 1, name: 'production', getClient: () => ({ options: { hosts: [{ host: 'example.invalid' }] } }) } }, input, now: new Date(clock) }),
    { code: 'LIVE_PUBLICATION_NOT_AUTHORIZED' });
  await assert.rejects(publishMaze({ model: Maze, input: { date: '2028-03-02' }, now: new Date(clock) }), { code: 'FUTURE_PUBLICATION_REFUSED' });
  const existingLegacy = { date: legacyDate, seed: 'unknown-original', grid: legacyGrid, width: 3, height: 1 };
  await Maze.collection.insertOne(existingLegacy);
  const retained = await publishMaze({ model: Maze, input: { date: legacyDate }, now: new Date(clock) });
  assert.equal(retained.created, false); assert.deepEqual(retained.maze, await Maze.collection.findOne({ date: legacyDate }));
  // An incomplete existing winner is quarantined for owner review, never repaired.
  const incompleteInput = { date: '2028-02-28' };
  await Maze.collection.insertOne({ date: incompleteInput.date, provenance: { identityHash: generationIdentity(incompleteInput).identityHash } });
  const incomplete = await Maze.collection.findOne({ date: incompleteInput.date });
  const refusedRepair = await publishMaze({ model: Maze, input: incompleteInput, now: clock });
  assert.deepEqual(refusedRepair.maze, incomplete);
  assert.deepEqual(refusedRepair.diagnostics, ['STORED_WINNER_IDENTITY_MISMATCH']);
});

test('two independent publishers race different identities: duplicate-key loser returns exact immutable winner', { timeout: 15000 }, async () => {
  const uri = rs.uri.replace('/fc_synthetic?', '/fc_publication_synthetic_race?');
  await rs.client.db('fc_publication_synthetic_race').collection('mazes').deleteMany({});
  function run(seed) {
    const child = fork(new URL('../tools/test-support/publication-race.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(child);
    let candidate, result;
    const ready = new Promise(resolve => { candidate = resolve; });
    const done = new Promise((resolve, reject) => {
      child.on('message', message => { if (message.stage === 'candidate') candidate(); else if (message.result) { result = message.result; resolve(result); } else reject(Error(message.error)); });
      child.on('error', reject); child.on('exit', code => { if (!result) reject(Error(`fixture exited ${code}`)); });
    });
    child.send({ uri, input: { date: '2028-02-29', seed }, now: clock });
    return { child, ready, done };
  }
  const a = run('race-A'), b = run('race-B');
  await Promise.all([a.ready, b.ready]); a.child.send({ go: true }); b.child.send({ go: true });
  const results = await Promise.all([a.done, b.done]);
  assert.equal(results.filter(r => r.created).length, 1);
  assert.equal(await rs.client.db('fc_publication_synthetic_race').collection('mazes').countDocuments({}), 1);
  assert.deepEqual(results[0].maze, results[1].maze);
  assert.deepEqual(results.find(r => !r.created).diagnostics, ['STORED_WINNER_IDENTITY_MISMATCH']);
});

test('generation rejection and ambiguous insert ACK leave no partial row and exact retry recovers winner', async () => {
  const input = { date: '2028-02-29', config: { minDistance: 10201, maxAttempts: 2 } };
  await assert.rejects(publishMaze({ model: Maze, input, now: clock }), { code: 'GENERATION_EXHAUSTED' });
  assert.equal(await Maze.countDocuments({}), 0);
  const original = Maze.create;
  try {
    Maze.create = async (...args) => { await original.apply(Maze, args); throw Error('synthetic lost ACK'); };
    await assert.rejects(publishMaze({ model: Maze, input: { date: input.date }, now: clock }), { code: 'PUBLICATION_UNCERTAIN' });
  } finally { Maze.create = original; }
  const before = await Maze.collection.findOne({ date: input.date }); assert.ok(before?.provenance);
  const recovered = await publishMaze({ model: Maze, input: { date: input.date }, now: clock });
  assert.equal(recovered.created, false); assert.deepEqual(recovered.maze, before);
});

test('actual insert connection loss leaves no partial row; exact-identity retry publishes one complete record', async () => {
  // Both the original insert and the driver's one retry lose their connection.
  await rs.client.db('admin').command({ configureFailPoint: 'failCommand', mode: { times: 2 },
    data: { failCommands: ['insert'], closeConnection: true } });
  try {
    await assert.rejects(publishMaze({ model: Maze, input: { date: '2028-02-29' }, now: clock }), { code: 'PUBLICATION_UNCERTAIN' });
    assert.equal(await Maze.countDocuments({}), 0);
  } finally { await rs.failOff(); }
  const recovered = await publishMaze({ model: Maze, input: { date: '2028-02-29' }, now: clock });
  assert.equal(recovered.created, true); assert.ok(isPublished(recovered.maze, new Date(clock)));
  assert.equal(await Maze.countDocuments({}), 1);
});

test('real disposable publisher inserts nothing on ENOENT/EACCES and publishes after monitoring recovers', { timeout: 15000 }, async () => {
  const child = fork(new URL('../tools/test-support/publication-monitor.mjs', import.meta.url), ['publisher'], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  children.push(child);
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    let reported = false;
    child.once('message', message => { reported = true; resolve(message.report); });
    child.once('error', reject);
    child.once('exit', code => { if (!reported) reject(Error(`monitor fixture exited ${code}: ${stderr}`)); });
  });
  child.send({ uri: rs.uri.replace('/fc_synthetic?', '/fc_publication_synthetic_monitor?') });
  const report = await done;
  assert.deepEqual(report.failures, [{ code: 'ENOENT', inserted: 0 }, { code: 'EACCES', inserted: 0 }]);
  assert.equal(report.healthyPublications, 2); assert.equal(report.allChildrenClosed, true);
  assert.equal(await rs.client.db('fc_publication_synthetic_monitor').collection('mazes').countDocuments({}), 2);
});
