import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { replicaSet, until } from '../tools/transaction-feasibility/replica-set.mjs';
import { Worker } from '../tools/transaction-feasibility/controller.mjs';
import { Store, initialize, collections, digest, finalStages, intakeStages } from '../tools/transaction-feasibility/store.mjs';

let rs, store, workers = [];
const actor = { accountId: 'synthetic-account-a', profileId: 'synthetic-profile-a' };
const sibling = { ...actor, profileId: 'synthetic-profile-b' };
const foreign = { accountId: 'synthetic-account-b', profileId: 'synthetic-profile-a' };
const body = [{ seq: 0, dir: 'right' }];
const changed = [{ seq: 0, dir: 'down' }];
const code = (promise, expected) => assert.rejects(promise, error => error.code === expected);
function worker() { const value = new Worker(rs.uri); workers.push(value); return value; }
async function ok(promise) { const response = await promise; assert.equal(response.error, undefined, JSON.stringify(response.error)); return response; }
async function started(who = actor, key = 'create', options = {}) {
  const s = await store.create(who, key);
  return store.transition(who, s._id, 'ready', 'ready', { now: 10, ifMatch: s.revision, ...options });
}
async function pending(options = {}) {
  const s = await started();
  const intent = await store.intake(actor, s._id, 'complete', { receivedAt: 30, ...options });
  return { s, intent };
}
async function counts() {
  return Object.fromEntries(await Promise.all(collections.map(async name => [name, await rs.db.collection(name).countDocuments()])));
}
async function snapshot() {
  return Object.fromEntries(await Promise.all(collections.map(async name => [name,
    await rs.db.collection(name).find().sort({ _id: 1 }).toArray()])));
}
async function finalInvariant(id, expected = 1) {
  // A majority snapshot transaction checks the entire aggregate, not just replies.
  await store.tx(async session => {
    const options = { session };
    const s = await rs.db.collection('sessions').findOne({ _id: id }, options);
    const results = await rs.db.collection('results').find({ attemptId: id }, options).toArray();
    const intents = await rs.db.collection('intents').find({ attemptId: id }, options).toArray();
    const keys = await rs.db.collection('keys').find({ attemptId: id, operation: 'complete' }, options).toArray();
    const events = await rs.db.collection('outbox').find({}, options).toArray();
    assert.equal(results.length, expected);
    assert.equal(await rs.db.collection('ledger').countDocuments({}, options), 0);
    assert.equal(await rs.db.collection('inventory').countDocuments({}, options), 0);
    for (const intent of intents) assert.ok(await rs.db.collection('bodies').findOne({ _id: intent.bodyId }, options));
    if (expected) {
      const result = results[0];
      assert.equal(s.state, 'COMPLETED'); assert.equal(s.resultId, result._id); assert.equal(s.pending, undefined);
      const completed = intents.filter(i => i.state === 'completed');
      assert.equal(completed.length, 1); assert.equal(completed[0].resultId, result._id);
      for (const key of keys.filter(k => k.state !== 'aborted')) {
        assert.equal(key.state, 'completed'); assert.equal(key.resultId, result._id);
      }
      assert.equal(events.filter(e => e.resultId === result._id).length, 1);
      assert.equal(await rs.db.collection('slots').countDocuments({ attemptId: id }, options), 0);
      assert.equal(result.transcriptHash, digest(body));
      assert.equal(result.elapsedMs, result.receivedAt - s.startedAt);
      if (Object.values(result.guardChecks).some(check => check.state !== 'healthy')) assert.notEqual(result.clockDisposition, 'healthy');
    } else {
      assert.equal(s.state, 'STARTED'); assert.equal(s.resultId, undefined);
      assert.equal(intents.filter(i => i.state === 'completed').length, 0);
      assert.equal(events.length, 0);
      assert.ok(keys.every(k => k.state !== 'completed'));
      assert.equal(await rs.db.collection('slots').countDocuments({ attemptId: id }, options), 1);
    }
  });
}

before(async () => { rs = await replicaSet(); await initialize(rs.db); }, { timeout: 40000 });
after(async () => { await Promise.all(workers.map(w => w.close())); await rs?.close(); });
beforeEach(async () => {
  for (const name of collections) await rs.db.collection(name).deleteMany({});
  store = new Store(rs.client);
});
afterEach(async () => {
  await rs.failOff();
  await Promise.all(workers.map(w => w.close())); workers = [];
});

