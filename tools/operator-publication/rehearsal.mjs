// Independent disposable-only operator protocol. Never imported by app/startup.
import { generateInWorker } from '../../services/publication/executor.js';
import { disposableOnly } from '../../services/publication/publisher.js';
import { publicationDocument, isPublished, validManifest } from '../../services/publication/policy.js';
import { generationIdentity } from '../../lib/maze/engine.js';
import { assessIndexReadiness } from '../../services/publication/readiness.js';
import { trustedInstant, fail } from '../../services/publication/ingress.js';
import { LIMITS, digest, canonical, limitsHash, explicitInput, targetShape, releaseContext, checkPlan, checkApproval } from './artifacts.mjs';
import { RehearsalLedger } from './ledger.mjs';

const snapshot = value => {
  const json = canonical(value);
  if (Buffer.byteLength(json) > LIMITS.maxArtifactBytes) throw fail('ARTIFACT_INVALID');
  return JSON.parse(json);
};
const content = document => Object.fromEntries(Object.entries(document).filter(([k]) => !['_id', 'publishedAt'].includes(k)));
function scope(model) {
  disposableOnly(model);
  const options = model.db.getClient().options;
  if (model.db.name !== 'fc_publication_synthetic_operator' || model.collection.name !== 'mazes'
      || options.hosts.length !== 1 || options.hosts[0].host !== '127.0.0.1' || options.replicaSet !== 'fcSynthetic'
      || options.retryWrites !== false || options.retryReads !== false || options.maxPoolSize !== 1
      || !Number.isInteger(options.waitQueueTimeoutMS) || options.waitQueueTimeoutMS < 1 || options.waitQueueTimeoutMS > 2000) throw fail('CREDENTIAL_SCOPE_REFUSED');
  return options.hosts[0];
}
export async function inspectDisposableTarget(model) {
  const host = scope(model), db = model.db.db;
  try {
    const meta = await db.command({ listCollections: 1, filter: { name: 'mazes', type: 'collection' }, cursor: { batchSize: 2 }, maxTimeMS: LIMITS.commandMs });
    const indexes = await db.command({ listIndexes: 'mazes', cursor: { batchSize: 16 }, maxTimeMS: LIMITS.commandMs });
    const row = meta.cursor?.firstBatch?.[0], uuid = row?.info?.uuid;
    if (meta.cursor?.id?.toString() !== '0' || !Array.isArray(meta.cursor.firstBatch) || meta.cursor.firstBatch.length !== 1
        || uuid?._bsontype !== 'Binary' || uuid.sub_type !== 4 || uuid.buffer?.length !== 16
        || indexes.cursor?.id?.toString() !== '0' || !Array.isArray(indexes.cursor.firstBatch) || indexes.cursor.firstBatch.length > 16) throw fail('TARGET_METADATA_INVALID');
    const ready = assessIndexReadiness({ mazes: indexes.cursor.firstBatch });
    if (!ready.checks.mazeDateUnique || !ready.checks.mazeArchive) throw fail('INDEX_NOT_READY');
    // Preserve compound key order; canonicalize all remaining options including
    // validator/validationLevel/validationAction/collation. No DDL or schema fixup.
    const normalized = indexes.cursor.firstBatch.map(i => ({ ...i, key: Object.entries(i.key) })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    if (Buffer.byteLength(canonical([normalized, row.options ?? {}])) > 65536) throw fail('TARGET_METADATA_INVALID');
    return { mode: 'disposable', host: host.host, port: host.port, replicaSet: 'fcSynthetic', database: model.db.name,
      collection: 'mazes', uuid: uuid.buffer.toString('hex'), indexesHash: digest(normalized), optionsHash: digest(row.options ?? {}) };
  } catch (e) { throw fail(['INDEX_NOT_READY', 'TARGET_METADATA_INVALID'].includes(e.code) ? e.code : 'TARGET_UNAVAILABLE'); }
}
async function generated(context, input, now) {
  const checked = releaseContext(context, now), safe = explicitInput(input, now);
  const { result, metrics } = await generateInWorker(safe, now);
  const document = publicationDocument(result, now);
  Object.assign(document.provenance, { releaseId: checked.status.releaseId, releaseDecisionHash: checked.status.decisionHash });
  if (!validManifest(document) || document.date !== safe.date || document.seed !== safe.seed
      || document.provenance.identityHash !== generationIdentity(safe).identityHash) throw fail('PREVIEW_MISMATCH');
  return { document, metrics, solver: { status: result.analysis.solution.status,
    minimumMoves: result.analysis.solution.minimumMoves, exploredStates: result.analysis.solution.exploredStates,
    analysisHash: digest(result.analysis) } };
}
export async function previewOperatorPublication({ context, input, target, notBefore, expiresAt, now }) {
  context = snapshot(context); input = snapshot(input); target = snapshot(target); targetShape(target);
  const at = trustedInstant(now), safe = explicitInput(input, at);
  const { document, metrics, solver } = await generated(context, safe, at);
  const plan = { schemaVersion: 1, kind: 'one-date-rehearsal-v1', sourceSha: context.sourceSha,
    releaseCertificateHash: digest(context.certificate), target, limitsHash, input: safe,
    identityHash: document.provenance.identityHash, gridHash: document.provenance.gridHash,
    contentHash: digest(content(document)), solver, notBefore, expiresAt };
  checkPlan(context, plan, at);
  return { plan, planHash: digest(plan), candidate: content(document), metrics };
}
const codes = new Set(['CERTIFICATE_INVALID', 'ARTIFACT_INVALID', 'TARGET_INVALID', 'PLAN_INVALID', 'APPROVAL_INVALID',
  'LIVE_PUBLICATION_NOT_AUTHORIZED', 'CREDENTIAL_SCOPE_REFUSED', 'PUBLICATION_DB_TIMEOUTS_REQUIRED', 'TARGET_DRIFT',
  'TARGET_UNAVAILABLE', 'TARGET_METADATA_INVALID', 'INDEX_NOT_READY', 'GENERATOR_TIMEOUT', 'GENERATOR_MEMORY_LIMIT',
  'GENERATION_EXHAUSTED', 'WORKER_RSS_MONITOR_UNAVAILABLE', 'GENERATOR_FAILED', 'GENERATOR_BUSY', 'GENERATOR_PROTOCOL',
  'PREVIEW_MISMATCH', 'DATE_COLLISION', 'WRITE_UNCERTAIN', 'VERIFICATION_UNAVAILABLE', 'CLOCK_REVERSED', 'OPERATION_TIMEOUT', 'APPROVAL_OR_DATE_SPENT',
  'LEDGER_UNSAFE', 'LEDGER_UNAVAILABLE', 'LEDGER_MISMATCH']);
const safeCode = e => codes.has(e?.code) ? e.code : 'OPERATOR_UNAVAILABLE';
function report(code, record) {
  return { schemaVersion: 1, mode: 'disposable-rehearsal', code,
    ...(record ? { approvalId: record.approvalId, planHash: record.planHash, date: record.date, sourceSha: record.sourceSha } : {}) };
}
export async function operateDisposable({ model, context, plan, approval, ledger, clock = () => new Date(), reconcile = false }) {
  let record, claimed = false, insertStarted = false;
  try {
    // Snapshot all authority before awaits; arbitrary caller mutations cannot
    // change signatures/target/candidate while generation or DB calls are pending.
    context = snapshot(context); plan = snapshot(plan); approval = snapshot(approval);
    const started = performance.now(); let last = -Infinity;
    const sample = () => {
      if (performance.now() - started > LIMITS.operationMs) throw fail('OPERATION_TIMEOUT');
      const now = trustedInstant(clock());
      if (now.getTime() < last) throw fail('CLOCK_REVERSED'); last = now.getTime(); return now;
    };
    const authority = checkApproval(context, plan, approval, sample(), reconcile);
    scope(model);
    if (!(ledger instanceof RehearsalLedger)) throw fail('LEDGER_UNSAFE');
    record = { approvalId: authority.payload.approvalId, date: plan.input.date, sourceSha: context.sourceSha,
      planHash: digest(plan), targetHash: digest(plan.target),
      namespaceHash: digest([plan.target.host, plan.target.port, plan.target.database, plan.target.collection]), gridHash: plan.gridHash };
    if (reconcile) await ledger.require(record);
    else await ledger.available(record);
    const target = await inspectDisposableTarget(model);
    if (digest(target) !== digest(plan.target)) throw fail('TARGET_DRIFT');
    const db = model.db.db, uuid = new model.db.base.mongo.Binary(Buffer.from(target.uuid, 'hex'), 4);
    const read = async () => {
      try {
        const result = await db.command({ find: 'mazes', collectionUUID: uuid, filter: { date: plan.input.date },
          limit: 1, batchSize: 1, singleBatch: true, maxTimeMS: LIMITS.commandMs, readConcern: { level: 'majority' } }, { readPreference: 'primary' });
        if (result.cursor?.id?.toString() !== '0' || !Array.isArray(result.cursor.firstBatch) || result.cursor.firstBatch.length > 1) throw fail('WRITE_UNCERTAIN');
        return result.cursor.firstBatch[0] ?? null;
      } catch { throw fail(insertStarted ? 'WRITE_UNCERTAIN' : 'VERIFICATION_UNAVAILABLE'); }
    };
    const verify = stored => {
      const now = sample();
      if (!isPublished(stored, now, authority.checked.policy) || digest(content(stored)) !== plan.contentHash
          || stored.publishedAt.toISOString() < plan.notBefore || stored.publishedAt.toISOString() >= plan.expiresAt
          || stored.publishedAt.toISOString() < authority.payload.approvedAt) throw fail('DATE_COLLISION');
    };
    const existing = await read();
    if (reconcile) {
      if (!existing) return report('NO_WINNER_UNCERTAIN', record);
      verify(existing); return report('VERIFIED_WINNER', record);
    }
    // All existing dates STOP, including matching grids. Reconciliation is a
    // separate read-only operation; approval reuse never starts another write.
    if (existing) throw fail('DATE_COLLISION');
    const rebuilt = await generated(context, plan.input, sample());
    if (digest(content(rebuilt.document)) !== plan.contentHash || digest(rebuilt.solver) !== digest(plan.solver)
        || rebuilt.document.provenance.gridHash !== plan.gridHash || rebuilt.document.provenance.identityHash !== plan.identityHash) throw fail('PREVIEW_MISMATCH');
    checkApproval(context, plan, approval, sample());
    if (digest(await inspectDisposableTarget(model)) !== digest(plan.target)) throw fail('TARGET_DRIFT');
    await ledger.claim(record); claimed = true;
    // Durable intent precedes the only write. Re-sample after filesystem waits.
    const at = sample(); checkApproval(context, plan, approval, at);
    rebuilt.document.publishedAt = at;
    if (!isPublished(rebuilt.document, at, authority.checked.policy)) throw fail('PREVIEW_MISMATCH');
    insertStarted = true; let acknowledged = false;
    try {
      const result = await db.command({ insert: 'mazes', collectionUUID: uuid, documents: [rebuilt.document], ordered: true,
        maxTimeMS: LIMITS.commandMs, writeConcern: { w: 'majority', wtimeout: LIMITS.commandMs } });
      acknowledged = result.ok === 1 && result.n === 1 && !result.writeErrors?.length && !result.writeConcernError;
    } catch { /* No driver or application write retry; exactly one reconciliation. */ }
    const stored = await read(); if (!stored) throw fail('WRITE_UNCERTAIN'); verify(stored);
    const result = report(acknowledged ? 'INSERTED_VERIFIED' : 'RECONCILED_VERIFIED', record);
    try { await ledger.finish(record, result); } catch { return report('VERIFIED_WINNER_AUDIT_UNAVAILABLE', record); }
    return result;
  } catch (e) {
    let code = safeCode(e);
    if (insertStarted && !['DATE_COLLISION', 'WRITE_UNCERTAIN'].includes(code)) code = 'WRITE_UNCERTAIN';
    const result = report(code, record);
    if (claimed) { try { await ledger.finish(record, result); } catch { /* Intent persists; never retry insert. */ } }
    return result;
  }
}
