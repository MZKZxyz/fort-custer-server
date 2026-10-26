// A deliberately isolated storage experiment, not a runtime API implementation.
// Times, identities, ownership and clock evidence are trusted synthetic fixtures.
import { createHash, randomUUID } from 'node:crypto';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const collections = ['sessions', 'slots', 'keys', 'bodies', 'intents', 'results', 'outbox', 'observations', 'ledger', 'inventory'];
export const finalStages = ['result', 'intent', 'session', 'slot', 'key', 'outbox'];
export const intakeStages = ['body', 'intent', 'session', 'key'];
export function fail(code) { throw Object.assign(new Error(code), { code }); }
const scope = (actor, op, key, attemptId = '') => ({ accountId: actor.accountId,
  operation: op, key, scope: ['ready', 'abandon'].includes(op) ? attemptId : '' });
const slot = actor => ({ accountId: actor.accountId, profileId: actor.profileId });
const check = (prior, hash) => { if (prior && prior.hash !== hash) fail('KEY_CONFLICT'); };

export async function initialize(db) {
  for (const name of collections) await db.createCollection(name);
  await db.collection('keys').createIndex({ accountId: 1, operation: 1, scope: 1, key: 1 }, { unique: true });
  await db.collection('slots').createIndex({ accountId: 1, profileId: 1 }, { unique: true });
  await db.collection('results').createIndex({ attemptId: 1 }, { unique: true });
  await db.collection('intents').createIndex({ attemptId: 1, generation: 1 }, { unique: true });
  await db.collection('outbox').createIndex({ resultId: 1, type: 1 }, { unique: true });
}