test('T1 unique indexes enforce the exact operation/session/profile scopes', async () => {
  const indexes = await rs.db.collection('keys').indexes();
  assert.ok(indexes.some(i => i.unique && JSON.stringify(i.key) === JSON.stringify({ accountId: 1, operation: 1, scope: 1, key: 1 })));
  const s = await store.create(actor, 'same');
  assert.equal((await store.create(actor, 'same'))._id, s._id);
  await code(store.create(actor, 'same', { date: 'changed-date' }), 'KEY_CONFLICT');
  await code(store.create(sibling, 'same'), 'KEY_CONFLICT');
  await code(store.create(actor, 'other'), 'ACTIVE_SESSION');
  const other = await store.create(sibling, 'other');
  const third = await store.create(foreign, 'same');
  assert.notEqual(third._id, s._id);
  const ready = await store.transition(actor, s._id, 'ready', 'same', { now: 10, ifMatch: 1 });
  assert.equal((await store.transition(actor, s._id, 'ready', 'same', { now: 90 })).startedAt, 10);
  for (const patch of [{ nonce: 'changed' }, { gridHash: 'changed' }, { rulesVersion: 'changed' }]) {
    await code(store.transition(actor, s._id, 'ready', 'same', { now: 10, ...patch }), 'KEY_CONFLICT');
  }
  await store.transition(sibling, other._id, 'ready', 'same', { now: 10, ifMatch: 1 });
  await store.transition(actor, s._id, 'abandon', 'same', { now: 20, ifMatch: ready.revision });
  await code(store.transition(actor, s._id, 'abandon', 'same', { now: 20, reason: 'restart' }), 'KEY_CONFLICT');
  await store.transition(sibling, other._id, 'abandon', 'same', { now: 20, ifMatch: 2 });
  await code(store.transition(foreign, s._id, 'ready', 'same', { now: 10 }), 'NOT_FOUND');
  const next = await store.create(actor, 'next');
  await store.transition(actor, next._id, 'ready', 'same', { now: 10, ifMatch: 1 });
  await store.transition(actor, next._id, 'abandon', 'same', { now: 20, ifMatch: 2 });
});

test('T1 two processes race create keys and the profile active slot', async () => {
  const a = worker(), b = worker();
  const first = a.run('create', [actor, 'key-a'], { pause: 'create:read' });
  await a.paused(first);
  const second = b.run('create', [actor, 'key-b'], { pause: 'create:read' });
  await b.paused(second); a.resume();
  await ok(first);
  b.resume();
  assert.equal((await second).error.code, 'ACTIVE_SESSION');
  assert.equal((await counts()).sessions, 1); assert.equal((await counts()).slots, 1);
  const cross = await Promise.all([a.run('create', [sibling, 'key-a']), b.run('create', [sibling, 'key-a'])]);
  assert.ok(cross.every(r => r.error?.code === 'KEY_CONFLICT'));
});

test('T1 two-process alternative keys recover one intent; hash/owner/account collisions fail', async () => {
  const s = await started(), a = worker(), b = worker();
  const first = a.run('intake', [actor, s._id, 'c1', { receivedAt: 30 }], { pause: 'intake:before' });
  await a.paused(first);
  const second = b.run('intake', [actor, s._id, 'c2', { receivedAt: 40 }], { pause: 'intake:before' });
  await b.paused(second); a.resume(); await ok(first); b.resume();
  const [one, two] = await Promise.all([ok(first), ok(second)]);
  assert.equal(one.value._id, two.value._id); assert.equal(two.value.receivedAt, 30);
  assert.equal((await counts()).intents, 1); assert.equal((await counts()).bodies, 1);
  await code(store.intake(actor, s._id, 'c1', { receivedAt: 50, transcript: changed }), 'KEY_CONFLICT');
  const siblingSession = await started(sibling, 'sibling');
  await code(store.intake(sibling, siblingSession._id, 'c1', { receivedAt: 50 }), 'KEY_CONFLICT');
  await code(store.intake(foreign, s._id, 'c1', { receivedAt: 50 }), 'NOT_FOUND');
  const final = (await ok(b.run('finish', [actor, s._id, one.value._id]))).value;
  for (const key of ['c1', 'c2', 'c3']) {
    assert.deepEqual(await store.intake(actor, s._id, key, { receivedAt: 999 }), final);
  }
  await code(store.intake(actor, s._id, 'c4', { receivedAt: 999, transcript: changed }), 'KEY_CONFLICT');
  await finalInvariant(s._id);
});

for (const stage of ['before', ...intakeStages]) {
  test(`T1 process death at intake:${stage} leaves no partial body/intent/key/fence after DB restart`, async () => {
    const s = await started(), before = await snapshot();
    const w = worker();
    const result = await w.run('intake', [actor, s._id, 'complete', { receivedAt: 30 }], { crash: `intake:${stage}` });
    assert.equal(result.error.code, 'WORKER_EXIT');
    await rs.restart();
    assert.deepEqual(await snapshot(), before);
    const intent = await store.intake(actor, s._id, 'complete', { receivedAt: 40 });
    assert.equal(intent.generation, 1); assert.equal(intent.receivedAt, 40);
    await finalInvariant(s._id, 0);
  });
}
test('T1 lost intake acknowledgment recovers the original durable body/generation/time after restart', async () => {
  const s = await started(), w = worker();
  assert.equal((await w.run('intake', [actor, s._id, 'complete', { receivedAt: 30 }], { crash: 'afterCommit' })).error.code, 'WORKER_EXIT');
  await rs.restart();
  const recovered = await store.intake(actor, s._id, 'complete', { receivedAt: 80 });
  assert.equal(recovered.receivedAt, 30); assert.equal(recovered.generation, 1);
  assert.equal((await counts()).bodies, 1); assert.equal((await counts()).intents, 1);
  await store.finish(actor, s._id, recovered._id); await finalInvariant(s._id);
});

