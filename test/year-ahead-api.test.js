import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import Maze from '../models/Maze.js';
import User from '../models/User.js';
import { generateDaily } from '../lib/maze/engine.js';
import { publicationDocument } from '../services/publication/policy.js';
import { createLegacyPolicy } from '../services/publication/legacy-policy.js';

// Actual old /start excerpt plus current router, with an in-memory repository seam.
// No database credentials, DB connections or production HTTP requests are used.
test('old/new disposable HTTP fixtures prove storage isolation is essential, even with valid auth', async t => {
  const secret = 'synthetic-year-ahead-api-only'; process.env.JWT_SECRET = secret;
  const [{ createMazeRouter: oldRouter }, { createMazeRouter: newRouter }] = await Promise.all([
    import('../tools/test-support/year-ahead-old-router.js'), import('../routes/mazeRoutes.js'),
  ]);
  const future = '2096-02-29', now = new Date('2031-03-09T10:00:00Z');
  const generated = generateDaily({ date: future, seed: 'public-disposable-test-fixture' });
  // Deliberately poisoned normal collection: even plausible provenance must not expose a future maze.
  const row = publicationDocument(generated, new Date('2096-02-29T00:00:00Z'));
  const profileId = '507f1f77bcf86cd799439011', userId = '507f1f77bcf86cd799439012';
  const sub = { attempts: new Map() }, subs = [sub]; subs.id = id => id === profileId ? sub : null;
  const fakeUser = { __v: 0, subProfiles: subs, markModified() {}, async save() {} };
  const originalFind = Maze.findOne, originalUser = User.findById;
  let liveRow = null, reads = 0;
  Maze.findOne = () => {
    reads++;
    const query = { select: () => query, maxTimeMS: () => query, lean: async () => liveRow,
      then: (resolve, reject) => Promise.resolve(liveRow).then(resolve, reject) };
    return query;
  };
  User.findById = async () => fakeUser;
  t.after(() => { Maze.findOne = originalFind; User.findById = originalUser; });
  const app = express(); app.use(express.json());
  app.use('/old', oldRouter()); app.use('/new', newRouter({ now: () => now, legacy: createLegacyPolicy() }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const token = jwt.sign({ id: userId }, secret);
  const request = async (route, auth) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/${route}/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ date: future, subProfileId: profileId }),
    });
    return { status: r.status, text: await r.text() };
  };
  // Offline private staging leaves normal lookup empty, including on the deployed old code.
  for (const route of ['old', 'new']) assert.equal((await request(route, true)).status, 404);
  liveRow = row;
  for (const route of ['old', 'new']) {
    const before = reads, r = await request(route, false); assert.equal(r.status, 401); assert.equal(reads, before);
    assert.equal(r.text.includes(generated.seed), false);
  }
  const old = await request('old', true); assert.equal(old.status, 200);
  assert.equal(JSON.parse(old.text).seed, generated.seed);
  const guarded = await request('new', true); assert.equal(guarded.status, 404);
  for (const sensitive of [generated.seed, generated.gridHash, generated.identityHash, JSON.stringify(generated.maze.grid)]) assert.equal(guarded.text.includes(sensitive), false);
  assert.equal(sub.attempts.get(future).length, 1, 'only the old fixture saves an attempt');
});
