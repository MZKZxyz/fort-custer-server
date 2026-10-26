import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import http from 'node:http';
import { replicaSet, until } from '../tools/transaction-feasibility/replica-set.mjs';
import { PlayableRepository, COLLECTIONS } from '../services/playable/repository.js';
import { PlayableService } from '../services/playable/service.js';
import { createPlayableRouter } from '../routes/playableRoutes.js';
import { installPlayableRuntime, RELEASE_BLOCKERS } from '../services/playable/runtime.js';
import { recordAcceptedDate } from '../services/playable/date-ledger.js';
import { RouteValidator } from '../services/playable/validator.js';

const date = '2025-05-26', baseTime = Date.parse('2026-10-26T00:00:00Z');
const secret = 'synthetic-runtime-signing-key';
const actor = { accountId: new mongoose.Types.ObjectId().toString(), profileId: new mongoose.Types.ObjectId().toString() };
const sibling = { ...actor, profileId: new mongoose.Types.ObjectId().toString() };
const foreign = { accountId: new mongoose.Types.ObjectId().toString(), profileId: new mongoose.Types.ObjectId().toString() };
const route = dirs => ({ version: 'route-transcript-v1', commands: dirs.map((dir, i) => ({ seq: i + 1, dir })) });
const proof = route(['right', 'right', 'right', 'right']);
let rs, repo, service, server, base, now, samples, health, epoch, hook, children = [];
const clock = { sample: () => ({ at: samples.length ? samples.shift() : now, epoch, healthy: health,
  uncertaintyMs: 1, evidenceId: 'synthetic-monitor' }) };
async function listen(app) {
  const value = app.listen(0, '127.0.0.1'); await new Promise(resolve => value.once('listening', resolve)); return value;
}
async function request(path, body, { who = actor, token, ifMatch, headers = {}, url = base } = {}) {
  const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: {
    Authorization: `Bearer ${token ?? jwt.sign({ id: who.accountId }, secret)}`, 'Content-Type': 'application/json',
    'X-Fort-Custer-Protocol': 'session-v2', 'X-Fort-Custer-Capabilities': 'route-transcript-v1',
    ...(ifMatch === undefined ? {} : { 'If-Match': `"${ifMatch}"` }), ...headers,
  }, ...(body === undefined ? {} : { body: JSON.stringify({ subProfileId: who.profileId, ...body }) }) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}
async function create(who = actor, key = 'create-key') {
  const response = await request('/sessions', { date, createKey: key }, { who });
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
}
async function started(who = actor, key = 'create-key') {
  const s = await create(who, key); now = baseTime + 10;
  const response = await request(`/sessions/${s.attemptId}/ready`, { key: 'ready-key', nonce: s.nonce,
    gridHash: s.gridHash, rulesVersion: s.manifest.rulesVersion }, { who, ifMatch: s.revision });
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
}
const complete = (s, key = 'complete-key', transcript = proof, options = {}) => request(`/sessions/${s.attemptId}/complete`,
  { completionKey: key, transcript }, { ifMatch: s.revision, ...options });
