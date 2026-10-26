import { randomInt } from 'node:crypto';
import mongoose from 'mongoose';
import RewardItem from '../../models/RewardItem.js';
import { hash, identity } from '../playable/repository.js';
import { fail, matched } from '../playable/errors.js';
import { recordAcceptedDate } from '../playable/date-ledger.js';

export const WRITER_VERSION = 'shared-date-v1';
const MAX_CATALOG = 4096, MAX_INVENTORY = 4096;
const reservedKeys = new Set(['__proto__', 'constructor', 'prototype']);
function storedInventory(value) {
  // Absence retains the User model's empty-map default; explicit null is data
  // corruption, not absence. Inspect native BSON values before any model casts.
  const rewards = value === undefined ? {} : value;
  if (!rewards || ![Object.prototype, null].includes(Object.getPrototypeOf(rewards))
    || Object.keys(rewards).length > MAX_INVENTORY
    || Object.entries(rewards).some(([key, quantity]) => !key || key.startsWith('$') || key.includes('.')
      || key.includes('\0') || reservedKeys.has(key) || !Number.isSafeInteger(quantity) || quantity < 0)) {
    fail('INVENTORY_REVIEW_REQUIRED', 503);
  }
  return rewards;
}
function catalogSnapshot(record) {
  if (typeof record.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(record.id) || reservedKeys.has(record.id)
    || Buffer.byteLength(JSON.stringify(record)) > 65536) fail('CATALOG_REVIEW_REQUIRED', 503);
  // Hydration alone casts malformed stored values and does not run validators.
  // Check raw scalar types first; use the actual schema for required/enums and
  // defaults. In particular only a missing marketValue receives its default.
  for (const [key, path] of Object.entries(RewardItem.schema.paths)) {
    if (!Object.hasOwn(record, key)) continue;
    if ((path.instance === 'String' && typeof record[key] !== 'string')
      || (path.instance === 'Number' && (typeof record[key] !== 'number' || !Number.isFinite(record[key])))) {
      fail('CATALOG_REVIEW_REQUIRED', 503);
    }
  }
  const document = RewardItem.hydrate(record);
  if (document.validateSync()) fail('CATALOG_REVIEW_REQUIRED', 503);
  return document.toObject();
}
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const certified = (epoch, states) => epoch?.version === WRITER_VERSION && states.includes(epoch.state)
  && typeof epoch.evidenceRef === 'string' && epoch.evidenceRef.length > 0
  && Number.isSafeInteger(epoch.revision) && epoch.revision >= 0 && Number.isSafeInteger(epoch.cutoverAt)
  && Number.isFinite(new Date(epoch.cutoverAt).getTime()) && validDate(epoch.legacyDateCeiling)
  && epoch.legacyDateCeiling >= new Date(epoch.cutoverAt).toISOString().slice(0, 10);
export const publicReward = reward => reward ? Object.fromEntries(['id', 'name', 'image', 'description', 'category', 'rarity', 'marketValue']
  .filter(key => Object.hasOwn(reward, key)).map(key => [key, reward[key]])) : null;

