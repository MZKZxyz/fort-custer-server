import { hash } from '../../lib/maze/engine.js';
import { validateDate, utcDate } from '../../lib/maze/dates.js';
import { plainKeys, fail } from './ingress.js';
import { createLegacyPolicy } from './legacy-policy.js';

const invalid = () => { throw fail('LEGACY_MANIFEST_INVALID'); };
const reference = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9/_:#.-]{0,191}$/.test(value);
const exactKeys = (value, keys) => {
  plainKeys(value, keys);
  if (Object.keys(value).length !== keys.length) invalid();
};
const instant = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  utcDate(value);
  return value;
};

export const legacyEntriesHash = manifest => hash(['fort-custer/legacy-publications-v1',
  manifest.policyVersion, manifest.entries.map(entry => ({ date: entry.date, gridHash: entry.gridHash,
    evidence: { publicationRef: entry.evidence.publicationRef, gridObservationRef: entry.evidence.gridObservationRef,
      observedAt: entry.evidence.observedAt } }))]);

// Approval is a reviewed release artifact, not a signature or a discovery mechanism.
export function validateLegacyManifest(manifest) {
  try {
    exactKeys(manifest, ['schemaVersion', 'policyVersion', 'status', 'approval', 'entries']);
    if (manifest.schemaVersion !== 1 || typeof manifest.policyVersion !== 'string'
        || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(manifest.policyVersion)
        || !Array.isArray(manifest.entries) || manifest.entries.length > 3660) invalid();
    if (manifest.status === 'unapproved') {
      if (manifest.approval !== null || manifest.entries.length) invalid();
    } else if (manifest.status === 'approved') {
      if (!manifest.entries.length) invalid();
      exactKeys(manifest.approval, ['decisionRef', 'approvedAt', 'entriesHash']);
      if (!reference(manifest.approval.decisionRef)) invalid();
      instant(manifest.approval.approvedAt);
      let previous = '';
      for (const entry of manifest.entries) {
        exactKeys(entry, ['date', 'gridHash', 'evidence']);
        validateDate(entry.date);
        if (entry.date <= previous || typeof entry.gridHash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.gridHash)) invalid();
        previous = entry.date;
        exactKeys(entry.evidence, ['publicationRef', 'gridObservationRef', 'observedAt']);
        if (!reference(entry.evidence.publicationRef) || !reference(entry.evidence.gridObservationRef)) invalid();
        instant(entry.evidence.observedAt);
        if (entry.date > entry.evidence.observedAt.slice(0, 10)
            || entry.evidence.observedAt > manifest.approval.approvedAt) invalid();
      }
      if (manifest.approval.entriesHash !== legacyEntriesHash(manifest)) invalid();
    } else invalid();
    const policy = createLegacyPolicy(manifest.entries.map(entry => ({ date: entry.date,
      gridHash: entry.gridHash, evidence: entry.evidence.publicationRef })));
    return Object.freeze({ policy, status: Object.freeze({ schemaVersion: 1, policyVersion: manifest.policyVersion,
      approved: manifest.status === 'approved', entryCount: manifest.entries.length,
      entriesHash: legacyEntriesHash(manifest) }) });
  } catch { throw fail('LEGACY_MANIFEST_INVALID'); }
}
