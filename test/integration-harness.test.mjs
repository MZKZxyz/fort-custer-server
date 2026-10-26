import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fork } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { spawnIntegration } from '../tools/integration/client.mjs';
import { validateOptions } from '../tools/integration/launch.mjs';
import { buildContract, normalizeResponse } from '../tools/integration/contract.mjs';
import { date, alternateDate, transcript, shortTranscript, grid } from '../tools/integration/fixtures.mjs';
import { hash } from '../services/playable/repository.js';
import { replayTranscript } from '../services/playable/transcript.js';
import { installPlayableRuntime } from '../services/playable/runtime.js';

let env, who, contract;
const clientOrigin = 'http://127.0.0.1:5173';
before(async () => {
  contract = JSON.parse(await readFile(new URL('../docs/integration/session-v2.contract.json', import.meta.url)));
  env = await spawnIntegration({ workers: 2, clientOrigins: [clientOrigin] });
}, { timeout: 50000 });
after(async () => { await env?.close(); });
beforeEach(async () => { who = await env.bootstrap(); });
async function request(path, body, { actor = who, worker = 0, revision, headers = {}, method, raw } = {}) {
  const response = await fetch(env.metadata.origins[worker] + path, { method: method ?? (body === undefined && raw === undefined ? 'GET' : 'POST'),
    headers: { Authorization: `Bearer ${actor.token}`, 'Content-Type': 'application/json',
      'X-Fort-Custer-Protocol': 'session-v2', 'X-Fort-Custer-Capabilities': 'route-transcript-v1',
      ...(revision === undefined ? {} : { 'If-Match': `"${revision}"` }), ...headers },
    ...((body === undefined && raw === undefined) ? {} : { body: raw ?? JSON.stringify({ subProfileId: actor.subProfileId, ...body }) }) });
  const text = await response.text();
  return { status: response.status, body: text ? response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(text) : text : null,
    headers: response.headers };
}
const api = (path, body, options) => request('/api/v2' + path, body, options);
async function create(key = 'create-case-0001', selectedDate = date, options) {
  const response = await api('/sessions', { date: selectedDate, createKey: key }, options);
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
}
const readyBody = s => ({ key: 'ready-case-0001', nonce: s.nonce, gridHash: s.gridHash, rulesVersion: s.manifest.rulesVersion });
async function ready(s, options = {}) {
  const response = await api(`/sessions/${s.attemptId}/ready`, readyBody(s), { revision: s.revision, ...options });
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
}
const complete = (s, options = {}, proof = transcript, key = 'complete-case-0001') => api(`/sessions/${s.attemptId}/complete`,
  { completionKey: key, transcript: proof }, { revision: s.revision, ...options });