export class SharedRewards {
  constructor(repo, { epochId, choose = randomInt } = {}) { this.repo = repo; this.epochId = epochId; this.choose = choose; }
  async epoch(session) {
    const epoch = await this.repo.c('writerEpochs').findOne({ _id: this.epochId }, { session });
    if (!certified(epoch, ['active'])) fail('WRITER_EPOCH_UNAVAILABLE', 503);
    // A pause/drain writes this same document; old transactions cannot outlive it.
    matched(await this.repo.c('writerEpochs').updateOne({ _id: epoch._id, state: 'active', revision: epoch.revision },
      { $inc: { revision: 1 } }, { session }));
    return epoch;
  }
  async user(actor, session, { mutable = true } = {}) {
    const user = await this.repo.db.collection('users').findOne({ _id: new mongoose.Types.ObjectId(actor.accountId) }, { session });
    const index = user?.subProfiles?.findIndex(p => p._id.toString() === actor.profileId);
    if (!user || !Number.isInteger(index) || index < 0) fail('NOT_FOUND', 404);
    if (mutable && (!Number.isSafeInteger(user.__v) || user.__v < 0)) fail('PROFILE_VERSION_REQUIRED');
    return { user, index, profile: user.subProfiles[index] };
  }
  async provenance(actor, date, epoch, session) {
    const explicit = await this.repo.c('dateHistory').findOne({ ...identity(actor), date }, { session });
    if (explicit) return; // Explicit review/award/exhaustion always takes precedence.
    const origin = await this.repo.c('profileOrigins').findOne(identity(actor), { session });
    const originEpoch = origin && await this.repo.c('writerEpochs').findOne({ _id: origin.epochId }, { session });
    const bornCompatible = origin?.version === WRITER_VERSION && Number.isSafeInteger(origin.birthRevision) && origin.birthRevision > 0
      && certified(originEpoch, ['active', 'retired']) && originEpoch.revision >= origin.birthRevision;
    const maze = await this.repo.c('mazeOrigins').findOne({ date, version: WRITER_VERSION }, { session });
    const mazeEpoch = maze && await this.repo.c('writerEpochs').findOne({ _id: maze.epochId }, { session });
    const newCoveredDate = certified(mazeEpoch, ['active', 'retired']) && date > mazeEpoch.legacyDateCeiling && Number.isSafeInteger(maze.birthRevision)
      && maze.birthRevision > 0 && mazeEpoch.revision >= maze.birthRevision;
    if (bornCompatible || newCoveredDate) await this.repo.c('dateHistory').insertOne({ ...identity(actor), date,
      state: 'known-clear', evidenceRef: bornCompatible ? `profile-origin:${origin._id}` : `maze-origin:${maze._id}`,
      version: WRITER_VERSION, epochId: epoch._id }, { session });
  }
  async accept(actor, receipt, session) {
    // Validate accepted source/scope before any grant, including timing-held routes.
    if (receipt.validity !== 'accepted' || !validDate(receipt.date)) fail('VALIDITY_REQUIRED');
    const epoch = await this.epoch(session);
    const { user, profile, index } = await this.user(actor, session);
    await this.provenance(actor, receipt.date, epoch, session);
    const claim = await recordAcceptedDate(this.repo, actor, receipt, session);
    const scope = { ...identity(actor), date: receipt.date };
    let ledger = await this.repo.c('dateLedger').findOne(scope, { session });
    const changes = { [`subProfiles.${index}.collectibleWriterVersion`]: WRITER_VERSION };
    let grant = ledger.grantId && await this.repo.c('grants').findOne({ _id: ledger.grantId }, { session });
    if (ledger.state === 'claimed' && !grant) {
      const rewards = storedInventory(profile.rewards);
      const records = await this.repo.db.collection('rewarditems').find({}, { session }).sort({ id: 1 }).limit(MAX_CATALOG + 1).toArray();
      if (records.length > MAX_CATALOG || new Set(records.map(r => r.id)).size !== records.length) fail('CATALOG_REVIEW_REQUIRED', 503);
      // Validate the entire catalog, including owned/unselected candidates, before
      // deciding award or exhaustion. Never persist repaired catalog data here.
      const catalog = records.map(catalogSnapshot);
      const available = catalog.filter(r => !Object.hasOwn(rewards, r.id));
      const selected = available.length ? this.choose(available.length) : null;
      if (selected !== null && (!Number.isSafeInteger(selected) || selected < 0 || selected >= available.length)) fail('SELECTION_UNAVAILABLE', 503);
      const reward = selected === null ? null : available[selected];
      if (reward && Object.keys(rewards).length >= MAX_INVENTORY) fail('INVENTORY_REVIEW_REQUIRED', 503);
      if (reward) changes[`subProfiles.${index}.rewards.${reward.id}`] = 1;
      grant = { _id: ledger.grantId, ...scope, version: 'date-grant-v1', sourceResultId: ledger.firstResultId,
        status: reward ? 'awarded' : 'exhausted', reward, collectionComplete: !reward,
        selectionPolicy: 'uniform-unowned-v1', epochId: epoch._id };
      await this.repo.c('grants').insertOne(grant, { session }); await this.repo.hook('grant:record');
      const state = reward ? 'consumed' : 'exhausted';
      matched(await this.repo.c('dateLedger').updateOne({ _id: ledger._id, revision: ledger.revision, state: 'claimed' },
        { $set: { state }, $inc: { revision: 1 } }, { session }));
      ledger = { ...ledger, state, revision: ledger.revision + 1 };
      matched(await this.repo.c('outbox').updateOne({ _id: ledger.grantId, type: 'date-grant-requested' }, {
        $set: { state: 'settled', grantId: grant._id, ledgerRevision: ledger.revision },
      }, { session }));
      await this.repo.c('outbox').insertOne({ _id: `settled:${grant._id}`, resultId: ledger.firstResultId,
        type: 'date-grant-settled', grantId: grant._id, ledgerId: ledger._id, ledgerRevision: ledger.revision,
        state: 'pending', version: 'collectible-delivery-v1' }, { session }); await this.repo.hook('grant:outbox');
    }
    if (['consumed', 'exhausted'].includes(ledger.state) && !grant) fail('GRANT_REVIEW_REQUIRED', 503);
    if (grant && !['consumed', 'exhausted'].includes(ledger.state)) fail('GRANT_REVIEW_REQUIRED', 503);
    matched(await this.repo.db.collection('users').updateOne({ _id: user._id, __v: user.__v,
      [`subProfiles.${index}._id`]: profile._id }, { $set: changes, $inc: { __v: 1 } }, { session }));
    await this.repo.hook('grant:inventory');
    if (!grant) return { view: claim, grant: null };
    return { grant, view: { version: 'date-grant-v1', status: grant.status, opportunityId: grant._id,
      reward: publicReward(grant.reward), collectionComplete: grant.collectionComplete,
      message: grant.status === 'awarded' ? 'This date’s collectible is saved.' : 'This date’s collectible opportunity is complete; no unowned item remained.' } };
  }
  async acknowledge(eventId, consumer = 'collectible-view-v1') {
    if (consumer !== 'collectible-view-v1') fail('DELIVERY_CONSUMER');
    const result = await this.repo.tx(async session => {
      const event = await this.repo.c('outbox').findOne({ _id: eventId, type: 'date-grant-settled' }, { session });
      if (!event) fail('DELIVERY_NOT_FOUND', 404);
      const prior = await this.repo.c('deliveries').findOne({ eventId, consumer }, { session });
      if (prior) return prior;
      const grant = await this.repo.c('grants').findOne({ _id: event.grantId }, { session });
      const ledger = await this.repo.c('dateLedger').findOne({ _id: event.ledgerId }, { session });
      if (!grant || ledger?.grantId !== grant._id || ledger.revision !== event.ledgerRevision
        || !['consumed', 'exhausted'].includes(ledger.state)) fail('STALE_GRANT_EVENT');
      const delivery = { _id: hash({ eventId, consumer }), eventId, consumer, grantId: grant._id };
      await this.repo.c('deliveries').insertOne(delivery, { session });
      matched(await this.repo.c('outbox').updateOne({ _id: eventId, state: 'pending' }, { $set: { state: 'acked' } }, { session }));
      await this.repo.hook('delivery:write'); return delivery;
    });
    await this.repo.hook('delivery:committed'); return result;
  }
}
