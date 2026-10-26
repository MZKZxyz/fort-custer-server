import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import { fail, matched, PlayableError } from './errors.js';

export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const COLLECTIONS = Object.freeze(['sessions', 'slots', 'keys', 'intents', 'transcripts', 'results',
  'outbox', 'observations', 'dateHistory', 'dateLedger', 'progress']);
export const operationScope = (actor, operation, key, id = '') => ({ accountId: actor.accountId,
  operation, key, scope: ['ready', 'abandon'].includes(operation) ? id : '' });
export const identity = actor => ({ accountId: actor.accountId, profileId: actor.profileId });
export const binding = (prior, digest) => { if (prior && prior.hash !== digest) fail('KEY_CONFLICT'); };

export class PlayableRepository {
  constructor(client, db, { hook = async () => {}, attempts = 8, commitAttempts = 3 } = {}) {
    this.client = client; this.db = db; this.hook = hook; this.attempts = attempts; this.commitAttempts = commitAttempts;
  }
  c(name) {
    if (!COLLECTIONS.includes(name)) throw new Error('Unknown playable collection');
    return this.db.collection(`fc_v2_${name}`);
  }
  // Explicit provisioning boundary; never called by the disabled application.
  async provision() {
    const hello = await this.db.admin().command({ hello: 1 });
    if (!hello.setName) fail('REPLICA_SET_REQUIRED', 503);
    for (const name of COLLECTIONS) {
      try { await this.db.createCollection(`fc_v2_${name}`); }
      catch (error) { if (error.code !== 48) throw error; }
    }
    await this.c('keys').createIndex({ accountId: 1, operation: 1, scope: 1, key: 1 }, { unique: true });
    await this.c('slots').createIndex({ accountId: 1, profileId: 1 }, { unique: true });
    await this.c('results').createIndex({ attemptId: 1 }, { unique: true });
    await this.c('intents').createIndex({ attemptId: 1, generation: 1 }, { unique: true });
    await this.c('keys').createIndex({ attemptId: 1, operation: 1 });
    await this.c('outbox').createIndex({ resultId: 1, type: 1 }, { unique: true });
    for (const name of ['dateLedger', 'dateHistory', 'progress']) {
      await this.c(name).createIndex({ accountId: 1, profileId: 1, date: 1 }, { unique: true });
    }
  }
  async tx(body, { notify = true } = {}) {
    for (let n = 0; n < this.attempts; n++) {
      const session = this.client.startSession();
      session.startTransaction({ readConcern: { level: 'snapshot' }, readPreference: 'primary',
        writeConcern: { w: 'majority', j: true, wtimeout: 5000 }, maxCommitTimeMS: 5000 });
      let committing = false;
      try {
        const value = await body(session);
        committing = true;
        for (let i = 0; ; i++) {
          try { await session.commitTransaction(); break; }
          catch (error) {
            if (!error.hasErrorLabel?.('UnknownTransactionCommitResult')) throw error;
            if (i + 1 >= this.commitAttempts) fail('COMMIT_UNKNOWN', 503);
          }
        }
        if (notify) await this.hook('afterCommit');
        return value;
      } catch (error) {
        if (error.code === 'COMMIT_UNKNOWN') throw error;
        if (!committing || error.hasErrorLabel?.('TransientTransactionError')) await session.abortTransaction().catch(() => {});
        if ((error.hasErrorLabel?.('TransientTransactionError') || error.code === 11000) && n + 1 < this.attempts) continue;
        if (error instanceof PlayableError) throw error;
        fail('SAVE_UNAVAILABLE', 503);
      } finally { await session.endSession(); }
    }
    fail('SAVE_UNAVAILABLE', 503);
  }
  async account(actor, session, { mutable = false } = {}) {
    const user = await this.db.collection('users').findOne({ _id: new mongoose.Types.ObjectId(actor.accountId),
      'subProfiles._id': new mongoose.Types.ObjectId(actor.profileId) }, { session, projection: { __v: 1 } });
    if (!user) fail('NOT_FOUND', 404);
    if (mutable && (!Number.isSafeInteger(user.__v) || user.__v < 0)) fail('PROFILE_VERSION_REQUIRED');
    return user;
  }
  async fenceAccount(actor, session) {
    const user = await this.account(actor, session, { mutable: true });
    matched(await this.db.collection('users').updateOne({ _id: user._id, __v: user.__v,
      'subProfiles._id': new mongoose.Types.ObjectId(actor.profileId) }, { $inc: { __v: 1 } }, { session }));
  }
  async owned(actor, id, session) {
    await this.account(actor, session);
    const value = await this.c('sessions').findOne({ _id: id, ...identity(actor) }, { session });
    if (!value) fail('NOT_FOUND', 404);
    return value;
  }
  async winner(actor, id) {
    await this.owned(actor, id);
    return this.c('results').findOne({ attemptId: id }, { readConcern: { level: 'majority' } });
  }
}