for (const stage of ['session', 'slot', 'key']) {
  test(`T1 create crash after ${stage} rolls back session/slot/account key together`, async () => {
    const before = await snapshot(), w = worker();
    assert.equal((await w.run('create', [actor, 'create'], { crash: `create:${stage}` })).error.code, 'WORKER_EXIT');
    await rs.restart(); assert.deepEqual(await snapshot(), before);
    const s = await store.create(actor, 'create');
    assert.equal((await store.create(actor, 'create'))._id, s._id);
  });
}
for (const operation of ['ready', 'abandon']) {
  for (const stage of operation === 'ready' ? ['session', 'key'] : ['session', 'slot', 'key']) {
    test(`T1 ${operation} crash after ${stage} rolls back all transition effects`, async () => {
      const s = await store.create(actor, 'create'), before = await snapshot(), w = worker();
      assert.equal((await w.run('transition', [actor, s._id, operation, 'op', { now: 10, ifMatch: 1 }],
        { crash: `${operation}:${stage}` })).error.code, 'WORKER_EXIT');
      await rs.restart(); assert.deepEqual(await snapshot(), before);
      await store.transition(actor, s._id, operation, 'op', { now: 20, ifMatch: 1 });
    });
  }
}
for (const operation of ['create', 'ready']) {
  test(`T1 lost ${operation} ACK replays effective state without reallocating or restarting`, async () => {
    const s = operation === 'ready' ? await store.create(actor, 'create') : undefined, w = worker();
    const args = operation === 'create' ? [actor, 'create'] : [actor, s._id, 'ready', 'ready', { now: 10, ifMatch: 1 }];
    assert.equal((await w.run(operation === 'create' ? 'create' : 'transition', args,
      { crash: 'afterCommit' })).error.code, 'WORKER_EXIT');
    const before = await snapshot(); await rs.restart();
    const replay = operation === 'create' ? await store.create(actor, 'create', { now: 90 })
      : await store.transition(actor, s._id, 'ready', 'ready', { now: 90 });
    assert.deepEqual(await snapshot(), before);
    assert.equal((await counts()).sessions, 1);
    if (operation === 'ready') assert.equal(replay.startedAt, 10);
  });
}
for (const firstOperation of ['ready', 'abandon']) {
  test(`T1 fixed revision ready/abandon race with ${firstOperation} first`, async () => {
    const s = await store.create(actor, 'create'), a = worker(), b = worker();
    const otherOperation = firstOperation === 'ready' ? 'abandon' : 'ready';
    const first = a.run('transition', [actor, s._id, firstOperation, 'first', { now: 10, ifMatch: 1 }],
      { pause: `${firstOperation}:read` });
    await a.paused(first);
    const second = b.run('transition', [actor, s._id, otherOperation, 'second', { now: 10, ifMatch: 1 }],
      { pause: `${otherOperation}:read` });
    await b.paused(second); a.resume(); await ok(first); b.resume();
    assert.equal((await second).error.code, 'REVISION');
    assert.equal((await rs.db.collection('sessions').findOne({ _id: s._id })).state,
      firstOperation === 'ready' ? 'STARTED' : 'ABANDONED');
  });
}

for (const offset of [-1, 0, 1]) {
  test(`T2 guard at receipt ${offset >= 0 ? '+' : ''}${offset}ms`, async () => {
    const { s, intent } = await pending();
    const guarded = new Store(rs.client, { guard: () => 30 + offset });
    if (offset < 0) {
      await code(guarded.finish(actor, s._id, intent._id), 'CLOCK_UNAVAILABLE');
      await finalInvariant(s._id, 0);
      await rs.restart();
      const held = await store.finish(actor, s._id, intent._id);
      assert.equal(held.receivedAt, 30); assert.equal(held.clockDisposition, 'review-required');
      assert.deepEqual(held.guardReversals, [29]);
    } else assert.equal((await guarded.finish(actor, s._id, intent._id)).guardAt, 30 + offset);
    await finalInvariant(s._id);
  });
}
test('T2 negative elapsed receipt is retained as irreparable rather than silently accepted timing', async () => {
  const { s, intent } = await pending({ receivedAt: 9 });
  const result = await store.finish(actor, s._id, intent._id);
  assert.equal(result.elapsedMs, -1); assert.equal(result.clockDisposition, 'irreparable');
  await rs.restart(); assert.deepEqual(await store.resolve(actor, s._id), result);
  await finalInvariant(s._id);
});
for (const offset of [-1, 0, 1]) {
  test(`T2 prepare deadline ${offset >= 0 ? '+' : ''}${offset}ms`, async () => {
    const s = await store.create(actor, 'c');
    const promise = store.transition(actor, s._id, 'ready', 'r', { now: 100 + offset, ifMatch: 1 });
    if (offset < 0) assert.equal((await promise).startedAt, 99);
    else { await code(promise, 'EXPIRED'); await store.expire(actor, s._id, 100 + offset); }
  });
  test(`T2 intake at play deadline ${offset >= 0 ? '+' : ''}${offset}ms`, async () => {
    const s = await started();
    const promise = store.intake(actor, s._id, 'complete', { receivedAt: 110 + offset });
    if (offset < 0) { const intent = await promise; assert.equal(intent.receivedAt, 109); }
    else { await code(promise, 'EXPIRED'); assert.equal((await counts()).intents, 0); }
    await finalInvariant(s._id, 0);
  });
  test(`T2 final guard at play deadline ${offset >= 0 ? '+' : ''}${offset}ms`, async () => {
    const { s, intent } = await pending({ receivedAt: 109 });
    const guarded = new Store(rs.client, { guard: () => 110 + offset });
    const promise = guarded.finish(actor, s._id, intent._id);
    if (offset < 0) await promise; else await code(promise, 'EXPIRED');
    await finalInvariant(s._id, offset < 0 ? 1 : 0);
  });
}

