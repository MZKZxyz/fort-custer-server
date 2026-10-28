import { hash } from '../../lib/maze/engine.js';
import { validateDate } from '../../lib/maze/dates.js';
import { plainKeys, trustedInstant, fail } from './ingress.js';

export function exactKeys(value, keys) {
  plainKeys(value, keys);
  if (Object.keys(value).length !== keys.length) throw fail('INVALID_APPROVAL');
}
export const auditRef = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9/_:#.-]{0,191}$/.test(value);
export function utcInstant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw fail('INVALID_APPROVAL');
  validateDate(value.slice(0, 10));
  return value;
}
export const releaseDecisionHash = m => hash(['fort-custer/fresh-release-v1', m.schemaVersion,
  m.scope, m.releaseId, m.startDate, m.startsAt, m.approval.decisionRef, m.approval.approvedAt]);

// Source review is the trust root. The digest binds intent; it is NOT a signature.
// Runtime cannot authenticate an owner or resist an attacker who can replace code.
export function validateFreshRelease(manifest, now) {
  try {
    exactKeys(manifest, ['schemaVersion', 'status', 'scope', 'releaseId', 'startDate', 'startsAt', 'approval']);
    if (manifest.schemaVersion !== 1 || manifest.scope !== 'fresh-only-no-legacy') throw fail('INVALID_APPROVAL');
    const approved = manifest.status === 'approved-fresh';
    if (manifest.status === 'pending') {
      if ([manifest.releaseId, manifest.startDate, manifest.startsAt, manifest.approval].some(v => v !== null)) throw fail('INVALID_APPROVAL');
    } else if (approved) {
      if (typeof manifest.releaseId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(manifest.releaseId)) throw fail('INVALID_APPROVAL');
      validateDate(manifest.startDate); utcInstant(manifest.startsAt);
      exactKeys(manifest.approval, ['decisionRef', 'approvedAt', 'decisionHash']);
      utcInstant(manifest.approval.approvedAt);
      if (!auditRef(manifest.approval.decisionRef) || manifest.startDate !== manifest.startsAt.slice(0, 10)
          || manifest.approval.approvedAt > manifest.startsAt
          || Date.parse(manifest.approval.approvedAt) > trustedInstant(now).getTime()
          || manifest.approval.decisionHash !== releaseDecisionHash(manifest)) throw fail('INVALID_APPROVAL');
    } else throw fail('INVALID_APPROVAL');
    const releaseId = manifest.releaseId, decisionHash = manifest.approval?.decisionHash;
    const startDate = manifest.startDate, startsAt = manifest.startsAt;
    // Capture immutable primitives, never a mutable caller-owned manifest.
    const policy = Object.freeze({ dates: Object.freeze([]), matches: () => false,
      modernMatches: maze => approved && maze.date >= startDate
        && maze.publishedAt instanceof Date && maze.publishedAt.getTime() >= Date.parse(startsAt)
        && maze.provenance?.releaseId === releaseId && maze.provenance?.releaseDecisionHash === decisionHash,
      modernFilter: () => approved ? { date: { $gte: startDate },
        publishedAt: { $gte: new Date(startsAt) },
        'provenance.releaseId': releaseId, 'provenance.releaseDecisionHash': decisionHash }
        : { 'provenance.releaseId': { $in: [] } },
    });
    return Object.freeze({ policy, status: Object.freeze({ schemaVersion: 1, approved, releaseId,
      startDate, startsAt, decisionHash, scope: manifest.scope }) });
  } catch { throw fail('FRESH_RELEASE_INVALID'); }
}
