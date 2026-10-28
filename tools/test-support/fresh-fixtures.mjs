// Synthetic approval only. Never imported by production modules or CLI.
import { releaseDecisionHash } from '../../services/publication/fresh-release.js';
export function freshFixture() {
  const manifest = { schemaVersion: 1, status: 'approved-fresh', scope: 'fresh-only-no-legacy',
    releaseId: 'synthetic-fresh-fixture', startDate: '2026-06-01', startsAt: '2026-06-01T12:00:00.000Z',
    approval: { decisionRef: 'synthetic/owner-decision', approvedAt: '2026-05-31T12:00:00.000Z', decisionHash: '' } };
  manifest.approval.decisionHash = releaseDecisionHash(manifest);
  return manifest;
}