test('T2 commit/ACK after synthetic deadline preserves predeadline guard and original receipt', async () => {
  const { s, intent } = await pending({ receivedAt: 109 }), w = worker();
  const finishing = w.run('finish', [actor, s._id, intent._id], { guards: [109], pause: 'finish:outbox' });
  await w.paused(finishing);
  // The injected clock now advances past 110; no real-clock delay is required.
  await code(store.expire(actor, s._id, 111), 'COMMIT_UNKNOWN');
  w.resume();
  const result = (await ok(finishing)).value;
  assert.deepEqual(await store.intake(actor, s._id, 'complete', { receivedAt: 111 }), result);
  await finalInvariant(s._id);
});
test('T2 backward post-commit observation plus lost ACK/app+DB restart never discards winner', async () => {
  const { s, intent } = await pending(), w = worker();
  assert.equal((await w.run('finish', [actor, s._id, intent._id], { crash: 'afterCommit' })).error.code, 'WORKER_EXIT');
  const original = await rs.db.collection('results').findOne({ attemptId: s._id });
  assert.deepEqual(await store.observe(actor, s._id, 29), original);
  await rs.restart();
  const next = worker();
  assert.deepEqual((await ok(next.run('intake', [actor, s._id, 'complete', { receivedAt: -1 }]))).value, original);
  assert.equal((await rs.db.collection('observations').findOne()).reversed, true);
  await finalInvariant(s._id);
});
test('T2 private post-commit diagnostic write failure leaves exact receipt recoverable', async () => {
  const { s, intent } = await pending();
  const result = await store.finish(actor, s._id, intent._id);
  await rs.fail({ failCommands: ['insert'], errorCode: 2 });
  await assert.rejects(store.observe(actor, s._id, -100));
  assert.deepEqual(await store.resolve(actor, s._id), result);
  await finalInvariant(s._id);
});
for (const terminal of ['abandon', 'expire']) {
  test(`T2 ${terminal} wins against a paused predeadline intake and prevents late receipt`, async () => {
    const s = await started(), w = worker();
    const intake = w.run('intake', [actor, s._id, 'complete', { receivedAt: 109 }], { pause: 'intake:before' });
    await w.paused(intake);
    if (terminal === 'expire') await store.expire(actor, s._id, 110);
    else await store.transition(actor, s._id, 'abandon', 'abandon', { now: 109, ifMatch: s.revision });
    w.resume(); assert.equal((await intake).error.code, 'STATE');
    const totals = await counts();
    for (const name of ['intents', 'bodies', 'results', 'outbox', 'slots', 'ledger', 'inventory']) assert.equal(totals[name], 0);
  });
}

test('T3 resolver-first fences an older transaction; empty read, time and abandon cannot replace intent', async () => {
  const { s, intent } = await pending(), a = worker(), b = worker();
  const old = a.run('finish', [actor, s._id, intent._id], { pause: 'finish:read' });
  await a.paused(old);
  assert.equal(await rs.db.collection('results').findOne({ attemptId: s._id }), null);
  assert.equal((await store.intake(actor, s._id, 'complete', { receivedAt: 999 })).receivedAt, 30);
  await code(store.transition(actor, s._id, 'abandon', 'a', { now: 999, ifMatch: 3 }), 'COMMIT_UNKNOWN');
  await code(store.expire(actor, s._id, 999), 'COMMIT_UNKNOWN');
  const resolution = (await ok(b.run('resolve', [actor, s._id]))).value;
  assert.equal(resolution.outcome, 'aborted'); assert.equal(resolution.revision, intent.expectedRevision + 2);
  a.resume();
  assert.equal((await old).error.code, 'FENCED');
  await finalInvariant(s._id, 0);
  await rs.restart();
  await code(store.intake(actor, s._id, 'complete', { receivedAt: 50, transcript: changed }), 'KEY_CONFLICT');
  const fresh = await store.intake(actor, s._id, 'complete', { receivedAt: 50 });
  assert.equal(fresh.generation, 2); assert.equal(fresh.receivedAt, 50);
  assert.ok(fresh.expectedRevision > intent.expectedRevision);
  await store.finish(actor, s._id, fresh._id); await finalInvariant(s._id);
});

