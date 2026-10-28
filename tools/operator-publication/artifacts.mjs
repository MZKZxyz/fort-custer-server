// Offline artifact validation. No database/client/environment/secret access.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { exactKeys, utcInstant, auditRef, validateFreshRelease } from '../../services/publication/fresh-release.js';
import { publisherInput, trustedInstant, fail } from '../../services/publication/ingress.js';
import { generationIdentity } from '../../lib/maze/engine.js';
import { WORKER_LIMITS } from '../../services/publication/executor.js';

export const LIMITS = Object.freeze({ commandMs: 2000, operationMs: 15000, maxArtifactBytes: 256 * 1024 });
export function canonical(value, depth = 0) {
  if (depth > 24) throw fail('ARTIFACT_INVALID');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length > 10240) throw fail('ARTIFACT_INVALID');
    if (Reflect.ownKeys(value).length !== value.length + 1) throw fail('ARTIFACT_INVALID');
    const items = [];
    for (let i = 0; i < value.length; i++) {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (!d?.enumerable || !Object.hasOwn(d, 'value')) throw fail('ARTIFACT_INVALID');
      items.push(canonical(d.value, depth + 1));
    }
    return '[' + items.join(',') + ']';
  }
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw fail('ARTIFACT_INVALID');
  const keys = Reflect.ownKeys(value);
  if (keys.some(k => typeof k !== 'string' || !Object.getOwnPropertyDescriptor(value, k).enumerable
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, k), 'value'))) throw fail('ARTIFACT_INVALID');
  return '{' + keys.sort().map(k => JSON.stringify(k) + ':' + canonical(value[k], depth + 1)).join(',') + '}';
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export const signingBytes = payload => Buffer.from(canonical(['fort-custer/operator-signature-v1', payload]));
export const limitsHash = digest({ worker: WORKER_LIMITS, operator: LIMITS });
export const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function signedPayload(envelope, role, keys) {
  try {
    exactKeys(envelope, ['keyId', 'payload', 'signature']);
    if (!auditRef(envelope.keyId) || typeof envelope.signature !== 'string'
        || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)) throw fail('CERTIFICATE_INVALID');
    if (!Array.isArray(keys) || keys.length > 8) throw fail('CERTIFICATE_INVALID');
    const roots = keys.map(key => {
      exactKeys(key, ['keyId', 'role', 'publicKey']);
      if (!auditRef(key.keyId) || !['release', 'publish'].includes(key.role)
          || typeof key.publicKey !== 'string' || key.publicKey.length > 128) throw fail('CERTIFICATE_INVALID');
      const bytes = Buffer.from(key.publicKey, 'base64');
      if (bytes.toString('base64') !== key.publicKey) throw fail('CERTIFICATE_INVALID');
      const publicKey = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
      if (publicKey.asymmetricKeyType !== 'ed25519') throw fail('CERTIFICATE_INVALID');
      // OpenSSL can accept multiple SPKI encodings of one key. Compare parsed,
      // canonically exported material for every root, including unselected ones.
      return { keyId: key.keyId, role: key.role, publicKey,
        identity: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
    });
    if (new Set(roots.map(k => k.keyId)).size !== roots.length
        || new Set(roots.map(k => k.identity)).size !== roots.length) throw fail('CERTIFICATE_INVALID');
    const matches = roots.filter(key => key.keyId === envelope.keyId && key.role === role);
    if (matches.length !== 1) throw fail('CERTIFICATE_INVALID');
    if (!verify(null, signingBytes(envelope.payload), matches[0].publicKey,
      Buffer.from(envelope.signature, 'base64'))) throw fail('CERTIFICATE_INVALID');
    return envelope.payload;
  } catch { throw fail('CERTIFICATE_INVALID'); }
}
export function releaseContext(context, now) {
  try {
    exactKeys(context, ['sourceSha', 'release', 'certificate', 'keys']);
    if (typeof context.sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(context.sourceSha)) throw fail('CERTIFICATE_INVALID');
    const checked = validateFreshRelease(context.release, now), payload = signedPayload(context.certificate, 'release', context.keys);
    exactKeys(payload, ['schemaVersion', 'kind', 'sourceSha', 'releaseDecisionHash', 'decisionRef', 'approvedAt']);
    utcInstant(payload.approvedAt);
    if (!checked.status.approved || payload.schemaVersion !== 1 || payload.kind !== 'operator-release-rehearsal-v1'
        || payload.sourceSha !== context.sourceSha || payload.releaseDecisionHash !== checked.status.decisionHash
        || !auditRef(payload.decisionRef) || payload.approvedAt < context.release.approval.approvedAt
        || payload.approvedAt > trustedInstant(now).toISOString()) throw fail('CERTIFICATE_INVALID');
    return checked;
  } catch { throw fail('CERTIFICATE_INVALID'); }
}
export function targetShape(target) {
  exactKeys(target, ['mode', 'host', 'port', 'replicaSet', 'database', 'collection', 'uuid', 'indexesHash', 'optionsHash']);
  if (target.mode !== 'disposable' || target.host !== '127.0.0.1' || target.replicaSet !== 'fcSynthetic'
      || target.database !== 'fc_publication_synthetic_operator' || target.collection !== 'mazes'
      || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535
      || !/^[a-f0-9]{32}$/.test(target.uuid) || !sha(target.indexesHash) || !sha(target.optionsHash)) throw fail('TARGET_INVALID');
}
export function explicitInput(input, now) {
  exactKeys(input, ['date', 'version', 'seed', 'config']);
  const safe = publisherInput(input, now);
  exactKeys(input.config, Object.keys(safe.config));
  return safe;
}
export function checkPlan(context, plan, now) {
  const checked = releaseContext(context, now);
  exactKeys(plan, ['schemaVersion', 'kind', 'sourceSha', 'releaseCertificateHash', 'target', 'limitsHash',
    'input', 'identityHash', 'gridHash', 'contentHash', 'solver', 'notBefore', 'expiresAt']);
  targetShape(plan.target);
  const safe = explicitInput(plan.input, now);
  utcInstant(plan.notBefore); utcInstant(plan.expiresAt);
  exactKeys(plan.solver, ['status', 'minimumMoves', 'exploredStates', 'analysisHash']);
  if (plan.schemaVersion !== 1 || plan.kind !== 'one-date-rehearsal-v1' || plan.sourceSha !== context.sourceSha
      || plan.releaseCertificateHash !== digest(context.certificate) || plan.limitsHash !== limitsHash
      || plan.identityHash !== generationIdentity(safe).identityHash || !sha(plan.gridHash) || !sha(plan.contentHash)
      || plan.input.date < checked.status.startDate || plan.input.date > plan.notBefore.slice(0, 10)
      || plan.notBefore < checked.status.startsAt || plan.expiresAt <= plan.notBefore
      || Date.parse(plan.expiresAt) - Date.parse(plan.notBefore) > 86400000
      || plan.solver.status !== 'solved' || !Number.isSafeInteger(plan.solver.minimumMoves) || plan.solver.minimumMoves < 1
      || !Number.isSafeInteger(plan.solver.exploredStates) || plan.solver.exploredStates < 1 || !sha(plan.solver.analysisHash)) throw fail('PLAN_INVALID');
  return { checked, safe };
}
export function checkApproval(context, plan, approval, now, reconcile = false) {
  const result = checkPlan(context, plan, now), payload = signedPayload(approval, 'publish', context.keys);
  exactKeys(payload, ['schemaVersion', 'kind', 'approvalId', 'sourceSha', 'releaseCertificateHash', 'planHash',
    'date', 'decisionRef', 'approvedAt', 'notBefore', 'expiresAt']);
  utcInstant(payload.approvedAt);
  if (approval.keyId === context.certificate.keyId || payload.schemaVersion !== 1 || payload.kind !== 'one-date-rehearsal-approval-v1'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(payload.approvalId)
      || payload.sourceSha !== context.sourceSha || payload.releaseCertificateHash !== plan.releaseCertificateHash
      || payload.planHash !== digest(plan) || payload.date !== plan.input.date || !auditRef(payload.decisionRef)
      || payload.approvedAt < context.certificate.payload.approvedAt || payload.approvedAt > now.toISOString()
      || payload.notBefore !== plan.notBefore || payload.expiresAt !== plan.expiresAt || payload.approvedAt >= plan.expiresAt
      || (!reconcile && (now.toISOString() < plan.notBefore || now.toISOString() >= plan.expiresAt))) throw fail('APPROVAL_INVALID');
  return { ...result, payload };
}