function barrier(stage) {
  let enter, release, once = false;
  const entered = new Promise(resolve => { enter = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  hook = async observed => { if (observed === stage && !once) { once = true; enter(); await waiting; } };
  return { entered, release };
}
async function totals() { return Object.fromEntries(await Promise.all(COLLECTIONS.map(async name => [name, await repo.c(name).countDocuments()]))); }
async function assertFinal(s) {
  await repo.tx(async session => {
    const opts = { session }, saved = await repo.c('sessions').findOne({ _id: s.attemptId }, opts);
    const result = await repo.c('results').findOne({ attemptId: s.attemptId }, opts);
    assert.equal(saved.state, 'COMPLETED'); assert.equal(saved.pending, undefined);
    assert.equal(result.validity, 'accepted'); assert.equal(result.response.progress.completed, true);
    assert.equal(await repo.c('slots').countDocuments({ attemptId: s.attemptId }, opts), 0);
    assert.equal(await repo.c('outbox').countDocuments({ resultId: result._id, type: 'receipt-accepted' }, opts), 1);
    assert.equal((await repo.c('intents').findOne({ _id: result.intentId }, opts)).state, 'completed');
    assert.equal(await repo.c('progress').countDocuments({ ...actor, date }, opts), 1);
    assert.equal(await repo.c('dateLedger').countDocuments({ ...actor, date }, opts), 1);
  });
}
before(async () => { rs = await replicaSet(); repo = new PlayableRepository(rs.client, rs.db); await repo.provision(); }, { timeout: 40000 });
after(async () => { await rs?.close(); });
beforeEach(async () => {
  for (const name of COLLECTIONS) await repo.c(name).deleteMany({});
  await rs.db.collection('users').deleteMany({}); await rs.db.collection('mazes').deleteMany({});
  await rs.db.collection('users').insertMany([actor, foreign].map((who, i) => ({ _id: new mongoose.Types.ObjectId(who.accountId),
    email: `synthetic-${i}@example.invalid`, password: 'unused', __v: 0, subProfiles: [who.profileId, ...(i === 0 ? [sibling.profileId] : [])].map(id => ({
      _id: new mongoose.Types.ObjectId(id), name: 'Synthetic', rewards: { preserved: 5 }, progress: {}, attempts: {},
    })) })));
  await rs.db.collection('mazes').insertOne({ date, seed: 'synthetic', grid: [['S', 'X', 'F', 'E']], width: 4, height: 1 });
  now = baseTime; samples = []; health = true; epoch = 'test-epoch'; hook = async () => {};
  repo = new PlayableRepository(rs.client, rs.db, { hook: stage => hook(stage) });
  service = new PlayableService(repo, { clock, admissionEnabled: true });
  const app = express(); app.use('/api/v2', createPlayableRouter({ service, secret, enabled: true }));
  server = await listen(app); base = `http://127.0.0.1:${server.address().port}/api/v2`;
});
afterEach(async () => {
  await rs.failOff(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  for (const child of children) { if (child.exitCode === null && child.signalCode === null) { const done = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await done; } }
  children = [];
});

test('startup defaults OFF with zero routes/DB access and refuses accidental activation', async () => {
  let mounts = 0; const app = { use: () => mounts++ };
  assert.deepEqual(installPlayableRuntime(app, { env: {} }), { mounted: false, enabled: false });
  assert.equal(mounts, 0); assert.ok(RELEASE_BLOCKERS.includes('all-writer-ledger-not-integrated'));
  assert.throws(() => installPlayableRuntime(app, { env: { FC_SESSION_V2_ENABLED: 'true' } }), /ACTIVATION_BLOCKED/);
  const off = express(); off.use('/api/v2', createPlayableRouter({ enabled: false, service: new Proxy({}, {
    get: () => assert.fail('disabled router accessed service'),
  }) }));
  const listener = await listen(off);
  try { assert.equal((await fetch(`http://127.0.0.1:${listener.address().port}/api/v2/capabilities`)).status, 404); }
  finally { await new Promise(resolve => listener.close(resolve)); }
  assert.ok(Object.values(await totals()).every(n => n === 0));
});
test('real Express JWT, ownership, negotiation, exact date/schema and revision errors', async () => {
  assert.equal((await request('/capabilities', undefined, { token: 'invalid' })).status, 401);
  assert.equal((await request('/capabilities')).body.protocol, 'session-v2');
  for (const body of [{ date: '2025-02-30', createKey: 'create-key' }, { date, createKey: 'create-key', time: 0 },
    { date, createKey: '__bad' }, { date, createKey: 'create-key', subProfileId: foreign.profileId }]) {
    assert.ok([400, 404].includes((await request('/sessions', body)).status));
  }
  assert.equal((await request('/sessions', { date, createKey: 'create-key' }, { headers: { 'X-Fort-Custer-Protocol': '' } })).status, 426);
  const s = await create();
  const ready = { key: 'ready-key', nonce: s.nonce, gridHash: s.gridHash, rulesVersion: s.manifest.rulesVersion };
  assert.equal((await request(`/sessions/${s.attemptId}/ready`, ready)).status, 428);
  assert.equal((await request(`/sessions/${s.attemptId}/ready`, ready, { ifMatch: 99 })).status, 409);
  assert.equal((await request(`/sessions/${s.attemptId}/ready`, ready, { headers: { 'If-Match': '"2' } })).status, 400);
  assert.equal((await request(`/sessions/${s.attemptId}/status?subProfileId=${foreign.profileId}`, undefined, { who: foreign })).status, 404);
  assert.equal((await totals()).intents, 0);
});
test('slot and account-level create keys serialize across subprofiles; manifest stays pinned', async () => {
  const s = await create();
  assert.equal((await request('/sessions', { date, createKey: 'create-key' }, { who: sibling })).status, 409);
  assert.equal((await request('/sessions', { date, createKey: 'new-key-1' })).status, 409);
  await rs.db.collection('mazes').updateOne({ date }, { $set: { grid: [['S', 'E']] } });
  assert.deepEqual(await create(), s);
  assert.equal(s.manifest.runClass, 'standard'); assert.deepEqual(s.manifest.abilityIds, []);
});
test('ready replay at deadline -1/0/+1 preserves trusted start and expires only the old slot', async () => {
  const s = await started(), stored = await repo.c('sessions').findOne({ _id: s.attemptId });
  const payload = { key: 'ready-key', nonce: stored.nonce, gridHash: s.gridHash, rulesVersion: s.manifest.rulesVersion };
  for (const offset of [-1, 0, 1]) {
    now = s.expiresAt + offset;
    const response = await request(`/sessions/${s.attemptId}/ready`, payload);
    assert.equal(response.body.attemptId, s.attemptId); assert.equal(response.body.startedAt, baseTime + 10);
    assert.equal(response.body.state, offset < 0 ? 'STARTED' : 'EXPIRED');
  }
  const successor = await create(actor, 'successor');
  assert.notEqual(successor.attemptId, s.attemptId);
  await request(`/sessions/${s.attemptId}/ready`, payload);
  assert.equal((await repo.c('slots').findOne(actor)).attemptId, successor.attemptId);
});
test('create replay preparation expiry is effective and never reallocates the original ID', async () => {
  const s = await create();
  for (const offset of [-1, 0, 1]) {
    now = s.expiresAt + offset; const replay = await create();
    assert.equal(replay.state, offset < 0 ? 'PREPARED' : 'EXPIRED'); assert.equal(replay.attemptId, s.attemptId);
  }
});
test('legal route accepted with server-only continuous time, private immutable receipt and one date chance', async () => {
  await repo.c('dateHistory').insertOne({ ...actor, date, state: 'known-clear', evidenceRef: 'synthetic-authorized-evidence' });
  const s = await started(); now = baseTime + 30;
  const result = await complete(s);
  assert.equal(result.status, 200); assert.deepEqual(result.body.timing, { status: 'official', elapsedMs: 20, reason: null });
  assert.equal(result.body.collectible.status, 'pending');
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const stored = await repo.c('results').findOne({ attemptId: s.attemptId });
  assert.equal(stored.receipt.at, baseTime + 30); assert.equal(stored.startClock.at, baseTime + 10);
  for (const privateField of ['transcriptHash', 'guardChecks', 'receipt', 'accountId', 'profileId', 'manifestHash']) assert.equal(result.body[privateField], undefined);
  now += 999; assert.deepEqual((await complete(s)).body, result.body);
  const next = await started(actor, 'second-create'); now = baseTime + 50;
  assert.equal((await complete(next, 'second-completion')).status, 200);
  assert.equal(await repo.c('dateLedger').countDocuments(), 1);
  assert.equal(await repo.c('outbox').countDocuments({ type: 'date-grant-requested' }), 1);
  assert.equal((await repo.c('dateLedger').findOne()).firstResultId, stored._id);
  assert.deepEqual((await rs.db.collection('users').findOne({ _id: new mongoose.Types.ObjectId(actor.accountId) })).subProfiles[0].rewards, { preserved: 5 });
  await assertFinal(s);
});
test('D5 unhealthy or incomparable timing still accepts valid untimed progress and the same date opportunity', async () => {
  await repo.c('dateHistory').insertOne({ ...actor, date, state: 'known-clear', evidenceRef: 'synthetic-evidence' });
  const s = await started(); now = baseTime + 30; health = false; epoch = 'changed-epoch';
  const result = await complete(s);
  assert.equal(result.status, 200); assert.equal(result.body.progress.completed, true);
  assert.equal(result.body.timing.status, 'untimed'); assert.equal(result.body.timing.elapsedMs, null);
  assert.equal(result.body.collectible.status, 'pending'); assert.equal(result.body.integrity.label, 'Route validated · untimed');
  assert.equal(await repo.c('outbox').countDocuments({ type: 'date-grant-requested' }), 1); await assertFinal(s);
});
test('D6 missing legacy evidence holds entitlement without erasing accepted exploration or inventing inventory', async () => {
  const s = await started(); now += 20; const result = await complete(s);
  assert.equal(result.body.collectible.status, 'review-required'); assert.equal(result.body.progress.completed, true);
  assert.equal((await repo.c('dateLedger').findOne()).state, 'legacy-held');
  assert.equal(await repo.c('outbox').countDocuments({ type: 'date-grant-requested' }), 0); await assertFinal(s);
});
for (const [name, transcript, expected] of [['wall/unfinished', route(['left']), 422], ['post-goal', route(['right','right','right','right','left']), 422],
  ['sequence', { version: 'route-transcript-v1', commands: [{ seq: 2, dir: 'right' }] }, 400],
  ['caller time', { ...proof, elapsedMs: 1 }, 400], ['oversize commands', route(Array(65537).fill('right')), 413]]) {
  test(`rejected ${name} submission leaves no result, intent, claim, transcript or outbox`, async () => {
    const s = await started(); now += 20; const result = await complete(s, 'complete-key', transcript);
    assert.equal(result.status, expected, JSON.stringify(result.body));
    const count = await totals(); for (const name of ['results', 'intents', 'dateLedger', 'progress', 'transcripts', 'outbox']) assert.equal(count[name], 0);
  });
}
test('ownership is checked before expensive transcript work and invalid version fails fresh writes', async () => {
  const s = await started();
  const response = await complete(s, 'complete-key', null, { who: foreign });
  assert.equal(response.status, 404);
  await rs.db.collection('users').updateOne({ _id: new mongoose.Types.ObjectId(actor.accountId) }, { $unset: { __v: '' } });
  assert.equal((await complete(s)).body.error, 'PROFILE_VERSION_REQUIRED'); assert.equal((await totals()).results, 0);
});
test('completed key aliases bind across profiles and changed transcript conflicts after completion', async () => {
  const s = await started(); now += 20; const winner = await complete(s);
  assert.deepEqual((await complete(s, 'alias-key')).body, winner.body);
  assert.equal((await complete(s, 'other-key', route(['left', ...proof.commands.map(c=>c.dir)]))).status, 409);
  const other = await started(sibling, 'sibling-create'); now += 30;
  assert.equal((await complete(other, 'alias-key', proof, { who: sibling })).status, 409);
  await rs.db.collection('users').updateOne({ _id: new mongoose.Types.ObjectId(actor.accountId) }, { $unset: { __v: '' } });
  assert.deepEqual((await request(`/sessions/${s.attemptId}/result?subProfileId=${actor.profileId}`)).body, winner.body);
});
test('decoded byte cap, malformed JSON and compression errors are private and do not persist data', async () => {
  for (const [body, headers, expected] of [['x'.repeat(2097152 + 4097), {}, 413], ['{', {}, 400], ['{}', { 'Content-Encoding': 'gzip' }, 415]]) {
    const response = await fetch(base + '/sessions', { method: 'POST', headers: { Authorization: `Bearer ${jwt.sign({ id: actor.accountId }, secret)}`,
      'Content-Type': 'application/json', ...headers }, body });
    assert.equal(response.status, expected); const text = await response.text(); assert.ok(!text.includes('SyntaxError')); assert.ok(!text.includes('stack'));
  }
  assert.equal((await totals()).sessions, 0);
});
test('worker operational failure and processing past guard deadline cannot award partial success', async () => {
  const s = await started(); now += 20;
  service.validator = { validate: async () => { throw new Error('private worker path'); } };
  const response = await complete(s); assert.equal(response.status, 503); assert.equal(response.body.error, 'SAVE_UNAVAILABLE');
  assert.equal((await totals()).intents, 0);
  service.validator = new RouteValidator(); samples = [s.expiresAt - 1, s.expiresAt];
  assert.equal((await complete(s)).status, 410); const count = await totals();
  assert.equal(count.results, 0); assert.equal(count.dateLedger, 0); assert.equal(count.outbox, 0);
});
test('bounded guard checks fail closed while preserving durable intake and original receipt', async () => {
  service.policy = { ...service.policy, maxClockChecks: 1 };
  const s = await started(); samples = [baseTime + 30, baseTime + 29];
  assert.equal((await complete(s)).body.error, 'CLOCK_UNAVAILABLE');
  assert.equal((await complete(s)).body.error, 'CLOCK_REVIEW_REQUIRED');
  assert.equal((await repo.c('intents').findOne()).receipt.at, baseTime + 30);
  assert.equal((await totals()).results, 0);
});
test('QA failed evidence update is timing-held across HTTP retry and database restart', async () => {
  const s = await started(); samples = [baseTime + 30, baseTime + 29];
  const pause = barrier('clock:beforeEvidence'), saving = complete(s);
  await pause.entered; await rs.fail({ failCommands: ['update'], errorCode: 2 }); pause.release();
  assert.equal((await saving).body.error, 'CLOCK_EVIDENCE_UNAVAILABLE');
  now = baseTime + 40; const winner = await complete(s);
  assert.equal(winner.body.timing.status, 'untimed');
  assert.equal((await repo.c('results').findOne()).receipt.at, baseTime + 30);
  await rs.restart(); assert.deepEqual((await service.result(actor, s.attemptId)), winner.body); await assertFinal(s);
});
test('QA delayed evidence cannot let a competing HTTP finalizer claim official timing', async () => {
  const s = await started(); samples = [baseTime + 30, baseTime + 29]; now = baseTime + 30;
  const pause = barrier('clock:beforeEvidence'), saving = complete(s); await pause.entered;
  const point = await rs.fail({ failCommands: ['update'], blockConnection: true, blockTimeMS: 1500 }); pause.release();
  await rs.client.db('admin').command({ waitForFailPoint: 'failCommand', timesEntered: point.count + 1, maxTimeMS: 5000 });
  const winner = await complete(s); assert.equal(winner.status, 200); assert.equal(winner.body.timing.status, 'untimed');
  assert.deepEqual((await saving).body, winner.body); assert.deepEqual((await repo.c('intents').findOne()).guardReversals, [baseTime + 29]);
  await rs.restart(); assert.deepEqual(await service.result(actor, s.attemptId), winner.body); await assertFinal(s);
});
test('resolver-first shared fence rejects paused HTTP finalizer and fresh retry uses later receipt', async () => {
  const s = await started(); now += 20;
  const pause = barrier('finish:read'), saving = complete(s); await pause.entered;
  const recovery = await request(`/sessions/${s.attemptId}/recover`, {}); assert.equal(recovery.body.outcome, 'aborted');
  pause.release(); assert.equal((await saving).status, 409);
  now = baseTime + 50; const winner = await complete({ ...s, revision: recovery.body.revision });
  assert.equal(winner.status, 200); assert.equal((await repo.c('results').findOne()).receipt.at, baseTime + 50); await assertFinal(s);
});
test('transient transaction retry rechecks guard and preserves original ingress receipt', async () => {
  const s = await started(); now += 20;
  const pause = barrier('finish:admitted'), saving = complete(s); await pause.entered;
  await rs.fail({ failCommands: ['insert'], errorCode: 112, errorLabels: ['TransientTransactionError'] }); pause.release();
  const result = await saving; assert.equal(result.status, 200); assert.equal((await repo.c('results').findOne()).receipt.at, baseTime + 30); await assertFinal(s);
});
test('unknown final commit recovers majority winner without a new receipt, including backwards clock', async () => {
  const s = await started(); now += 20;
  repo.commitAttempts = 1;
  const pause = barrier('finish:admitted'), saving = complete(s); await pause.entered;
  await rs.client.db('admin').command({ configureFailPoint: 'failCommand', mode: { times: 2 }, data: {
    failCommands: ['commitTransaction'], writeConcernError: { code: 64, errmsg: 'synthetic lost ACK' }, errorLabels: ['UnknownTransactionCommitResult'],
  } }); pause.release();
  assert.equal((await saving).body.error, 'COMMIT_UNKNOWN'); await rs.failOff();
  const original = await until(() => repo.c('results').findOne({ attemptId: s.attemptId }, { readConcern: { level: 'majority' } }));
  await rs.restart(); now = baseTime - 10;
  assert.deepEqual((await complete(s)).body, original.response); await assertFinal(s);
});
test('admission OFF retains ready/result recovery and pending completion without accepting new sessions', async () => {
  const s = await started(); now += 20;
  const pause = barrier('finish:admitted'), saving = complete(s); await pause.entered;
  service.admissionEnabled = false; pause.release(); assert.equal((await saving).status, 200);
  assert.equal((await request('/sessions', { date, createKey: 'new-key-2' })).body.error, 'ADMISSION_DISABLED');
  assert.equal((await request(`/sessions/${s.attemptId}/result?subProfileId=${actor.profileId}`)).status, 200);
  assert.equal((await complete(s)).status, 200);
});
test('SYS-03 boundary rejects pending validity and shares one ledger between accepted source versions', async () => {
  await repo.c('dateHistory').insertOne({ ...actor, date, state: 'known-clear', evidenceRef: 'synthetic-evidence' });
  await assert.rejects(repo.tx(session => recordAcceptedDate(repo, actor, { validity: 'pending' }, session)), { code: 'VALIDITY_REQUIRED' });
  const legacy = { ...actor, _id: 'synthetic-legacy-result', date, validity: 'accepted', validationVersion: 'legacy-compat-v1' };
  await assert.rejects(repo.tx(session => recordAcceptedDate(repo, actor, { ...legacy, profileId: foreign.profileId }, session)), { code: 'LEDGER_SCOPE' });
  await repo.tx(session => recordAcceptedDate(repo, actor, legacy, session));
  const s = await started(); now += 20; assert.equal((await complete(s)).status, 200);
  assert.equal(await repo.c('dateLedger').countDocuments(), 1);
  assert.equal(await repo.c('outbox').countDocuments({ type: 'date-grant-requested' }), 1);
  assert.equal((await repo.c('dateLedger').findOne()).firstResultId, legacy._id);
});

async function processApp(at, crash) {
  const child = fork(new URL('../tools/test-support/playable-process.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  children.push(child);
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Isolated application startup timed out')), 10000);
    child.once('message', value => { clearTimeout(timer); resolve(value.port); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Isolated application exited')); });
    child.send({ uri: rs.uri, secret, at, crash });
  });
  return `http://127.0.0.1:${port}/api/v2`;
}
for (const stage of ['finish:admitted', 'finish:committed']) test(`real application process crash at ${stage} recovers original intent/result after DB restart`, async () => {
  const s = await started(); const childBase = await processApp(baseTime + 30, stage);
  await assert.rejects(complete(s, 'complete-key', proof, { url: childBase }));
  await rs.restart();
  const recoveredBase = await processApp(baseTime + 100);
  const response = await complete(s, 'complete-key', proof, { url: recoveredBase });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const saved = await repo.c('results').findOne({ attemptId: s.attemptId });
  assert.equal(saved.receipt.at, baseTime + 30);
  assert.equal(response.body.timing.status, stage === 'finish:admitted' ? 'untimed' : 'official');
  await assertFinal(s);
});

test('abandon operation scope preserves idempotency and releases the slot without restarting time', async () => {
  const s = await started(); now += 10;
  const payload = { key: 'abandon-key', reason: 'restart' };
  const abandoned = await request(`/sessions/${s.attemptId}/abandon`, payload, { ifMatch: s.revision });
  assert.equal(abandoned.body.state, 'ABANDONED');
  assert.deepEqual((await request(`/sessions/${s.attemptId}/abandon`, payload)).body, abandoned.body);
  assert.equal((await request(`/sessions/${s.attemptId}/abandon`, { ...payload, reason: 'user-choice' })).status, 409);
  const next = await started(actor, 'next-create'); now += 10;
  assert.equal((await request(`/sessions/${next.attemptId}/abandon`, payload, { ifMatch: next.revision })).status, 200);
  assert.equal((await totals()).slots, 0);
});
test('pending completion stays resolving after expiry and blocks abandon until a fenced recovery', async () => {
  const s = await started(); now += 20;
  const pause = barrier('finish:admitted'), saving = complete(s); await pause.entered;
  now = s.expiresAt;
  const status = await request(`/sessions/${s.attemptId}/status?subProfileId=${actor.profileId}`);
  assert.equal(status.body.state, 'STARTED'); assert.equal(status.body.saveStatus, 'resolving');
  assert.equal((await request(`/sessions/${s.attemptId}/abandon`, { key: 'abandon-key', reason: 'restart' }, { ifMatch: s.revision })).body.error, 'COMMIT_UNKNOWN');
  pause.release(); assert.equal((await saving).status, 410);
  const recovery = await request(`/sessions/${s.attemptId}/recover`, {}); assert.equal(recovery.body.outcome, 'aborted');
  assert.equal((await request(`/sessions/${s.attemptId}/status?subProfileId=${actor.profileId}`)).body.state, 'EXPIRED');
  assert.equal((await totals()).slots, 0);
});
test('failure after final result insert rolls back date ledger/progress/outbox as one receipt boundary', async () => {
  await repo.c('dateHistory').insertOne({ ...actor, date, state: 'known-clear', evidenceRef: 'synthetic-evidence' });
  const s = await started(); now += 20;
  let once = false; hook = async stage => { if (stage === 'finish:result' && !once) { once = true; throw new Error('synthetic final boundary failure'); } };
  assert.equal((await complete(s)).status, 503);
  const count = await totals();
  for (const name of ['results', 'dateLedger', 'progress', 'outbox']) assert.equal(count[name], 0);
  assert.equal((await repo.c('sessions').findOne({ _id: s.attemptId })).state, 'STARTED');
  now += 10; const result = await complete(s); assert.equal(result.status, 200); assert.equal(result.body.timing.status, 'untimed');
  assert.equal((await repo.c('results').findOne()).receipt.at, baseTime + 30); await assertFinal(s);
});
for (const state of ['awarded', 'exhausted']) test(`known ${state} legacy date never creates another collectible opportunity`, async () => {
  await repo.c('dateHistory').insertOne({ ...actor, date, state, evidenceRef: 'synthetic-reviewed-evidence' });
  const s = await started(); now += 20; const result = await complete(s);
  assert.equal(result.status, 200); assert.equal(result.body.progress.completed, true);
  assert.equal(result.body.collectible.status, state === 'awarded' ? 'already-used' : 'exhausted');
  assert.equal(await repo.c('outbox').countDocuments({ type: 'date-grant-requested' }), 0);
  assert.deepEqual((await rs.db.collection('users').findOne({ _id: new mongoose.Types.ObjectId(actor.accountId) })).subProfiles[0].rewards, { preserved: 5 });
});
test('default unmonitored server clock cannot certify official timing', async () => {
  now = Date.now(); const prepared = await create(); now = Date.now();
  const ready = await request(`/sessions/${prepared.attemptId}/ready`, { key: 'ready-key', nonce: prepared.nonce,
    gridHash: prepared.gridHash, rulesVersion: prepared.manifest.rulesVersion }, { ifMatch: prepared.revision });
  // The draft prepare deadline must cover this test's real clock sample.
  if (ready.status !== 200) assert.fail(JSON.stringify(ready.body));
  const s = ready.body;
  const unmonitored = new PlayableService(repo, { admissionEnabled: true });
  const result = await unmonitored.complete(actor, s.attemptId, 'complete-key', proof, s.revision);
  assert.equal(result.timing.status, 'untimed'); assert.equal(result.progress.completed, true);
});
test('profile deletion racing a finalizer fences all accepted-date and result effects', async () => {
  const s = await started(); now += 20;
  const pause = barrier('finish:read'), saving = complete(s); await pause.entered;
  await rs.db.collection('users').updateOne({ _id: new mongoose.Types.ObjectId(actor.accountId) }, {
    $pull: { subProfiles: { _id: new mongoose.Types.ObjectId(actor.profileId) } }, $inc: { __v: 1 },
  });
  pause.release(); assert.equal((await saving).status, 404);
  const count = await totals(); for (const name of ['results', 'dateLedger', 'progress', 'outbox']) assert.equal(count[name], 0);
});
test('partial upload has an absolute body deadline and releases ingress capacity without writes', async () => {
  const app = express(); app.use(createPlayableRouter({ service, secret, enabled: true, bodyTimeoutMs: 30 }));
  const listener = await listen(app);
  try {
    await new Promise((resolve, reject) => {
      const upload = http.request({ host: '127.0.0.1', port: listener.address().port, path: '/sessions', method: 'POST',
        headers: { Authorization: `Bearer ${jwt.sign({ id: actor.accountId }, secret)}`, 'Content-Type': 'application/json', 'Content-Length': 1000 } });
      const timer = setTimeout(() => { upload.destroy(); reject(new Error('Body deadline did not close upload')); }, 2000);
      upload.once('error', () => { clearTimeout(timer); resolve(); });
      upload.write('{');
    });
    assert.equal((await totals()).sessions, 0);
  } finally { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
});
test('invalid pinned grid and worker timeout do not manufacture an accepted receipt', async () => {
  await rs.db.collection('mazes').updateOne({ date }, { $set: { grid: [['S', '?', 'E']] } });
  assert.equal((await request('/sessions', { date, createKey: 'create-key' })).status, 503);
  assert.equal((await totals()).sessions, 0);
  await rs.db.collection('mazes').updateOne({ date }, { $set: { grid: [['S', 'X', 'F', 'E']] } });
  const s = await started(); now += 20; service.validator = new RouteValidator({ timeoutMs: 1 });
  const result = await complete(s); assert.equal(result.status, 503); assert.ok(['VALIDATION_TIMEOUT', 'VALIDATION_UNAVAILABLE'].includes(result.body.error));
  assert.equal((await totals()).intents, 0);
});
test('saved completion and effective terminal replays survive a later clock-provider outage', async () => {
  const s = await started(), stored = await repo.c('sessions').findOne({ _id: s.attemptId }); now += 20;
  const winner = await complete(s); assert.equal(winner.status, 200);
  service.clock = { sample: () => { throw new Error('synthetic monitor outage'); } };
  assert.deepEqual((await complete(s)).body, winner.body);
  assert.deepEqual((await request(`/sessions/${s.attemptId}/result?subProfileId=${actor.profileId}`)).body, winner.body);
  assert.equal((await create()).state, 'COMPLETED');
  assert.equal((await request(`/sessions/${s.attemptId}/ready`, { key: 'ready-key', nonce: stored.nonce,
    gridHash: s.gridHash, rulesVersion: s.manifest.rulesVersion })).body.state, 'COMPLETED');
  assert.equal((await request(`/sessions/${s.attemptId}/status?subProfileId=${actor.profileId}`)).body.state, 'COMPLETED');
});