test('T3 completion-first forces an older resolver snapshot to recover the committed winner', async () => {
  const { s, intent } = await pending(), a = worker(), b = worker();
  const resolving = b.run('resolve', [actor, s._id], { pause: 'resolve:read' });
  await b.paused(resolving);
  const result = (await ok(a.run('finish', [actor, s._id, intent._id]))).value;
  b.resume();
  const recovered = await ok(resolving);
  assert.deepEqual(recovered.value, result); assert.ok(recovered.stats.transientRetries >= 1);
  await finalInvariant(s._id);
});
test('T3 competing resolvers serialize one abort and leave no old transaction able to commit', async () => {
  const { s, intent } = await pending(), a = worker(), b = worker();
  const first = a.run('resolve', [actor, s._id], { pause: 'resolve:read' });
  await a.paused(first);
  const second = (await ok(b.run('resolve', [actor, s._id]))).value;
  assert.equal(second.outcome, 'aborted');
  a.resume(); assert.equal((await first).error.code, 'NO_PENDING');
  await code(store.finish(actor, s._id, intent._id), 'FENCED'); await finalInvariant(s._id, 0);
});
test('T3 aborted alias keys rejoin a new generation without retaining stale pending bindings', async () => {
  const { s } = await pending();
  await store.intake(actor, s._id, 'alias', { receivedAt: 40 });
  await store.resolve(actor, s._id);
  const fresh = await store.intake(actor, s._id, 'complete', { receivedAt: 50 });
  const alias = await store.intake(actor, s._id, 'alias', { receivedAt: 60 });
  assert.equal(alias._id, fresh._id); assert.equal(alias.receivedAt, 50);
  assert.equal((await rs.db.collection('keys').findOne({ operation: 'complete', key: 'alias' })).intentId, fresh._id);
  await store.finish(actor, s._id, fresh._id); await finalInvariant(s._id);
});
test('T3 transient server transaction failure retries body with the original receipt', async () => {
  const { s, intent } = await pending();
  await rs.fail({ failCommands: ['insert'], errorCode: 112, errorLabels: ['TransientTransactionError'] });
  const result = await store.finish(actor, s._id, intent._id);
  assert.ok(store.stats.transientRetries >= 1); assert.equal(result.receivedAt, 30);
  await finalInvariant(s._id);
});
test('T2/T3 transient retry rechecks deadline instead of reserving a terminal win', async () => {
  const { s, intent } = await pending({ receivedAt: 109 });
  const guarded = new Store(rs.client, { guard: (() => { const samples = [109, 110]; return () => samples.shift(); })() });
  await rs.fail({ failCommands: ['insert'], errorCode: 112, errorLabels: ['TransientTransactionError'] });
  await code(guarded.finish(actor, s._id, intent._id), 'EXPIRED');
  assert.equal(guarded.stats.transientRetries, 1); await finalInvariant(s._id, 0);
});
test('T3 failCommand unknown commit outcome retries COMMIT, not the transaction body', async () => {
  const { s, intent } = await pending();
  const guarded = new Store(rs.client, { hook: async stage => {
    if (stage === 'finish:admitted') await rs.fail({ failCommands: ['commitTransaction'], errorCode: 91, errorLabels: ['UnknownTransactionCommitResult'] });
  } });
  const result = await guarded.finish(actor, s._id, intent._id);
  assert.ok(guarded.stats.commitRetries >= 1); assert.equal(guarded.stats.transactions, 2);
  assert.equal(result.receivedAt, 30); await finalInvariant(s._id);
});
test('T3 closed commit connections exhaust bounded recovery; app restart resolves the pending generation', async () => {
  const { s, intent } = await pending();
  const w = worker();
  const finishing = w.run('finish', [actor, s._id, intent._id], { commitAttempts: 1, pause: 'finish:admitted' });
  await w.paused(finishing);
  // Driver retries commit once internally, then the experiment has one explicit attempt.
  await rs.client.db('admin').command({ configureFailPoint: 'failCommand', mode: { times: 2 },
    data: { failCommands: ['commitTransaction'], closeConnection: true } });
  w.resume(); const response = await finishing;
  assert.equal(response.error.code, 'COMMIT_UNKNOWN');
  assert.equal((await store.intake(actor, s._id, 'complete', { receivedAt: 60 })).receivedAt, 30);
  await w.close(); await rs.restart();
  const recovery = worker();
  const resolved = (await ok(recovery.run('resolve', [actor, s._id]))).value;
  // failCommand closed connections before execution, so this schedule has no winner.
  assert.equal(resolved.outcome, 'aborted');
  await finalInvariant(s._id, 0);
});
test('T3 durable commit with lost write-concern ACK returns COMMIT_UNKNOWN then winner after restart', async () => {
  const { s, intent } = await pending();
  const w = worker();
  const finishing = w.run('finish', [actor, s._id, intent._id], { commitAttempts: 1, pause: 'finish:admitted' });
  await w.paused(finishing);
  // failCommand appends this error AFTER executing commit, unlike closeConnection.
  await rs.client.db('admin').command({ configureFailPoint: 'failCommand', mode: { times: 2 },
    data: { failCommands: ['commitTransaction'], writeConcernError: { code: 64, errmsg: 'synthetic lost acknowledgment' },
      errorLabels: ['UnknownTransactionCommitResult'] } });
  w.resume(); const response = await finishing;
  assert.equal(response.error.code, 'COMMIT_UNKNOWN');
  await rs.failOff();
  // Injected WCE bypasses the normal durability wait: local visibility alone
  // cannot justify calling this the durable-winner schedule before SIGKILL.
  const original = await until(() => rs.db.collection('results').findOne({ attemptId: s._id }, {
    readConcern: { level: 'majority' },
  }));
  assert.ok(original); assert.equal(original.receivedAt, 30);
  await w.close(); await rs.restart();
  const recovery = worker();
  assert.deepEqual((await ok(recovery.run('resolve', [actor, s._id]))).value, original);
  assert.deepEqual(await store.intake(actor, s._id, 'complete', { receivedAt: -100 }), original);
  await finalInvariant(s._id);
});
for (const stage of ['session', 'intent', 'key']) {
  test(`T3 resolver crash after ${stage} cannot leave partial abort proof`, async () => {
    const { s, intent } = await pending(), before = await snapshot(), w = worker();
    assert.equal((await w.run('resolve', [actor, s._id], { crash: `resolve:${stage}` })).error.code, 'WORKER_EXIT');
    await rs.restart(); assert.deepEqual(await snapshot(), before);
    const recovered = await store.intake(actor, s._id, 'complete', { receivedAt: 80 });
    assert.equal(recovered._id, intent._id); assert.equal(recovered.receivedAt, 30);
    await store.finish(actor, s._id, intent._id); await finalInvariant(s._id);
  });
}
test('T3 actual primary stepdown invalidates paused transaction and preserves intent recovery', async () => {
  const { s, intent } = await pending(), w = worker();
  const old = w.run('finish', [actor, s._id, intent._id], { pause: 'finish:read' });
  await w.paused(old); await rs.stepDown(); w.resume();
  const result = await ok(old);
  assert.ok(result.stats.transientRetries >= 1); assert.equal(result.value.receivedAt, 30);
  await finalInvariant(s._id);
});