export class Store {
  constructor(client, { hook = async () => {}, guard = receipt => receipt,
    transactionAttempts = 8, commitAttempts = 3 } = {}) {
    this.client = client; this.db = client.db(); this.hook = hook; this.guard = guard;
    this.transactionAttempts = transactionAttempts; this.commitAttempts = commitAttempts;
    this.stats = { transactions: 0, transientRetries: 0, commitRetries: 0 };
  }
  c(name) { return this.db.collection(name); }
  async tx(body) {
    for (let attempt = 0; attempt < this.transactionAttempts; attempt++) {
      const session = this.client.startSession();
      session.startTransaction({ readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority', j: true, wtimeout: 5000 },
        readPreference: 'primary', maxCommitTimeMS: 5000 });
      this.stats.transactions++;
      let committing = false;
      try {
        const value = await body(session);
        committing = true;
        for (let n = 0; ; n++) {
          try { await session.commitTransaction(); break; }
          catch (error) {
            if (!error.hasErrorLabel?.('UnknownTransactionCommitResult')) throw error;
            this.stats.commitRetries++;
            if (n + 1 >= this.commitAttempts) fail('COMMIT_UNKNOWN');
          }
        }
        await this.hook('afterCommit');
        return value;
      } catch (error) {
        // An unknown commit must never be treated as a known abort or rerun body.
        if (error.code === 'COMMIT_UNKNOWN') throw error;
        if (!committing || error.hasErrorLabel?.('TransientTransactionError')) {
          await session.abortTransaction().catch(() => {});
        }
        if ((error.hasErrorLabel?.('TransientTransactionError') || error.code === 11000)
            && attempt + 1 < this.transactionAttempts) {
          this.stats.transientRetries++;
          continue;
        }
        throw error;
      } finally { await session.endSession(); }
    }
    fail('RETRY_EXHAUSTED');
  }
  async owned(actor, id, session) {
    const s = await this.c('sessions').findOne({ _id: id, ...slot(actor) }, { session });
    if (!s) fail('NOT_FOUND');
    return s;
  }
  async create(actor, key, { now = 0, prepareMs = 100, date = 'synthetic-date' } = {}) {
    const binding = scope(actor, 'create', key), hash = digest({ profileId: actor.profileId, date });
    const id = randomUUID();
    return this.tx(async session => {
      const prior = await this.c('keys').findOne(binding, { session }); check(prior, hash);
      if (prior) return this.owned(actor, prior.attemptId, session);
      if (await this.c('slots').findOne(slot(actor), { session })) fail('ACTIVE_SESSION');
      await this.hook('create:read');
      const value = { _id: id, ...slot(actor), date, state: 'PREPARED', revision: 1,
        generation: 0, deadline: now + prepareMs, nonce: 'synthetic-nonce',
        gridHash: digest(['SE']), rulesVersion: 'synthetic-v1' };
      await this.c('sessions').insertOne(value, { session }); await this.hook('create:session');
      await this.c('slots').insertOne({ ...slot(actor), attemptId: id }, { session }); await this.hook('create:slot');
      await this.c('keys').insertOne({ ...binding, hash, attemptId: id }, { session }); await this.hook('create:key');
      return value;
    });
  }
  async transition(actor, id, operation, key, { now, ifMatch, playMs = 100,
    nonce = 'synthetic-nonce', gridHash = digest(['SE']), rulesVersion = 'synthetic-v1', reason = 'user-choice' } = {}) {
    const payload = operation === 'ready' ? { nonce, gridHash, rulesVersion } : { reason };
    const binding = scope(actor, operation, key, id), hash = digest({ profileId: actor.profileId, ...payload });
    return this.tx(async session => {
      const s = await this.owned(actor, id, session);
      const prior = await this.c('keys').findOne(binding, { session }); check(prior, hash);
      if (prior) return s;
      if (s.pending) fail('COMMIT_UNKNOWN');
      if (now >= s.deadline) fail('EXPIRED');
      if (s.revision !== ifMatch) fail('REVISION');
      if (operation === 'ready') {
        if (s.state !== 'PREPARED') fail('STATE');
        if (nonce !== s.nonce || gridHash !== s.gridHash || rulesVersion !== s.rulesVersion) fail('READY_BINDING');
      } else if (!['PREPARED', 'STARTED'].includes(s.state)) fail('STATE');
      await this.hook(`${operation}:read`);
      const change = operation === 'ready' ? { state: 'STARTED', startedAt: now, deadline: now + playMs }
        : { state: 'ABANDONED' };
      await this.c('sessions').updateOne({ _id: id, revision: s.revision }, { $set: change, $inc: { revision: 1 } }, { session });
      await this.hook(`${operation}:session`);
      if (operation === 'abandon') {
        await this.c('slots').deleteOne({ ...slot(actor), attemptId: id }, { session }); await this.hook('abandon:slot');
      }
      await this.c('keys').insertOne({ ...binding, hash, attemptId: id }, { session }); await this.hook(`${operation}:key`);
      return { ...s, ...change, revision: s.revision + 1 };
    });
  }
  async intake(actor, id, key, { receivedAt, transcript = [{ seq: 0, dir: 'right' }] } = {}) {
    // Route/schema validation belongs to T5; here the body is a small trusted fixture.
    const transcriptHash = digest(transcript), hash = digest({ profileId: actor.profileId, attemptId: id, transcriptHash });
    const binding = scope(actor, 'complete', key);
    return this.tx(async session => {
      const s = await this.owned(actor, id, session);
      const prior = await this.c('keys').findOne(binding, { session }); check(prior, hash);
      const result = await this.c('results').findOne({ attemptId: id }, { session });
      if (result) {
        if (result.transcriptHash !== transcriptHash) fail('KEY_CONFLICT');
        await this.c('keys').updateOne(binding, { $set: { hash, attemptId: id,
          intentId: result.intentId, state: 'completed', resultId: result._id } }, { upsert: true, session });
        return result;
      }
      if (s.pending) {
        const pending = await this.c('intents').findOne({ _id: s.pending }, { session });
        if (pending.hash !== hash) fail('KEY_CONFLICT');
        // Alias keys can recover the existing generation, never replace its time.
        if (!prior || prior.intentId !== pending._id) {
          await this.c('sessions').updateOne({ _id: id }, { $inc: { revision: 1 } }, { session });
          // expectedRevision is pinned to the session revision at finalization time
          await this.c('intents').updateOne({ _id: pending._id }, { $inc: { expectedRevision: 1 } }, { session });
          await this.c('keys').updateOne(binding, { $set: { hash, attemptId: id,
            intentId: pending._id, state: 'pending' } }, { upsert: true, session });
        }
        return this.c('intents').findOne({ _id: pending._id }, { session });
      }
      if (s.state !== 'STARTED') fail('STATE');
      if (receivedAt >= s.deadline) fail('EXPIRED');
      const generation = s.generation + 1, intentId = `${id}:${generation}`;
      const intent = { _id: intentId, ...slot(actor), attemptId: id, generation, hash, transcriptHash,
        bodyId: transcriptHash, receivedAt, expectedRevision: s.revision + 1, state: 'pending', guardReversals: [] };
      await this.hook('intake:before');
      await this.c('bodies').updateOne({ _id: transcriptHash }, { $setOnInsert: { transcript } }, { upsert: true, session }); await this.hook('intake:body');
      await this.c('intents').insertOne(intent, { session }); await this.hook('intake:intent');
      await this.c('sessions').updateOne({ _id: id, revision: s.revision }, {
        $set: { pending: intentId, generation }, $inc: { revision: 1 },
      }, { session }); await this.hook('intake:session');
      // A proved abort permits rebinding this exact key/body to a new generation.
      await this.c('keys').updateOne(binding, { $set: { hash, attemptId: id, intentId, state: 'pending' } }, { upsert: true, session }); await this.hook('intake:key');
      return intent;
    });
  }
  async finish(actor, id, intentId) {
    try {
      return await this.tx(async session => {
        const s = await this.owned(actor, id, session);
        const result = await this.c('results').findOne({ attemptId: id }, { session });
        if (result) return result;
        const intent = await this.c('intents').findOne({ _id: intentId, attemptId: id }, { session });
        if (!intent || intent.state !== 'pending' || s.pending !== intentId || s.revision !== intent.expectedRevision) fail('FENCED');
        await this.hook('finish:read');
        const guardAt = await this.guard(intent.receivedAt);
        if (guardAt < intent.receivedAt) throw Object.assign(new Error('CLOCK_UNAVAILABLE'), { code: 'CLOCK_UNAVAILABLE', guardAt });
        if (s.state !== 'STARTED' || guardAt >= s.deadline || intent.receivedAt >= s.deadline) fail('EXPIRED');
        const receipt = { _id: `result:${id}`, attemptId: id, intentId, transcriptHash: intent.transcriptHash,
          receivedAt: intent.receivedAt, startedAt: s.startedAt, guardAt, elapsedMs: intent.receivedAt - s.startedAt,
          guardReversals: intent.guardReversals,
          clockDisposition: intent.receivedAt < s.startedAt ? 'irreparable'
            : intent.guardReversals.length ? 'review-required' : 'healthy',
          entitlementStatus: 'unresolved-at-receipt' };
        await this.c('results').insertOne(receipt, { session }); await this.hook('finish:result');
        await this.c('intents').updateOne({ _id: intentId, state: 'pending' }, { $set: { state: 'completed', resultId: receipt._id } }, { session }); await this.hook('finish:intent');
        await this.c('sessions').updateOne({ _id: id, revision: intent.expectedRevision }, {
          $set: { state: 'COMPLETED', resultId: receipt._id }, $unset: { pending: '' }, $inc: { revision: 1 },
        }, { session }); await this.hook('finish:session');
        await this.c('slots').deleteOne({ ...slot(actor), attemptId: id }, { session }); await this.hook('finish:slot');
        await this.c('keys').updateMany({ intentId }, { $set: { state: 'completed', resultId: receipt._id } }, { session }); await this.hook('finish:key');
        await this.c('outbox').insertOne({ _id: receipt._id, resultId: receipt._id, type: 'receipt' }, { session }); await this.hook('finish:outbox');
        return receipt;
      });
    } catch (error) {
      if (error.code === 'CLOCK_UNAVAILABLE') {
        // The final tx aborted. Persist private evidence on the same intent fence.
        await this.c('intents').updateOne({ _id: intentId, state: 'pending' }, {
          $push: { guardReversals: error.guardAt },
        }, { writeConcern: { w: 'majority', j: true } });
      }
      throw error;
    }
  }
  async resolve(actor, id) {
    return this.tx(async session => {
      const s = await this.owned(actor, id, session);
      const result = await this.c('results').findOne({ attemptId: id }, { session });
      if (result) return result;
      if (!s.pending) fail('NO_PENDING');
      const intent = await this.c('intents').findOne({ _id: s.pending }, { session });
      await this.hook('resolve:read');
      await this.c('sessions').updateOne({ _id: id, revision: s.revision }, {
        $unset: { pending: '' }, $inc: { revision: 1 },
      }, { session }); await this.hook('resolve:session');
      await this.c('intents').updateOne({ _id: intent._id, state: 'pending' }, { $set: { state: 'aborted' } }, { session }); await this.hook('resolve:intent');
      await this.c('keys').updateMany({ intentId: intent._id }, { $set: { state: 'aborted' } }, { session }); await this.hook('resolve:key');
      return { outcome: 'aborted', generation: intent.generation, revision: s.revision + 1 };
    });
  }
  async expire(actor, id, now) {
    return this.tx(async session => {
      const s = await this.owned(actor, id, session);
      if (!['PREPARED', 'STARTED'].includes(s.state)) return s;
      if (s.pending) fail('COMMIT_UNKNOWN');
      if (now < s.deadline) fail('NOT_EXPIRED');
      await this.hook('expire:read');
      await this.c('sessions').updateOne({ _id: id, revision: s.revision }, {
        $set: { state: 'EXPIRED' }, $inc: { revision: 1 },
      }, { session }); await this.hook('expire:session');
      await this.c('slots').deleteOne({ ...slot(actor), attemptId: id }, { session }); await this.hook('expire:slot');
      return { state: 'EXPIRED' };
    });
  }
  async observe(actor, id, now) {
    await this.owned(actor, id);
    const result = await this.c('results').findOne({ attemptId: id });
    if (!result) fail('COMMIT_UNKNOWN');
    await this.c('observations').insertOne({ attemptId: id, now, reversed: now < result.guardAt }, {
      writeConcern: { w: 'majority', j: true },
    });
    return result;
  }
}
