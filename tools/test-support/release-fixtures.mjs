import { legacyEntriesHash } from '../../services/publication/legacy-manifest.js';
import { hash } from '../../lib/maze/engine.js';

export function approvedFixture() {
  const manifest = { schemaVersion: 1, policyVersion: 'synthetic-legacy-v1', status: 'approved',
    approval: { decisionRef: 'synthetic-owner-decision', approvedAt: '2025-06-01T00:00:00.000Z', entriesHash: '' },
    entries: [{ date: '2025-05-26', gridHash: hash([['S', ' ', 'E']]), evidence: {
      publicationRef: 'synthetic-release-confirmation', gridObservationRef: 'synthetic-read-only-observation', observedAt: '2025-05-26T12:00:00.000Z',
    } }] };
  manifest.approval.entriesHash = legacyEntriesHash(manifest);
  return manifest;
}