for (const stage of ['read', ...finalStages]) {
  test(`T4 SIGKILL after finish:${stage} before commit rolls back every final effect after DB restart`, async () => {
    const { s, intent } = await pending(), w = worker();
    const finishing = w.run('finish', [actor, s._id, intent._id], { pause: 'finish:admitted', crash: `finish:${stage}` });
    await w.paused(finishing); const before = await snapshot(); w.resume();
    assert.equal((await finishing).error.code, 'WORKER_EXIT');
    await rs.restart();
    assert.deepEqual(await snapshot(), before); await finalInvariant(s._id, 0);
    const recovery = worker();
    const result = (await ok(recovery.run('finish', [actor, s._id, intent._id]))).value;
    assert.equal(result.receivedAt, 30); assert.equal(result.clockDisposition, 'review-required'); await finalInvariant(s._id);
  });
}
test('T4 two completion processes recover one immutable receipt and one outbox event', async () => {
  const { s, intent } = await pending(), a = worker(), b = worker();
  const first = a.run('finish', [actor, s._id, intent._id], { pause: 'finish:read' });
  await a.paused(first);
  const second = (await ok(b.run('finish', [actor, s._id, intent._id]))).value;
  a.resume(); assert.deepEqual((await ok(first)).value, second);
  await finalInvariant(s._id);
});
test('T4 stale cleanup snapshot cannot remove a successor profile slot', async () => {
  const s = await store.create(actor, 'old'), w = worker();
  const cleanup = w.run('expire', [actor, s._id, 100], { pause: 'expire:read' });
  await w.paused(cleanup);
  await store.transition(actor, s._id, 'abandon', 'a', { now: 90, ifMatch: 1 });
  const successor = await store.create(actor, 'new', { now: 100 });
  w.resume(); await ok(cleanup);
  assert.equal((await rs.db.collection('slots').findOne({ ...actor })).attemptId, successor._id);
  assert.equal((await rs.db.collection('sessions').findOne({ _id: s._id })).state, 'ABANDONED');
});

test('T2 QA A failed reversal evidence update retains a durable unresolved hold through retry and restart', async () => {
  const { s, intent } = await pending(), a = worker();
  const reversing = a.run('finish', [actor, s._id, intent._id], { guards: [29], pause: 'clock:beforeEvidence' });
  await a.paused(reversing);
  await rs.fail({ failCommands: ['update'], errorCode: 2 });
  a.resume(); assert.equal((await reversing).error.code, 'CLOCK_EVIDENCE_UNAVAILABLE');
  const admitted = await rs.db.collection('intents').findOne({ _id: intent._id }, { readConcern: { level: 'majority' } });
  assert.deepEqual(admitted.guardReversals, []);
  assert.deepEqual(Object.values(admitted.guardChecks), [{ state: 'unresolved' }]);
  await finalInvariant(s._id, 0);
  const b = worker();
  const result = (await ok(b.run('finish', [actor, s._id, intent._id], { guards: [30] }))).value;
  assert.equal(result.receivedAt, 30); assert.equal(result.clockDisposition, 'review-required');
  await rs.restart(); assert.deepEqual(await store.resolve(actor, s._id), result);
  await finalInvariant(s._id);
});

