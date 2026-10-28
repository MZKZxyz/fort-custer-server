// Disposable-only rehearsal of a reviewed one-date publication. No live adapter,
// CLI apply mode, ambient URI, scheduler, or production authorization switch.
import { generateInWorker } from './executor.js';
import { disposableOnly } from './publisher.js';
import { publisherInput, trustedInstant, fail } from './ingress.js';
import { exactKeys, auditRef, utcInstant, validateFreshRelease } from './fresh-release.js';
import { publicationDocument, isPublished } from './policy.js';
import { generationIdentity, hash } from '../../lib/maze/engine.js';
import { assessIndexReadiness } from './readiness.js';

let active = false;
function explicitInput(input, now) {
  exactKeys(input, ['date', 'version', 'seed', 'config']);
  const safe = publisherInput(input, now);
  exactKeys(input.config, Object.keys(safe.config));
  return safe;
}
export const publicationPlanHash = p => hash(['fort-custer/one-date-plan-v1', p.schemaVersion,
  p.releaseDecisionHash, p.input.date, p.input.version, p.input.seed,
  generationIdentity(p.input).configHash, p.identityHash, p.gridHash, p.notBefore, p.expiresAt]);

export async function previewFreshPublication({ release, input, notBefore, expiresAt, now }) {
  const at = trustedInstant(now), checked = validateFreshRelease(release, at), safe = explicitInput(input, at);
  utcInstant(notBefore); utcInstant(expiresAt);
  if (!checked.status.approved || safe.date < checked.status.startDate
      || notBefore < checked.status.startsAt || safe.date > notBefore.slice(0, 10)
      || expiresAt <= notBefore || Date.parse(expiresAt) - Date.parse(notBefore) > 86400000) throw fail('PUBLICATION_SCOPE_REFUSED');
  const { result, metrics } = await generateInWorker(safe, at);
  const plan = { schemaVersion: 1, releaseDecisionHash: checked.status.decisionHash, input: safe,
    identityHash: result.identityHash, gridHash: result.gridHash, notBefore, expiresAt };
  // Deliberately does not create approval. Owner review must pin this exact hash.
  return { mode: 'disposable-review-required', plan, planHash: publicationPlanHash(plan),
    grid: result.maze.grid, analysis: result.analysis, metrics };
}

function approvedPlan(release, plan, approval, now) {
  try {
    exactKeys(plan, ['schemaVersion', 'releaseDecisionHash', 'input', 'identityHash', 'gridHash', 'notBefore', 'expiresAt']);
    exactKeys(approval, ['schemaVersion', 'scope', 'decisionRef', 'approvedAt', 'planHash']);
    const checked = validateFreshRelease(release, now), safe = explicitInput(plan.input, now);
    utcInstant(plan.notBefore); utcInstant(plan.expiresAt); utcInstant(approval.approvedAt);
    if (!checked.status.approved || plan.schemaVersion !== 1 || approval.schemaVersion !== 1
        || approval.scope !== 'one-date-disposable-insert' || !auditRef(approval.decisionRef)
        || plan.releaseDecisionHash !== checked.status.decisionHash
        || !/^[a-f0-9]{64}$/.test(plan.gridHash) || plan.identityHash !== generationIdentity(safe).identityHash
        || plan.input.date < checked.status.startDate || plan.input.date > plan.notBefore.slice(0, 10)
        || plan.notBefore < checked.status.startsAt || plan.expiresAt <= plan.notBefore
        || Date.parse(plan.expiresAt) - Date.parse(plan.notBefore) > 86400000
        || approval.approvedAt < release.approval.approvedAt || approval.approvedAt > now.toISOString()
        || now.toISOString() < plan.notBefore || now.toISOString() >= plan.expiresAt
        || approval.planHash !== publicationPlanHash(plan)) throw fail('INVALID_APPROVAL');
    return { checked, safe, expectedGridHash: plan.gridHash, expectedIdentityHash: plan.identityHash };
  } catch { throw fail('PUBLICATION_APPROVAL_REQUIRED'); }
}

