// Ephemeral synthetic authority, never imported by production/app/CLI.
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { freshFixture } from './fresh-fixtures.mjs';
import { signingBytes, digest } from '../operator-publication/artifacts.mjs';
export const fixtureNow = new Date('2026-06-01T13:00:00.000Z');
export function operatorFixture() {
  const releaseSigner = generateKeyPairSync('ed25519'), publishSigner = generateKeyPairSync('ed25519');
  const keys = [['synthetic-release', 'release', releaseSigner], ['synthetic-publish', 'publish', publishSigner]].map(([keyId, role, pair]) => ({
    keyId, role, publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  }));
  const seal = (payload, role) => ({ keyId: role === 'release' ? 'synthetic-release' : 'synthetic-publish', payload,
    signature: sign(null, signingBytes(payload), (role === 'release' ? releaseSigner : publishSigner).privateKey).toString('base64') });
  const release = freshFixture(), sourceSha = 'daf455a61aed7d83eb3f0bfc115044db1e46d992';
  const certificate = seal({ schemaVersion: 1, kind: 'operator-release-rehearsal-v1', sourceSha,
    releaseDecisionHash: release.approval.decisionHash, decisionRef: 'synthetic/release-authority', approvedAt: '2026-06-01T12:00:00.000Z' }, 'release');
  const context = { sourceSha, release, certificate, keys };
  const approve = plan => seal({ schemaVersion: 1, kind: 'one-date-rehearsal-approval-v1', approvalId: randomUUID(), sourceSha,
    releaseCertificateHash: digest(certificate), planHash: digest(plan), date: plan.input.date, decisionRef: 'synthetic/one-date-go',
    approvedAt: '2026-06-01T12:30:00.000Z', notBefore: plan.notBefore, expiresAt: plan.expiresAt }, 'publish');
  return { context, approve, seal };
}