test('T2 QA B delayed reversal evidence update cannot let a competing finalizer certify healthy', async () => {
  const { s, intent } = await pending(), a = worker(), b = worker();
  await ok(b.run('owned', [actor, s._id])); // Warm the competing process before the 1500ms schedule.
  const reversing = a.run('finish', [actor, s._id, intent._id], { guards: [29], pause: 'clock:beforeEvidence' });
  await a.paused(reversing);
  const point = await rs.fail({ failCommands: ['update'], blockConnection: true, blockTimeMS: 1500 });
  a.resume();
  await rs.client.db('admin').command({ waitForFailPoint: 'failCommand', timesEntered: point.count + 1, maxTimeMS: 5000 });
  const winner = (await ok(b.run('finish', [actor, s._id, intent._id], { guards: [30] }))).value;
  assert.equal(winner.receivedAt, 30); assert.equal(winner.clockDisposition, 'review-required');
  assert.ok(Object.values(winner.guardChecks).some(check => check.state === 'unresolved'));
  assert.deepEqual((await ok(reversing)).value, winner);
  const admitted = await rs.db.collection('intents').findOne({ _id: intent._id }, { readConcern: { level: 'majority' } });
  assert.deepEqual(admitted.guardReversals, [29]);
  const observation = await rs.db.collection('observations').findOne({ resultId: winner._id });
  assert.deepEqual(observation.reversals, [29]);
  await rs.restart(); assert.deepEqual(await store.resolve(actor, s._id), winner);
  await finalInvariant(s._id);
});
test('T2 failed late reversal evidence write returns the majority winner with its unresolved hold intact', async () => {
  const { s, intent } = await pending(), a = worker(), b = worker();
  const reversing = a.run('finish', [actor, s._id, intent._id], { guards: [29], pause: 'clock:beforeEvidence' });
  await a.paused(reversing);
  const winner = (await ok(b.run('finish', [actor, s._id, intent._id], { guards: [30] }))).value;
  assert.equal(winner.clockDisposition, 'review-required');
  await rs.fail({ failCommands: ['update'], errorCode: 2 });
  a.resume(); assert.deepEqual((await ok(reversing)).value, winner);
  assert.deepEqual((await rs.db.collection('intents').findOne({ _id: intent._id })).guardReversals, []);
  assert.ok(Object.values(winner.guardChecks).some(check => check.state === 'unresolved'));
  await rs.restart(); assert.deepEqual(await store.resolve(actor, s._id), winner);
  await finalInvariant(s._id);
});

for (const stage of ['session', 'intent']) {
  test(`T2 crash after guard admission ${stage} admits no observation or partial fence`, async () => {
    const { s, intent } = await pending(), before = await snapshot(), w = worker();
    assert.equal((await w.run('finish', [actor, s._id, intent._id], { crash: `guard:${stage}` })).error.code, 'WORKER_EXIT');
    await rs.restart(); assert.deepEqual(await snapshot(), before);
    const result = await store.finish(actor, s._id, intent._id);
    assert.equal(result.clockDisposition, 'healthy'); await finalInvariant(s._id);
  });
  test(`T2 crash after reversal ${stage} preserves unresolved timing until recovery`, async () => {
    const { s, intent } = await pending(), w = worker();
    assert.equal((await w.run('finish', [actor, s._id, intent._id], { guards: [29], crash: `clock:${stage}` })).error.code, 'WORKER_EXIT');
    await rs.restart();
    const result = await store.finish(actor, s._id, intent._id);
    assert.equal(result.clockDisposition, 'review-required'); assert.equal(result.receivedAt, 30);
    await finalInvariant(s._id);
  });
}
test('T2 unknown clock-admission commit never samples clock and remains timing-held on recovery', async () => {
  const { s, intent } = await pending(); let sampled = false;
  const guarded = new Store(rs.client, { commitAttempts: 1, guard: () => { sampled = true; return 30; } });
  await rs.client.db('admin').command({ configureFailPoint: 'failCommand', mode: { times: 2 }, data: {
    failCommands: ['commitTransaction'], writeConcernError: { code: 64, errmsg: 'synthetic admission acknowledgment' },
    errorLabels: ['UnknownTransactionCommitResult'],
  } });
  await code(guarded.finish(actor, s._id, intent._id), 'COMMIT_UNKNOWN'); assert.equal(sampled, false);
  await rs.failOff();
  await until(async () => Object.keys((await rs.db.collection('intents').findOne({ _id: intent._id }, {
    readConcern: { level: 'majority' },
  }))?.guardChecks || {}).length === 1);
  await rs.restart();
  const result = await store.finish(actor, s._id, intent._id);
  assert.equal(result.clockDisposition, 'review-required'); await finalInvariant(s._id);
});
test('T2 already durable winner precedes later clock sampling and remains immutable', async () => {
  const { s, intent } = await pending(), result = await store.finish(actor, s._id, intent._id);
  const before = await snapshot();
  const late = new Store(rs.client, { guard: () => { assert.fail('durable winner must precede clock sampling'); } });
  assert.deepEqual(await late.finish(actor, s._id, intent._id), result);
  assert.deepEqual(await snapshot(), before); assert.equal(result.clockDisposition, 'healthy');
});
test('T2 unknown reversal-evidence commit retains admitted timing hold and receipt on restart', async () => {
  const { s, intent } = await pending(), w = worker();
  const reversing = w.run('finish', [actor, s._id, intent._id], {
    guards: [29], pause: 'clock:beforeEvidence', commitAttempts: 1,
  });
  await w.paused(reversing);
  await rs.client.db('admin').command({ configureFailPoint: 'failCommand', mode: { times: 2 }, data: {
    failCommands: ['commitTransaction'], writeConcernError: { code: 64, errmsg: 'synthetic evidence acknowledgment' },
    errorLabels: ['UnknownTransactionCommitResult'],
  } });
  w.resume(); assert.equal((await reversing).error.code, 'COMMIT_UNKNOWN'); await rs.failOff();
  await until(async () => (await rs.db.collection('intents').findOne({ _id: intent._id }, {
    readConcern: { level: 'majority' },
  })).guardReversals.includes(29));
  await rs.restart();
  const result = await store.finish(actor, s._id, intent._id);
  assert.equal(result.receivedAt, 30); assert.equal(result.clockDisposition, 'review-required');
  assert.deepEqual(result.guardReversals, [29]); await finalInvariant(s._id);
});
test('T2 resolver fencing a locally detected reversal requires a new generation and later receipt', async () => {
  const { s, intent } = await pending(), w = worker();
  const reversing = w.run('finish', [actor, s._id, intent._id], { guards: [29], pause: 'clock:beforeEvidence' });
  await w.paused(reversing); assert.equal((await store.resolve(actor, s._id)).outcome, 'aborted');
  w.resume(); assert.equal((await reversing).error.code, 'FENCED');
  const old = await rs.db.collection('intents').findOne({ _id: intent._id });
  assert.equal(old.state, 'aborted'); assert.ok(Object.values(old.guardChecks).some(check => check.state === 'unresolved'));
  await rs.restart();
  const fresh = await store.intake(actor, s._id, 'complete', { receivedAt: 50 });
  assert.equal(fresh.generation, 2);
  const result = await store.finish(actor, s._id, fresh._id);
  assert.equal(result.receivedAt, 50); assert.equal(result.clockDisposition, 'healthy');
  await finalInvariant(s._id);
});