const status = (s, options = {}) => api(`/sessions/${s.attemptId}/status?subProfileId=${(options.actor ?? who).subProfileId}`, undefined, options);
const result = (s, options = {}) => api(`/sessions/${s.attemptId}/result?subProfileId=${(options.actor ?? who).subProfileId}`, undefined, options);
const recover = (s, options = {}) => api(`/sessions/${s.attemptId}/recover`, {}, options);
const snapshot = () => env.control('snapshot');
const owned = (rows, actor = who) => rows.filter(row => row.accountId === actor.accountId && row.profileId === actor.subProfileId);
async function noFinals(s) {
  const state = await snapshot();
  for (const name of ['results', 'legacyReceipts', 'dateHistory', 'dateLedger', 'grants', 'progress']) assert.equal(owned(state.collections[name]).length, 0, name);
  const sub = state.users.find(u => u._id === who.accountId).subProfiles.find(p => p._id === who.subProfileId);
  assert.deepEqual(sub.rewards, {}); assert.deepEqual(sub.progress, {});
  const grantId = `date:${hash({ accountId: who.accountId, profileId: who.subProfileId, date })}`;
  assert.equal(state.collections.outbox.filter(event => [grantId, `settled:${grantId}`, `result:${s.attemptId}`].includes(event._id)).length, 0);
  return state;
}
async function settled(s, receipt) {
  const state = await snapshot(), c = state.collections;
  const saved = c.sessions.find(row => row._id === s.attemptId), stored = c.results.find(row => row.attemptId === s.attemptId);
  assert.equal(saved.state, 'COMPLETED'); assert.equal(saved.pending, undefined); assert.deepEqual(stored.response, receipt);
  assert.equal(stored.timing.status, 'untimed'); assert.equal(stored.timing.elapsedMs, null);
  assert.equal(owned(c.results).filter(row => row.attemptId === s.attemptId).length, 1);
  assert.equal(c.intents.find(row => row._id === stored.intentId).state, 'completed');
  assert.equal(c.slots.filter(row => row.attemptId === s.attemptId).length, 0);
  assert.equal(c.keys.filter(row => row.attemptId === s.attemptId && row.operation === 'complete').every(row => row.state === 'completed'), true);
  const ledger = owned(c.dateLedger).find(row => row.date === s.date), grant = c.grants.find(row => row._id === ledger.grantId);
  assert.equal(ledger.state, receipt.collectible.status === 'awarded' ? 'consumed' : 'exhausted');
  assert.equal(owned(c.grants).filter(row => row.date === s.date).length, 1);
  assert.equal(owned(c.progress).find(row => row.date === s.date).completed, true);
  const sub = state.users.find(u => u._id === who.accountId).subProfiles.find(p => p._id === who.subProfileId);
  assert.deepEqual(sub.rewards, { 'integration-compass': 1 });
  assert.equal(c.outbox.find(event => event._id === grant._id).state, 'settled');
  assert.equal(c.outbox.filter(event => event._id === `settled:${grant._id}`).length, 1);
  assert.equal(c.outbox.filter(event => event._id === stored._id && event.type === 'receipt-accepted').length, 1);
  assert.equal((await env.control('majority-result', { attemptId: s.attemptId })).present, true);
  return stored;
}
async function fault(stage, action, path, worker = 0) { await env.control('fault', { stage, action, path: '/api/v2' + path, worker }); }
async function waitHit(worker = 0) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if ((await env.control('fault-status', { worker })).hit) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Synthetic fault was not reached');
}

