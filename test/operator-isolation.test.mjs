import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { measurement } from '../tools/operator-publication/isolation/measure.mjs';
import { validateRequest } from '../tools/operator-publication/isolation/protocol.mjs';
import { digest, signingBytes } from '../tools/operator-publication/artifacts.mjs';
import { generateDaily, canonicalConfig, algorithmVersion } from '../lib/maze/engine.js';
import { publicationDocument } from '../services/publication/policy.js';
import { applyProduction } from '../tools/operator-publication/live-boundary.mjs';

function fixture() {
  const pairs = ['release', 'publish'].map(role => ({ role, ...generateKeyPairSync('ed25519') }));
  const seal = (payload, role) => ({ keyId: `fixture-${role}`, payload,
    signature: sign(null, signingBytes(payload), pairs.find(p => p.role === role).privateKey).toString('base64') });
  const measured = { sourceSha: 'a'.repeat(40), hash: 'b'.repeat(64) };
  const policy = { imageId: `sha256:${'c'.repeat(64)}`, target: { fixture: 'only' },
    keys: pairs.map(p => ({ keyId: `fixture-${p.role}`, role: p.role, publicKey: p.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') })) };
  const candidate = JSON.parse(JSON.stringify(publicationDocument(generateDaily({ date: '2026-06-01', seed: 'fortcuster-2026-06-01',
    version: algorithmVersion, config: canonicalConfig() }), new Date('2026-06-01T13:00:00.000Z'))));
  const release = seal({ kind: 'isolated-fixture-release-v1', sourceSha: measured.sourceSha, measurement: measured.hash, imageId: policy.imageId }, 'release');
  const approval = seal({ kind: 'isolated-fixture-approval-v1', approvalId: randomUUID(), date: candidate.date,
    candidateHash: digest(candidate), releaseHash: digest(release), targetHash: digest(policy.target) }, 'publish');
  return { request: { release, approval, candidate }, policy, measured, seal };
}

test('image measurement covers added/modified/deleted source and dependencies and rejects symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fc-measure-'));
  try {
    await mkdir(join(dir, 'node_modules')); await writeFile(join(dir, 'entry.mjs'), 'original');
    const original = await measurement(dir);
    await writeFile(join(dir, 'entry.mjs'), 'modified'); assert.notEqual(await measurement(dir), original);
    await writeFile(join(dir, 'entry.mjs'), 'original'); assert.equal(await measurement(dir), original);
    await writeFile(join(dir, 'node_modules', 'dependency.js'), 'modified'); assert.notEqual(await measurement(dir), original);
    await rm(join(dir, 'node_modules', 'dependency.js')); assert.equal(await measurement(dir), original);
    await symlink('/etc/passwd', join(dir, 'outside')); await assert.rejects(measurement(dir), /SOURCE_UNSAFE/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('isolated fixture requires separate release/publish signatures and measured source/image identity', () => {
  const f = fixture(); assert.equal(validateRequest(f.request, f.policy, f.measured).date, '2026-06-01');
  for (const key of ['sourceSha', 'measurement', 'imageId']) {
    const request = structuredClone(f.request);
    request.release = f.seal({ ...request.release.payload, [key]: '0'.repeat(64) }, 'release');
    assert.throws(() => validateRequest(request, f.policy, f.measured), /SOURCE_UNTRUSTED/);
  }
  const request = structuredClone(f.request); request.approval = f.seal(request.approval.payload, 'release');
  assert.throws(() => validateRequest(request, f.policy, f.measured), { code: 'CERTIFICATE_INVALID' });
});

test('request cannot introduce caller roots or change candidate, target, date or approval kind', () => {
  const f = fixture();
  const requestWithKeys = { ...f.request, keys: f.policy.keys };
  assert.throws(() => validateRequest(requestWithKeys, f.policy, f.measured));
  const changedCandidate = structuredClone(f.request); changedCandidate.candidate.seed = 'modified';
  assert.throws(() => validateRequest(changedCandidate, f.policy, f.measured), /APPROVAL_INVALID/);
  for (const [key, value] of [['targetHash', '0'.repeat(64)], ['date', '2026-06-02'], ['approvalId', '*'], ['kind', 'production-apply']]) {
    const request = structuredClone(f.request); request.approval = f.seal({ ...request.approval.payload, [key]: value }, 'publish');
    assert.throws(() => validateRequest(request, f.policy, f.measured), /APPROVAL_INVALID/);
  }
  const other = fixture();
  assert.throws(() => validateRequest(other.request, f.policy, f.measured), { code: 'CERTIFICATE_INVALID' });
});

test('fixture proof cannot authorize production apply', () => {
  const f = fixture(); assert.equal(applyProduction(f).code, 'LIVE_APPLY_BLOCKED');
});