for (const operation of ['create', 'ready']) for (const offset of [-1, 0, 1]) {
  test(`T1 ${operation} exact replay at deadline ${offset} preserves identity and trusted start`, async () => {
    const s = operation === 'create' ? await store.create(actor, 'create') : await started();
    const replay = operation === 'create' ? await store.create(actor, 'create', { now: s.deadline + offset })
      : await store.transition(actor, s._id, 'ready', 'ready', { now: s.deadline + offset });
    assert.equal(replay._id, s._id); assert.equal(replay.startedAt, s.startedAt); assert.equal(replay.deadline, s.deadline);
    assert.equal(replay.state, offset < 0 ? s.state : 'EXPIRED');
    assert.equal((await counts()).sessions, 1); assert.equal((await counts()).slots, offset < 0 ? 1 : 0);
    await rs.restart();
    const persisted = await rs.db.collection('sessions').findOne({ _id: s._id });
    assert.equal(persisted.state, replay.state); assert.equal(persisted.startedAt, s.startedAt);
  });
}
test('T1 create replay after ready uses the play deadline without restarting the trusted start', async () => {
  const s = await started();
  assert.equal((await store.create(actor, 'create', { now: 109 })).state, 'STARTED');
  const expired = await store.create(actor, 'create', { now: 110 });
  assert.equal(expired.state, 'EXPIRED'); assert.equal(expired.startedAt, 10); assert.equal(expired._id, s._id);
  const successor = await store.create(actor, 'successor', { now: 111 });
  assert.notEqual(successor._id, s._id);
  assert.equal((await store.transition(actor, s._id, 'ready', 'ready', { now: 112 })).state, 'EXPIRED');
  assert.equal((await rs.db.collection('slots').findOne({ ...actor })).attemptId, successor._id);
});
test('T1 expired create and ready replays retain pending uncertainty and its slot', async () => {
  const { s } = await pending();
  for (const now of [109, 110, 111]) {
    const replies = [await store.create(actor, 'create', { now }), await store.transition(actor, s._id, 'ready', 'ready', { now })];
    for (const replay of replies) {
      assert.equal(replay.state, 'STARTED'); assert.equal(replay.saveStatus, 'resolving');
      assert.equal(replay._id, s._id); assert.equal(replay.startedAt, 10);
    }
    assert.equal((await counts()).slots, 1);
  }
  await store.resolve(actor, s._id);
  assert.equal((await store.create(actor, 'create', { now: 111 })).state, 'EXPIRED');
  assert.equal((await counts()).slots, 0);
});
test('T1 expiry replay snapshot loses to concurrent intake and retains pending slot', async () => {
  const s = await started(), w = worker();
  const replay = w.run('create', [actor, 'create', { now: 110 }], { pause: 'replay:read' });
  await w.paused(replay);
  await store.intake(actor, s._id, 'complete', { receivedAt: 109 });
  w.resume();
  const result = (await ok(replay)).value;
  assert.equal(result.state, 'STARTED'); assert.equal(result.saveStatus, 'resolving');
  assert.equal((await counts()).slots, 1); await finalInvariant(s._id, 0);
});
test('T1 stale expiry replay cannot remove a successor slot after concurrent cleanup', async () => {
  const s = await started(), w = worker();
  const replay = w.run('transition', [actor, s._id, 'ready', 'ready', { now: 110 }], { pause: 'replay:read' });
  await w.paused(replay); await store.expire(actor, s._id, 110);
  const successor = await store.create(actor, 'successor', { now: 111 });
  w.resume(); assert.equal((await ok(replay)).value.state, 'EXPIRED');
  assert.equal((await rs.db.collection('slots').findOne({ ...actor })).attemptId, successor._id);
});