export async function publishApprovedDisposable({ model, release, plan, approval, now }) {
  disposableOnly(model);
  // One explicitly owned loopback connection; disable driver's hidden write retry.
  const options = model.db.getClient().options;
  if (options.retryWrites !== false || options.retryReads !== false || options.maxPoolSize !== 1
      || !Number.isInteger(options.waitQueueTimeoutMS) || options.waitQueueTimeoutMS < 1
      || options.waitQueueTimeoutMS > 2000 || model.collection.name !== 'mazes') throw fail('PUBLICATION_DB_SCOPE_REQUIRED');
  const at = trustedInstant(now), { checked, safe, expectedGridHash, expectedIdentityHash } = approvedPlan(release, plan, approval, at);
  if (active) throw fail('PUBLICATION_BUSY');
  active = true;
  try {
    const db = model.db.db;
    let response, metadata;
    try {
      metadata = await db.command({ listCollections: 1, filter: { name: 'mazes', type: 'collection' },
        cursor: { batchSize: 2 }, maxTimeMS: 2000 });
      response = await db.command({ listIndexes: 'mazes', cursor: { batchSize: 16 }, maxTimeMS: 2000 });
    }
    catch { throw fail('PUBLICATION_INDEX_REQUIRED'); }
    const uuid = metadata.cursor?.firstBatch?.[0]?.info?.uuid;
    if (metadata.cursor?.id?.toString() !== '0' || !Array.isArray(metadata.cursor.firstBatch) || metadata.cursor.firstBatch.length !== 1
        || uuid?._bsontype !== 'Binary' || uuid.sub_type !== 4 || uuid.buffer?.length !== 16) throw fail('PUBLICATION_INDEX_REQUIRED');
    if (response.cursor?.id?.toString() !== '0' || !Array.isArray(response.cursor.firstBatch)
        || response.cursor.firstBatch.length > 16) throw fail('PUBLICATION_INDEX_REQUIRED');
    const indexes = assessIndexReadiness({ mazes: response.cursor.firstBatch });
    if (!indexes.checks.mazeDateUnique || !indexes.checks.mazeArchive) throw fail('PUBLICATION_INDEX_REQUIRED');
    const read = async () => {
      try {
        const result = await db.command({ find: 'mazes', collectionUUID: uuid, filter: { date: safe.date },
          limit: 1, batchSize: 1, singleBatch: true, maxTimeMS: 2000,
          readConcern: { level: 'majority' } }, { readPreference: 'primary' });
        if (result.cursor?.id?.toString() !== '0' || !Array.isArray(result.cursor.firstBatch)
            || result.cursor.firstBatch.length > 1) throw fail('PUBLICATION_UNCERTAIN');
        return result.cursor.firstBatch[0] ?? null;
      }
      catch { throw fail('PUBLICATION_UNCERTAIN'); }
    };
    const verify = stored => {
      if (!isPublished(stored, at, checked.policy)
          || stored.provenance.identityHash !== expectedIdentityHash || stored.provenance.gridHash !== expectedGridHash) throw fail('PUBLICATION_DATE_COLLISION');
      return stored;
    };
    const existing = await read();
    if (existing) return { created: false, reconciled: true, maze: verify(existing) };
    const { result, metrics } = await generateInWorker(safe, at);
    if (result.gridHash !== expectedGridHash || result.identityHash !== expectedIdentityHash) throw fail('PUBLICATION_PREVIEW_MISMATCH');
    const candidate = publicationDocument(result, at);
    Object.assign(candidate.provenance, { releaseId: checked.status.releaseId, releaseDecisionHash: checked.status.decisionHash });
    verify(candidate);
    let acknowledged = false;
    try {
      // UUID pins the existing namespace: a concurrent drop/recreate cannot make
      // insert implicitly create an unindexed collection or target a replacement.
      const result = await db.command({ insert: 'mazes', collectionUUID: uuid, documents: [candidate],
        ordered: true, maxTimeMS: 2000, writeConcern: { w: 'majority', wtimeout: 2000 } });
      acknowledged = result.ok === 1 && result.n === 1 && !result.writeErrors?.length && !result.writeConcernError;
    } catch { /* No write retry, even after network/ACK uncertainty. Reconcile once. */ }
    const stored = await read();
    if (!stored) throw fail('PUBLICATION_UNCERTAIN');
    return { created: acknowledged, reconciled: !acknowledged, maze: verify(stored), metrics };
  } finally { active = false; }
}
