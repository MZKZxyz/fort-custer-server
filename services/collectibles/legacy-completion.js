import mongoose from 'mongoose';
import { hash } from '../playable/repository.js';
import { fail, matched } from '../playable/errors.js';

// Wire/timing compatible adapter; selection and inventory live only in SharedRewards.
export class CompatibleLegacyCompletion {
  constructor(rewards) { this.rewards = rewards; this.repo = rewards.repo; }
  async load(actor, date, attemptId, selectedIndex, session) {
    const state = await this.rewards.user(actor, session, { mutable: false });
    const attempts = state.profile.attempts?.[date] || [];
    const index = selectedIndex ?? (attemptId === undefined ? attempts.length - 1 : attempts.findIndex(a => a.attemptId === attemptId));
    const attempt = attempts[index];
    if (!attempt || (attemptId !== undefined && attempt.attemptId !== attemptId)) fail('INVALID_ATTEMPT', 400);
    return { ...state, attempts, attempt, attemptIndex: index };
  }
  async complete(userId, { subProfileId, date, attemptId }, receivedAt = new Date()) {
    if (!mongoose.isObjectIdOrHexString(userId) || !mongoose.isObjectIdOrHexString(subProfileId)) fail('NOT_FOUND', 404);
    if (attemptId !== undefined && (typeof attemptId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(attemptId))) fail('INVALID_ATTEMPT', 400);
    const actor = { accountId: userId.toString(), profileId: subProfileId.toString() };
    let selectedIndex;
    const intake = await this.repo.tx(async session => {
      // Replay before epoch/version mutation: historical snapshots are read-only.
      const state = await this.load(actor, date, attemptId, selectedIndex, session);
      selectedIndex = state.attemptIndex;
      if (state.attempt.result) return { response: state.attempt.result };
      if (state.attempt.completed) fail('LEGACY_COMPLETED');
      await this.rewards.user(actor, session);
      const started = new Date(state.attempt.started).getTime();
      if (!Number.isFinite(started) || started > receivedAt.getTime()) fail('INVALID_ATTEMPT', 400);
      if (state.attempt.expiresAt && receivedAt >= state.attempt.expiresAt) fail('ATTEMPT_EXPIRED', 410);
      if (receivedAt.getTime() - started < 3000) fail('TOO_FAST', 400);
      await this.rewards.epoch(session);
      const target = state.attempt.attemptId ? { attemptId: state.attempt.attemptId } : { attemptIndex: selectedIndex, started };
      const resultId = `legacy:${hash({ ...actor, date, target })}`;
      const saved = await this.repo.c('legacyReceipts').findOne({ _id: resultId }, { session });
      if (saved) return { response: saved.response };
      let intent = await this.repo.c('legacyIntents').findOne({ _id: resultId }, { session });
      if (!intent || intent.state === 'aborted') {
        if (intent?.generation >= 8) fail('RECOVERY_LIMIT', 503);
        intent = { _id: resultId, ...actor, date, attemptIndex: selectedIndex, attemptId: state.attempt.attemptId ?? null, started,
          receiptAt: receivedAt.getTime(), generation: (intent?.generation ?? 0) + 1, state: 'pending' };
        await this.repo.c('legacyIntents').replaceOne({ _id: resultId }, intent, { upsert: true, session });
      }
      return { intent };
    });
    if (intake.response) return intake.response;
    await this.repo.hook('legacy:admitted');
    const original = intake.intent;
    const result = await this.repo.tx(async session => {
      let state = await this.load(actor, date, attemptId, selectedIndex, session);
      if (state.attempt.result) return state.attempt.result;
      const intent = await this.repo.c('legacyIntents').findOne({ _id: original._id }, { session });
      if (intent?.state !== 'pending' || intent.generation !== original.generation) fail('SESSION_CHANGED');
      await this.repo.hook('legacy:read');
      const receipt = { _id: intent._id, ...actor, date, validity: 'accepted', validationVersion: 'legacy-compat-v1' };
      const outcome = await this.rewards.accept(actor, receipt, session);
      // Read our grant's User/version write before updating embedded legacy state.
      state = await this.load(actor, date, attemptId, selectedIndex, session);
      const duration = ((intent.receiptAt - intent.started) / 1000).toFixed(3);
      const response = { message: 'Maze complete', time: duration, reward: outcome.grant?.reward ?? null,
        today: new Date(intent.receiptAt).toISOString().slice(0, 10), ...(state.attempt.attemptId ? { attemptId: state.attempt.attemptId } : {}) };
      const attempts = [...state.attempts]; attempts[selectedIndex] = { ...state.attempt, completed: true, time: Number(duration), result: response };
      matched(await this.repo.db.collection('users').updateOne({ _id: state.user._id, __v: state.user.__v,
        [`subProfiles.${state.index}._id`]: state.profile._id }, { $set: {
        [`subProfiles.${state.index}.attempts.${date}`]: attempts,
        [`subProfiles.${state.index}.progress.${date}`]: { completed: true, time: duration },
      }, $inc: { __v: 1 } }, { session }));
      await this.repo.hook('legacy:result');
      matched(await this.repo.c('legacyIntents').updateOne({ _id: intent._id, state: 'pending', generation: intent.generation },
        { $set: { state: 'completed' } }, { session }));
      await this.repo.c('legacyReceipts').insertOne({ ...receipt, response, receiptAt: intent.receiptAt, generation: intent.generation }, { session });
      await this.repo.c('outbox').insertOne({ _id: intent._id, resultId: intent._id, type: 'legacy-receipt-accepted', version: 1 }, { session });
      return response;
    });
    await this.repo.hook('legacy:committed'); return result;
  }
  async recover(actor, resultId) {
    return this.repo.tx(async session => {
      await this.repo.account(actor, session);
      const intent = await this.repo.c('legacyIntents').findOne({ _id: resultId, ...actor }, { session });
      if (!intent) fail('NOT_FOUND', 404);
      const receipt = await this.repo.c('legacyReceipts').findOne({ _id: resultId }, { session });
      if (receipt) return receipt.response;
      const state = await this.load(actor, intent.date, intent.attemptId ?? undefined, intent.attemptIndex, session);
      if (state.attempt.result) return state.attempt.result;
      if (state.attempt.completed) fail('LEGACY_COMPLETED');
      if (intent.state !== 'pending') return { outcome: intent.state };
      await this.repo.fenceAccount(actor, session);
      matched(await this.repo.c('legacyIntents').updateOne({ _id: resultId, state: 'pending', generation: intent.generation },
        { $set: { state: 'aborted' } }, { session }));
      return { outcome: 'aborted' };
    });
  }
}
