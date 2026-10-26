import { randomUUID } from 'node:crypto';
import { binding, hash, identity, operationScope } from './repository.js';
import { fail, matched } from './errors.js';
import { POLICY, PROTOCOL, systemClock, sample, timing } from './policy.js';
import { compileGrid, normalizeTranscript, ROUTE_POLICY } from './transcript.js';
import { RouteValidator } from './validator.js';
import { recordAcceptedDate } from './date-ledger.js';

const revision = (s, expected) => {
  if (expected === undefined) fail('IF_MATCH_REQUIRED', 428);
  if (expected !== s.revision) fail('SESSION_CHANGED');
};

export class PlayableService {
  constructor(repository, { clock = systemClock, policy = {}, validator = new RouteValidator(), admissionEnabled = false } = {}) {
    this.repo = repository; this.clock = clock; this.policy = Object.freeze({ ...POLICY, ...policy });
    this.validator = validator; this.admissionEnabled = admissionEnabled;
  }
  c(name) { return this.repo.c(name); }
  now() { const value = sample(this.clock); if (!value) fail('CLOCK_UNAVAILABLE', 503); return value; }
  admit() { if (!this.admissionEnabled) fail('ADMISSION_DISABLED', 503); }
  async effective(s, at, session) {
    if (s.pending) return { ...s, saveStatus: 'resolving' };
    if (!['PREPARED', 'STARTED'].includes(s.state) || at < s.deadline) return s;
    await this.repo.hook('expiry:read');
    matched(await this.c('sessions').updateOne({ _id: s._id, revision: s.revision }, {
      $set: { state: 'EXPIRED' }, $inc: { revision: 1 },
    }, { session }));
    await this.c('slots').deleteOne({ accountId: s.accountId, profileId: s.profileId, attemptId: s._id }, { session });
    return { ...s, state: 'EXPIRED', revision: s.revision + 1 };
  }
  effectiveNow(s, session) {
    return this.effective(s, s.pending || !['PREPARED', 'STARTED'].includes(s.state) ? 0 : this.now().at, session);
  }
  view(s) {
    return { protocol: PROTOCOL, attemptId: s._id, date: s.date, state: s.state, revision: s.revision,
      expiresAt: s.deadline, startedAt: s.startedAt ?? null, manifest: s.manifest, gridHash: s.gridHash,
      grid: s.grid, ...(s.state === 'PREPARED' ? { nonce: s.nonce } : {}),
      ...(s.saveStatus ? { saveStatus: s.saveStatus } : {}) };
  }
  async status(actor, id) {
    return this.repo.tx(async session => this.view(await this.effectiveNow(await this.repo.owned(actor, id, session), session)));
  }
  async create(actor, key, date) {
    const scope = operationScope(actor, 'create', key), digest = hash({ ...identity(actor), operation: 'create', date });
    const id = randomUUID();
    return this.repo.tx(async session => {
      await this.repo.account(actor, session);
      const prior = await this.c('keys').findOne(scope, { session }); binding(prior, digest);
      if (prior) return this.view(await this.effectiveNow(await this.repo.owned(actor, prior.attemptId, session), session));
      this.admit();
      await this.repo.account(actor, session, { mutable: true });
      const clock = this.now();
      if (date > new Date(clock.at).toISOString().slice(0, 10)) fail('MAZE_NOT_PUBLISHED', 404);
      const active = await this.c('slots').findOne(identity(actor), { session });
      if (active) {
        const old = await this.repo.owned(actor, active.attemptId, session);
        if ((await this.effective(old, clock.at, session)).state !== 'EXPIRED') fail('ACTIVE_SESSION');
      }
      const maze = await this.repo.db.collection('mazes').findOne({ date }, { session });
      if (!maze) fail('MAZE_NOT_FOUND', 404);
      const grid = compileGrid(maze.grid).rows, gridHash = hash(grid);
      const manifest = { ...ROUTE_POLICY, date, gridHash, mazeVersion: hash({ date, gridHash, seed: maze.seed }),
        abilityIds: [], runClass: 'standard', competitionVersion: 'cardinal-fire-standard-v1',
        scoringMethod: 'playable-receipt-v2', protocol: PROTOCOL };
      const s = { _id: id, ...identity(actor), date, grid, gridHash, manifest, manifestHash: hash(manifest),
        nonce: randomUUID(), state: 'PREPARED', revision: 1, generation: 0,
        preparedAt: clock.at, deadline: clock.at + this.policy.prepareMs };
      await this.c('sessions').insertOne(s, { session }); await this.repo.hook('create:session');
      await this.c('slots').insertOne({ ...identity(actor), attemptId: id }, { session });
      await this.c('keys').insertOne({ ...scope, hash: digest, attemptId: id }, { session });
      return this.view(s);
    });
  }
  async transition(actor, id, operation, key, payload, expectedRevision) {
    const scope = operationScope(actor, operation, key, id), digest = hash({ ...identity(actor), ...payload });
    return this.repo.tx(async session => {
      const s = await this.repo.owned(actor, id, session);
      const prior = await this.c('keys').findOne(scope, { session }); binding(prior, digest);
      if (prior) return this.view(await this.effectiveNow(s, session));
      await this.repo.account(actor, session, { mutable: true });
      if (operation === 'ready') this.admit();
      if (s.pending) fail('COMMIT_UNKNOWN', 503);
      revision(s, expectedRevision);
      if (!['PREPARED', 'STARTED'].includes(s.state)) fail('SESSION_TERMINAL');
      const clock = this.now();
      if (clock.at >= s.deadline) fail('SESSION_EXPIRED', 410);
      let change;
      if (operation === 'ready') {
        if (s.state !== 'PREPARED') fail('SESSION_CHANGED');
        if (payload.nonce !== s.nonce || payload.gridHash !== s.gridHash || payload.rulesVersion !== s.manifest.rulesVersion) fail('READY_BINDING');
        change = { state: 'STARTED', startedAt: clock.at, startClock: clock, deadline: clock.at + this.policy.playMs };
      } else change = { state: 'ABANDONED' };
      matched(await this.c('sessions').updateOne({ _id: id, revision: s.revision }, { $set: change, $inc: { revision: 1 } }, { session }));
      if (operation === 'abandon') await this.c('slots').deleteOne({ ...identity(actor), attemptId: id }, { session });
      await this.c('keys').insertOne({ ...scope, hash: digest, attemptId: id }, { session });
      return this.view({ ...s, ...change, revision: s.revision + 1 });
    });
  }
  async complete(actor, id, key, transcript, expectedRevision) {
    // Ownership precedes normalization, hashing, clock capture and worker work.
    const s = await this.repo.owned(actor, id);
    const normalized = normalizeTranscript(transcript);
    const digest = hash({ ...identity(actor), attemptId: id, operation: 'complete', transcriptHash: normalized.hash });
    const scope = operationScope(actor, 'complete', key);
    const prior = await this.c('keys').findOne(scope, { readConcern: { level: 'majority' } }); binding(prior, digest);
    const winner = await this.repo.winner(actor, id);
    if (winner) return this.bindWinner(actor, id, scope, digest, normalized.hash);
    // Capture once, before deterministic replay; internal retries retain this value.
    const receipt = this.now();
    let existing = s.pending ? await this.c('intents').findOne({ _id: s.pending }, { readConcern: { level: 'majority' } }) : null;
    if (existing && existing.hash !== digest) fail('KEY_CONFLICT');
    let validation;
    if (!existing) {
      this.admit();
      validation = await this.validator.validate(actor.accountId, s.grid, s.manifest, normalized.normalized);
    }
    const intake = await this.repo.tx(async session => {
      const current = await this.repo.owned(actor, id, session);
      const bound = await this.c('keys').findOne(scope, { session }); binding(bound, digest);
      const result = await this.c('results').findOne({ attemptId: id }, { session });
      if (result) {
        if (result.transcriptHash !== normalized.hash) fail('KEY_CONFLICT');
        await this.bindResultKey(scope, digest, result, bound, session);
        return { result };
      }
      if (current.pending) {
        const pending = await this.c('intents').findOne({ _id: current.pending }, { session });
        if (pending.hash !== digest) fail('KEY_CONFLICT');
        if (!bound || bound.intentId !== pending._id) await this.alias(current, pending, scope, digest, session);
        return { intentId: pending._id };
      }
      this.admit(); revision(current, expectedRevision);
      await this.repo.account(actor, session, { mutable: true });
      if (!bound && await this.c('keys').countDocuments({ attemptId: id, operation: 'complete' }, { session }) >= this.policy.maxKeysPerAttempt) fail('OPERATION_LIMIT', 429);
      if (current.state !== 'STARTED') fail('SESSION_TERMINAL');
      if (receipt.at >= current.deadline) fail('SESSION_EXPIRED', 410);
      if (!validation) fail('RETRY_REQUIRED', 503);
      if (validation.transcriptHash !== normalized.hash || current.manifestHash !== s.manifestHash || hash(current.grid) !== current.gridHash) fail('MANIFEST_CHANGED', 503);
      if (current.generation >= this.policy.maxGenerations) fail('RECOVERY_LIMIT', 503);
      const generation = current.generation + 1, intentId = `${id}:${generation}`;
      const bodyId = hash({ accountId: actor.accountId, attemptId: id, transcriptHash: normalized.hash });
      await this.c('transcripts').updateOne({ _id: bodyId }, { $setOnInsert: { ...identity(actor), attemptId: id,
        transcript: normalized.normalized, transcriptHash: normalized.hash } }, { upsert: true, session });
      const intent = { _id: intentId, ...identity(actor), attemptId: id, generation, bodyId,
        hash: digest, transcriptHash: normalized.hash, manifestHash: current.manifestHash, validation,
        receipt, state: 'pending', expectedRevision: current.revision + 1, guardChecks: {}, guardReversals: [] };
      await this.c('intents').insertOne(intent, { session }); await this.repo.hook('intake:intent');
      matched(await this.c('sessions').updateOne({ _id: id, revision: current.revision }, {
        $set: { pending: intentId, generation }, $inc: { revision: 1 },
      }, { session }));
      await this.c('keys').updateOne(scope, { $set: { hash: digest, attemptId: id, intentId, state: 'pending' } }, { upsert: true, session });
      return { intentId };
    });
    if (intake.result) return intake.result.response;
    return this.finish(actor, id, intake.intentId);
  }
  async alias(s, intent, scope, digest, session) {
    if (await this.c('keys').countDocuments({ attemptId: s._id, operation: 'complete' }, { session }) >= this.policy.maxKeysPerAttempt) fail('OPERATION_LIMIT', 429);
    matched(await this.c('sessions').updateOne({ _id: s._id, revision: s.revision }, { $inc: { revision: 1 } }, { session }));
    matched(await this.c('intents').updateOne({ _id: intent._id, state: 'pending' }, { $inc: { expectedRevision: 1 } }, { session }));
    await this.c('keys').updateOne(scope, { $set: { hash: digest, attemptId: s._id, intentId: intent._id, state: 'pending' } }, { upsert: true, session });
  }
  async bindResultKey(scope, digest, result, prior, session) {
    if (!prior && await this.c('keys').countDocuments({ attemptId: result.attemptId, operation: 'complete' }, { session }) >= this.policy.maxKeysPerAttempt) fail('OPERATION_LIMIT', 429);
    await this.c('keys').updateOne(scope, { $set: { hash: digest, attemptId: result.attemptId,
      intentId: result.intentId, state: 'completed', resultId: result._id } }, { session, upsert: true });
  }
  async bindWinner(actor, id, scope, digest, transcriptHash) {
    return this.repo.tx(async session => {
      await this.repo.owned(actor, id, session);
      const prior = await this.c('keys').findOne(scope, { session }); binding(prior, digest);
      const result = await this.c('results').findOne({ attemptId: id }, { session });
      if (!result) fail('COMMIT_UNKNOWN', 503);
      if (result.transcriptHash !== transcriptHash) fail('KEY_CONFLICT');
      await this.bindResultKey(scope, digest, result, prior, session);
      return result.response;
    });
  }
  async finish(actor, id, intentId) {
    const token = randomUUID(), path = `guardChecks.${token}`, reversals = new Set();
    const winner = await this.repo.tx(async session => {
      const s = await this.repo.owned(actor, id, session), result = await this.c('results').findOne({ attemptId: id }, { session });
      if (result) return result;
      await this.repo.account(actor, session, { mutable: true });
      const intent = await this.pending(s, intentId, session);
      if (Object.keys(intent.guardChecks).length >= this.policy.maxClockChecks) fail('CLOCK_REVIEW_REQUIRED', 503);
      matched(await this.c('sessions').updateOne({ _id: id, revision: s.revision }, { $inc: { revision: 1 } }, { session }));
      matched(await this.c('intents').updateOne({ _id: intentId, expectedRevision: s.revision }, {
        $set: { [path]: { state: 'unresolved' } }, $inc: { expectedRevision: 1 },
      }, { session }));
      return null;
    }, { notify: false });
    if (winner) return winner.response;
    await this.repo.hook('finish:admitted');
    try {
      const outcome = await this.repo.tx(async session => {
        const s = await this.repo.owned(actor, id, session), existingResult = await this.c('results').findOne({ attemptId: id }, { session });
        if (existingResult) {
          if (reversals.size) await this.recordReversals(s, intentId, path, reversals, session, existingResult);
          return existingResult.response;
        }
        const intent = await this.pending(s, intentId, session);
        await this.repo.hook('finish:read');
        const guard = this.now();
        if (guard.at < intent.receipt.at) reversals.add(guard.at);
        if (reversals.size) {
          await this.recordReversals(s, intentId, path, reversals, session);
          return { clockFailure: true };
        }
        if (guard.at >= s.deadline || intent.receipt.at >= s.deadline) fail('SESSION_EXPIRED', 410);
        if (hash(s.manifest) !== intent.manifestHash || hash(s.grid) !== s.gridHash) fail('MANIFEST_CHANGED', 503);
        const checks = { ...intent.guardChecks, [token]: { state: 'healthy', guard } };
        const clockDisposition = timing(s.startClock, intent.receipt, guard, checks, this.policy.maxUncertaintyMs);
        const resultId = `result:${id}`;
        const result = { _id: resultId, ...identity(actor), attemptId: id, date: s.date, intentId,
          validity: 'accepted', validationVersion: 'route-replay-v1', transcriptHash: intent.transcriptHash,
          manifestHash: s.manifestHash, startClock: s.startClock, receipt: intent.receipt, guard,
          guardChecks: checks, guardReversals: intent.guardReversals, timing: clockDisposition };
        // Serialize against existing version-checked User/profile mutations too.
        await this.repo.fenceAccount(actor, session);
        const collectible = await recordAcceptedDate(this.repo, actor, result, session);
        result.response = { protocol: PROTOCOL, attemptId: id, date: s.date, status: 'accepted',
          routeValidated: true, progress: { completed: true }, timing: clockDisposition, collectible,
          integrity: { tier: s.manifest.integrityTier, validator: s.manifest.validationPolicyVersion,
            label: clockDisposition.status === 'official' ? s.manifest.publicLabel : 'Route validated · untimed' } };
        await this.c('results').insertOne(result, { session }); await this.repo.hook('finish:result');
        matched(await this.c('intents').updateOne({ _id: intentId, state: 'pending', expectedRevision: s.revision }, {
          $set: { state: 'completed', resultId, guardChecks: checks },
        }, { session }));
        matched(await this.c('sessions').updateOne({ _id: id, revision: s.revision }, {
          $set: { state: 'COMPLETED', resultId }, $unset: { pending: '' }, $inc: { revision: 1 },
        }, { session }));
        await this.c('slots').deleteOne({ ...identity(actor), attemptId: id }, { session });
        await this.c('keys').updateMany({ intentId }, { $set: { state: 'completed', resultId } }, { session });
        await this.c('outbox').insertOne({ _id: resultId, resultId, type: 'receipt-accepted', version: 1 }, { session });
        return result.response;
      });
      if (outcome.clockFailure) fail('CLOCK_UNAVAILABLE', 503);
      await this.repo.hook('finish:committed');
      return outcome;
    } catch (error) {
      if (reversals.size) {
        const result = await this.repo.winner(actor, id).catch(() => fail('COMMIT_UNKNOWN', 503));
        if (result) return result.response;
        if (!['CLOCK_UNAVAILABLE', 'COMMIT_UNKNOWN', 'SESSION_CHANGED'].includes(error.code)) fail('CLOCK_EVIDENCE_UNAVAILABLE', 503);
      }
      throw error;
    }
  }
  async pending(s, intentId, session) {
    const intent = await this.c('intents').findOne({ _id: intentId, attemptId: s._id }, { session });
    if (s.state !== 'STARTED' || !intent || intent.state !== 'pending' || s.pending !== intentId || s.revision !== intent.expectedRevision) fail('SESSION_CHANGED');
    return intent;
  }
  async recordReversals(s, intentId, path, reversals, session, winner) {
    await this.repo.hook('clock:beforeEvidence');
    const intent = await this.c('intents').findOne({ _id: intentId, attemptId: s._id }, { session });
    if (!intent?.guardChecks[path.slice('guardChecks.'.length)]) fail('SESSION_CHANGED');
    matched(await this.c('sessions').updateOne({ _id: s._id, revision: s.revision }, { $inc: { revision: 1 } }, { session }));
    matched(await this.c('intents').updateOne({ _id: intentId, state: intent.state }, {
      $set: { [path]: { state: 'reversed', samples: [...reversals] }, expectedRevision: s.revision + 1 },
      $addToSet: { guardReversals: { $each: [...reversals] } },
    }, { session }));
    if (winner) await this.c('observations').updateOne({ _id: path }, {
      $setOnInsert: { attemptId: s._id, resultId: winner._id, type: 'late-precommit-evidence', reversals: [...reversals] },
    }, { upsert: true, session });
  }
  async result(actor, id) {
    const result = await this.repo.winner(actor, id);
    if (!result) fail('COMMIT_UNKNOWN', 503);
    return result.response;
  }
  async recover(actor, id) {
    return this.repo.tx(async session => {
      const s = await this.repo.owned(actor, id, session), result = await this.c('results').findOne({ attemptId: id }, { session });
      if (result) return result.response;
      if (!s.pending) return { outcome: 'no-pending', session: this.view(await this.effectiveNow(s, session)) };
      const intent = await this.pending(s, s.pending, session);
      await this.repo.hook('recover:read');
      matched(await this.c('sessions').updateOne({ _id: id, revision: s.revision }, { $unset: { pending: '' }, $inc: { revision: 1 } }, { session }));
      matched(await this.c('intents').updateOne({ _id: intent._id, state: 'pending' }, { $set: { state: 'aborted' } }, { session }));
      await this.c('keys').updateMany({ intentId: intent._id }, { $set: { state: 'aborted' } }, { session });
      return { outcome: 'aborted', revision: s.revision + 1, retrySameOperation: true };
    });
  }
}