test('frozen contract pins actual source, fixture hashes and canonical stationary fire semantics', async () => {
  assert.deepEqual(await buildContract(), contract);
  assert.equal(env.metadata.fixture.fixtureHash, contract.fixture.fixtureHash);
  assert.equal(hash(grid), contract.fixture.gridHash);
  const replay = replayTranscript(grid, contract.responses.prepared.manifest, transcript);
  for (const [key, value] of Object.entries(contract.fixture.replay)) assert.deepEqual(replay[key], value);
});
test('launcher metadata is credential-free and bootstrap uses authenticated registration, login and trusted profile birth', async () => {
  const json = JSON.stringify(env.metadata);
  assert.doesNotMatch(json, /token|password|secret|mongodb:|dbpath|\/workspace|\/home|pid/i);
  const state = await snapshot(), origin = owned(state.collections.profileOrigins)[0];
  assert.equal(origin.epochId, 'synthetic-integration-only-v1'); assert.ok(origin.birthRevision > 0);
  const epoch = state.collections.writerEpochs.find(row => row._id === origin.epochId);
  assert.ok(epoch.revision >= origin.birthRevision); assert.equal(epoch.evidenceRef, 'synthetic-owned-database-only');
  assert.equal((await api('/capabilities')).status, 200);
  assert.equal((await api('/capabilities', undefined, { headers: { Authorization: 'Bearer invalid' } })).status, 401);
});
test('real lifecycle responses match frozen examples and untimed accepted progress saves one immutable collectible', async () => {
  const caps = await api('/capabilities'); assert.deepEqual(caps.body, contract.responses.capabilities);
  assert.equal(caps.headers.get('Cache-Control'), 'no-store');
  const prepared = await create(); assert.deepEqual(normalizeResponse(prepared), contract.responses.prepared);
  assert.equal(prepared.startedAt, null);
  const started = await ready(prepared); assert.deepEqual(normalizeResponse(started), contract.responses.started);
  assert.equal(started.expiresAt - started.startedAt, contract.policy.playMs);
  assert.deepEqual((await status(started)).body, started);
  const receipt = await complete(started); assert.equal(receipt.status, 200);
  assert.deepEqual(normalizeResponse(receipt.body), contract.responses.receipt);
  assert.deepEqual(normalizeResponse((await status(started)).body), contract.responses.completedStatus);
  assert.deepEqual((await result(started)).body, receipt.body); assert.deepEqual((await recover(started)).body, receipt.body);
  assert.deepEqual((await complete(started)).body, receipt.body);
  assert.deepEqual(Object.keys(receipt.body), contract.publicResultFields);
  await settled(started, receipt.body);
});
test('create ACK loss and application restart replay original key, attempt, nonce and prepare deadline', async () => {
  await fault('afterCommit', 'drop', '/sessions');
  await assert.rejects(api('/sessions', { date, createKey: 'create-case-0001' }));
  const state = await snapshot(), original = owned(state.collections.sessions)[0];
  assert.equal(owned(state.collections.sessions).length, 1);
  await env.control('restart-app');
  const replay = await create(); assert.equal(replay.attemptId, original._id);
  assert.equal(replay.nonce, original.nonce); assert.equal(replay.expiresAt, original.deadline); assert.equal(replay.startedAt, null);
  await noFinals(replay);
});
test('ready ACK loss never restarts the trusted clock; reload status and original payload recover STARTED', async () => {
  const prepared = await create(); await fault('afterCommit', 'drop', `/sessions/${prepared.attemptId}/ready`);
  await assert.rejects(api(`/sessions/${prepared.attemptId}/ready`, readyBody(prepared), { revision: prepared.revision }));
  const original = (await status(prepared)).body;
  await env.control('restart-app');
  const replay = await ready(prepared); assert.deepEqual(replay, original);
  assert.equal(replay.startedAt + contract.policy.playMs, replay.expiresAt);
  assert.equal((await create()).startedAt, original.startedAt);
  const receipt = await complete(replay); assert.equal(receipt.status, 200); await settled(replay, receipt.body);
});
test('final ACK loss, MongoDB SIGKILL and fresh application recover exact receipt without a second award', async () => {
  const s = await ready(await create()); await fault('finish:committed', 'drop', `/sessions/${s.attemptId}/complete`);
  await assert.rejects(complete(s));
  const original = (await result(s)).body; await settled(s, original);
  await env.control('restart-mongo'); await env.control('restart-app');
  assert.deepEqual((await result(s)).body, original); assert.deepEqual((await recover(s)).body, original);
  assert.deepEqual((await complete(s)).body, original); await settled(s, original);
});
test('worker SIGKILL after durable intake leaves resolving status and resumes original receipt on the other worker', async () => {
  const s = await ready(await create()); await fault('finish:admitted', 'crash', `/sessions/${s.attemptId}/complete`);
  await assert.rejects(complete(s));
  const state = await noFinals(s), intent = owned(state.collections.intents)[0]; assert.equal(intent.state, 'pending');
  const resolving = await status(s, { worker: 1 }); assert.equal(resolving.body.saveStatus, 'resolving');
  assert.deepEqual(normalizeResponse(resolving.body), contract.responses.resolvingStatus);
  assert.equal((await result(s, { worker: 1 })).body.error, 'COMMIT_UNKNOWN');
  await env.control('restart-app');
  const receipt = await complete(s, { worker: 1 }); assert.equal(receipt.status, 200);
  const stored = await settled(s, receipt.body); assert.deepEqual(stored.receipt, intent.receipt);
  await env.control('restart-mongo'); assert.deepEqual((await recover(s)).body, receipt.body);
});
test('recover transaction fences a paused finalizer; original key retries only with fresh revision and a new generation', async () => {
  const s = await ready(await create()); await fault('finish:admitted', 'pause', `/sessions/${s.attemptId}/complete`);
  const saving = complete(s); await waitHit();
  const aborted = await recover(s, { worker: 1 }); assert.deepEqual(aborted.body, contract.responses.receiptOrRecovery.aborted);
  await env.control('release'); assert.equal((await saving).status, 409);
  await noFinals(s);
  const current = (await status(s)).body, winner = await complete(current); assert.equal(winner.status, 200);
  const stored = await settled(s, winner.body);
  assert.equal((await snapshot()).collections.intents.find(row => row._id === stored.intentId).generation, 2);
});
test('failed atomic grant write preserves intake and no final effects; same operation repairs across restart', async () => {
  const s = await ready(await create()); await fault('grant:inventory', 'fail', `/sessions/${s.attemptId}/complete`);
  const failed = await complete(s); assert.equal(failed.status, 503); assert.equal(failed.body.error, 'SAVE_UNAVAILABLE');
  const state = await noFinals(s), original = owned(state.collections.intents)[0];
  await env.control('restart-mongo'); await env.control('restart-app');
  const winner = await complete(s); assert.equal(winner.status, 200);
  assert.deepEqual((await settled(s, winner.body)).receipt, original.receipt);
});
test('malformed catalog cannot consume date; explicit synthetic repair and same-operation retry settle once', async () => {
  const s = await ready(await create()); await env.control('invalidate-catalog');
  try {
    const failed = await complete(s); assert.equal(failed.status, 503); assert.equal(failed.body.error, 'CATALOG_REVIEW_REQUIRED');
    const pending = owned((await noFinals(s)).collections.intents)[0];
    await env.control('repair-catalog');
    const winner = await complete(s); assert.equal(winner.status, 200);
    assert.deepEqual((await settled(s, winner.body)).receipt, pending.receipt);
    await env.control('restart-mongo'); assert.deepEqual((await result(s)).body, winner.body);
  } finally { await env.control('repair-catalog'); }
});
test('two tabs in independent app processes replay create and ready and share one completion winner', async () => {
  const created = await Promise.all([create(), create('create-case-0001', date, { worker: 1 })]);
  assert.equal(created[0].attemptId, created[1].attemptId);
  const starts = await Promise.all([ready(created[0]), ready(created[1], { worker: 1 })]); assert.deepEqual(starts[0], starts[1]);
  const receipts = await Promise.all([complete(starts[0]), complete(starts[1], { worker: 1 }, transcript, 'complete-tab-0002')]);
  for (const response of receipts) assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(receipts[0].body, receipts[1].body); await settled(starts[0], receipts[0].body);
});
test('actual authenticated legacy/v2 same-date contention shares one immutable award and inventory credit', async () => {
  const legacy = await request('/api/maze/start', { date }); assert.equal(legacy.status, 200);
  const s = await ready(await create());
  await new Promise(resolve => setTimeout(resolve, 3100)); // Preserve the real legacy 3s floor and receipt.
  const [old, modern] = await Promise.all([request('/api/maze/complete', { date, attemptId: legacy.body.attemptId }), complete(s, { worker: 1 })]);
  assert.equal(old.status, 200, JSON.stringify(old.body)); assert.equal(modern.status, 200, JSON.stringify(modern.body));
  assert.equal(old.body.reward.id, modern.body.collectible.reward.id);
  assert.deepEqual((await request('/api/maze/complete', { date, attemptId: legacy.body.attemptId })).body, old.body);
  await settled(s, modern.body);
  const state = await snapshot(); assert.equal(owned(state.collections.legacyReceipts).length, 1);
  await env.control('restart-mongo'); assert.deepEqual((await result(s)).body, modern.body);
});
test('another same-date route cannot reroll; a different exhausted date stays null after recovery', async () => {
  const first = await ready(await create()), winner = await complete(first); assert.equal(winner.status, 200);
  const repeat = await ready(await create('create-case-0002'));
  const again = await complete(repeat, {}, shortTranscript, 'complete-case-0002'); assert.equal(again.status, 200);
  assert.deepEqual(again.body.collectible, winner.body.collectible); await settled(repeat, again.body);
  const next = await ready(await create('create-case-0003', alternateDate));
  const empty = await complete(next, {}, transcript, 'complete-case-0003'); assert.equal(empty.status, 200);
  assert.equal(empty.body.collectible.status, 'exhausted'); assert.equal(empty.body.collectible.reward, null);
  assert.deepEqual(normalizeResponse(empty.body), contract.responses.exhaustedReceipt);
  assert.equal(empty.body.collectible.collectionComplete, true); await settled(next, empty.body);
  await env.control('restart-mongo'); assert.deepEqual((await recover(next)).body, empty.body);
});

for (const [label, proof, code, expectedStatus] of [
  ['wrong transcript version', { ...transcript, version: 'client-made-up' }, 'TRANSCRIPT_SCHEMA', 400],
  ['noncontiguous sequence', { ...transcript, commands: [{ seq: 2, dir: 'right' }] }, 'TRANSCRIPT_ORDER_OR_COMMAND', 400],
  ['client positions', { ...transcript, position: [1, 4] }, 'TRANSCRIPT_SCHEMA', 400],
  ['unknown direction', { ...transcript, commands: [{ seq: 1, dir: 'north' }] }, 'TRANSCRIPT_ORDER_OR_COMMAND', 400],
  ['premature tipi', { ...shortTranscript, commands: shortTranscript.commands.slice(0, 3) }, 'TRANSCRIPT_INCOMPLETE', 422],
  ['post-tipi command', { ...shortTranscript, commands: [...shortTranscript.commands, { seq: 5, dir: 'left' }] }, 'TRANSCRIPT_AFTER_GOAL', 422],
]) test(`real route rejects ${label} without intake or final effects`, async () => {
  const s = await ready(await create()), response = await complete(s, {}, proof);
  assert.equal(response.status, expectedStatus); assert.deepEqual(response.body, { error: code });
  assert.equal(owned((await noFinals(s)).collections.intents).length, 0);
});
for (const [field, value] of [['rulesVersion', 'unsupported-rules'], ['gridHash', 'a'.repeat(64)]]) {
  test(`ready rejects mismatched ${field} without starting or awarding`, async () => {
    const s = await create(), response = await api(`/sessions/${s.attemptId}/ready`, { ...readyBody(s), [field]: value }, { revision: s.revision });
    assert.equal(response.status, 409); assert.equal(response.body.error, 'READY_BINDING');
    assert.equal((await status(s)).body.startedAt, null); await noFinals(s);
  });
}
test('fresh mutations require If-Match; changed keys and payloads cannot silently create replacement attempts', async () => {
  const s = await create();
  assert.equal((await api(`/sessions/${s.attemptId}/ready`, readyBody(s))).status, 428);
  assert.equal((await api(`/sessions/${s.attemptId}/ready`, readyBody(s), { revision: 8 })).body.error, 'SESSION_CHANGED');
  assert.equal((await api('/sessions', { date: alternateDate, createKey: 'create-case-0001' })).body.error, 'KEY_CONFLICT');
  assert.equal((await api('/sessions', { date, createKey: 'different-create' })).body.error, 'ACTIVE_SESSION');
  const started = await ready(s), first = await complete(started); assert.equal(first.status, 200);
  assert.equal((await complete(started, {}, shortTranscript)).body.error, 'KEY_CONFLICT'); await settled(started, first.body);
});
test('a valid route sent before ready is not a completion and recovery returns exact no-pending session', async () => {
  const s = await create(); assert.equal((await complete(s)).body.error, 'SESSION_TERMINAL');
  assert.deepEqual((await recover(s)).body, { outcome: 'no-pending', session: s }); await noFinals(s);
});
test('foreign account/profile cannot ready, submit, read or recover another attempt', async () => {
  const s = await ready(await create()), foreign = await env.bootstrap();
  for (const response of [await readyForeign(), await complete(s, { actor: foreign }), await status(s, { actor: foreign }),
    await result(s, { actor: foreign }), await recover(s, { actor: foreign })]) assert.equal(response.status, 404);
  async function readyForeign() { return api(`/sessions/${s.attemptId}/ready`, { key: 'foreign-ready-01', nonce: crypto.randomUUID(),
    gridHash: s.gridHash, rulesVersion: s.manifest.rulesVersion }, { actor: foreign, revision: s.revision }); }
  await noFinals(s);
});
for (const offset of [-1, 0, 1]) test(`prepare deadline ${offset}ms keeps identity and enforces durable ready boundary`, async () => {
  const s = await create(); await env.control('clock', { at: s.expiresAt + offset });
  try {
    const response = await api(`/sessions/${s.attemptId}/ready`, readyBody(s), { revision: s.revision });
    assert.equal(response.status, offset < 0 ? 200 : 410);
    const replay = await create(); assert.equal(replay.attemptId, s.attemptId);
    assert.equal(replay.state, offset < 0 ? 'STARTED' : 'EXPIRED');
    if (offset < 0) assert.equal(replay.startedAt, s.expiresAt - 1); else assert.equal(replay.startedAt, null);
    await noFinals(s);
  } finally { await env.control('clock', { at: null }); }
});
for (const offset of [-1, 0, 1]) test(`play deadline ${offset}ms accepts only a pre-deadline receipt and guard`, async () => {
  const s = await ready(await create()); await env.control('clock', { at: s.expiresAt + offset });
  try {
    const response = await complete(s); assert.equal(response.status, offset < 0 ? 200 : 410);
    if (offset < 0) await settled(s, response.body);
    else { await noFinals(s); assert.equal((await status(s)).body.state, 'EXPIRED'); }
  } finally { await env.control('clock', { at: null }); }
});
for (const phase of ['PREPARED', 'STARTED']) test(`explicit ${phase} abandonment releases slot and never grants`, async () => {
  const prepared = await create(), s = phase === 'STARTED' ? await ready(prepared) : prepared;
  const response = await api(`/sessions/${s.attemptId}/abandon`, { key: 'abandon-case-0001', reason: 'user-choice' }, { revision: s.revision });
  assert.equal(response.status, 200); assert.equal(response.body.state, 'ABANDONED');
  assert.deepEqual((await api(`/sessions/${s.attemptId}/abandon`, { key: 'abandon-case-0001', reason: 'user-choice' })).body, response.body);
  if (phase === 'STARTED') assert.deepEqual(normalizeResponse(response.body), contract.responses.abandoned);
  const state = await noFinals(s); assert.equal(owned(state.collections.slots).length, 0);
  assert.notEqual((await create('create-after-abandon')).attemptId, s.attemptId);
});
test('browser CORS preflight allows explicit localhost origin/If-Match and refuses unlisted origins', async () => {
  const preflight = await request('/api/v2/sessions', undefined, { method: 'OPTIONS', headers: { Origin: clientOrigin,
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,if-match,x-fort-custer-protocol' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), clientOrigin);
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /If-Match/);
  assert.equal((await api('/capabilities', undefined, { headers: { Origin: 'http://untrusted.example.invalid' } })).status, 403);
  assert.equal((await request('/__integration/bootstrap')).status, 404);
});
test('capability negotiation, strict schemas and bounded wire bytes fail privately', async () => {
  assert.equal((await api('/sessions', { date, createKey: 'create-case-0001' }, { headers: { 'X-Fort-Custer-Protocol': 'wrong' } })).status, 426);
  assert.equal((await api('/sessions', { date, createKey: 'short' })).body.error, 'INVALID_KEY');
  assert.equal((await api('/sessions', { date: '2025-02-30', createKey: 'create-case-0001' })).body.error, 'INVALID_DATE');
  assert.equal((await api('/sessions', { date, createKey: 'create-case-0001', extra: true })).body.error, 'REQUEST_SCHEMA');
  assert.equal((await api('/sessions', undefined, { raw: '{' })).body.error, 'REQUEST_JSON');
  const oversize = await api('/sessions', undefined, { raw: ' '.repeat(contract.limits.maxBytes + contract.policy.maxEnvelopeBytes + 1) });
  assert.equal(oversize.status, 413); assert.equal(oversize.body.error, 'REQUEST_TOO_LARGE');
  const s = await create(); await noFinals(s);
});
test('partial authenticated upload hits the real absolute ingress timeout and releases capacity', async () => {
  const origin = new URL(env.metadata.baseURL), started = Date.now();
  await new Promise((resolve, reject) => {
    const req = http.request({ hostname: origin.hostname, port: origin.port, path: '/api/v2/sessions', method: 'POST',
      headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } });
    const timer = setTimeout(() => { req.destroy(); reject(Error('Synthetic timeout exceeded')); }, 14000);
    req.on('error', () => { clearTimeout(timer); resolve(); });
    req.on('response', () => { clearTimeout(timer); reject(Error('Partial upload unexpectedly completed')); });
    req.write('{');
  });
  assert.ok(Date.now() - started >= 9000); assert.equal((await api('/capabilities')).status, 200);
  const s = await create(); await noFinals(s);
});
test('production default-OFF and explicit-enable interlock remain independent of running fixture admission', async () => {
  let mounted = 0; assert.deepEqual(installPlayableRuntime({ use: () => mounted++ }, { env: {} }), { mounted: false, enabled: false });
  assert.equal(mounted, 0);
  assert.throws(() => installPlayableRuntime({ use: () => mounted++ }, { env: { FC_SESSION_V2_ENABLED: 'true' } }), /ACTIVATION_BLOCKED/);
  assert.equal(mounted, 0); assert.equal((await api('/capabilities')).body.admission, true);
});
test('configuration parser refuses external/persistent/loopback database selectors and nonlocal origins', async () => {
  for (const value of ['mongodb://remote.example.invalid/live', 'mongodb://127.0.0.1:27017/development', '/persistent/database']) {
    assert.throws(() => validateOptions({}, { MONGO_URI: value }), /EXTERNAL_CONFIGURATION_REFUSED/);
    assert.throws(() => validateOptions({ uri: value }, {}), /EXTERNAL_CONFIGURATION_REFUSED/);
    assert.throws(() => validateOptions({ dbPath: value }, {}), /EXTERNAL_CONFIGURATION_REFUSED/);
  }
  assert.throws(() => validateOptions({ clientOrigins: ['https://example.invalid'] }, {}), /OPTIONS_REFUSED/);
  await assert.rejects(spawnIntegration({ uri: 'mongodb://127.0.0.1:27017/do-not-connect' }), /EXTERNAL_CONFIGURATION_REFUSED/);
});
test('standalone launcher refuses ambient DB configuration before startup with safe error only', async () => {
  const child = fork(new URL('../tools/integration/launch.mjs', import.meta.url), [], {
    env: { ...process.env, MONGO_URI: 'mongodb://127.0.0.1:27017/do-not-connect' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 1); assert.equal(stdout, ''); assert.equal(stderr, 'INTEGRATION_START_FAILED\n');
});
test('a second launcher has independent disposable state and graceful stop closes every origin', async () => {
  const other = await spawnIntegration(); const origins = other.metadata.origins;
  const isolated = await other.control('isolation');
  try {
    assert.notEqual(origins[0], env.metadata.origins[0]); assert.equal((await other.control('snapshot')).users.length, 0);
    assert.equal(isolated.database, 'fc_synthetic'); assert.equal(isolated.replicaSet, 'fcSynthetic'); assert.equal(isolated.version, '8.0.16');
  }
  finally { await other.close(); }
  for (const origin of origins) await assert.rejects(fetch(origin + '/api/v2/capabilities', { signal: AbortSignal.timeout(1000) }));
  await portClosed(isolated.mongoPort);
});
async function portClosed(port) {
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('error', () => { socket.destroy(); resolve(); });
    socket.once('connect', () => { socket.destroy(); reject(Error('Synthetic owned port stayed open')); });
  });
}
for (const signal of ['SIGTERM', 'SIGINT']) test(`standalone ${signal} cleanup closes HTTP workers and the owned MongoDB`, async () => {
  const child = fork(new URL('../tools/integration/launch.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const metadata = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(Error('Synthetic signal fixture startup timed out')); }, 40000);
    child.once('message', message => { clearTimeout(timer); resolve(message.metadata); });
  });
  const isolated = await new Promise(resolve => {
    child.once('message', message => resolve(message.value)); child.send({ id: 1, op: 'isolation' });
  });
  child.kill(signal); assert.equal(await exited, 0);
  await assert.rejects(fetch(metadata.baseURL + '/api/v2/capabilities', { signal: AbortSignal.timeout(1000) }));
  await portClosed(isolated.mongoPort);
});
