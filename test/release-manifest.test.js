import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateLegacyManifest, legacyEntriesHash } from '../services/publication/legacy-manifest.js';
import { approvedFixture } from '../tools/test-support/release-fixtures.mjs';
import { hash } from '../lib/maze/engine.js';
import { legacyPolicy, legacyReleaseStatus, assertLegacyReleaseReady } from '../services/publication/legacy-runtime.js';
import { assessIndexReadiness, readIndexReadiness } from '../services/publication/readiness.js';

const validIndexes = {
  mazes: [{ key: { date: 1 }, unique: true }, { key: { publicationEra: 1, date: 1, publishedAt: 1 } }],
  users: [{ key: { email: 1 }, unique: true }], rewarditems: [{ key: { id: 1 }, unique: true }],
};

test('committed default has no invented inventory, denies all legacy matches, and blocks startup', () => {
  const source = JSON.parse(readFileSync(new URL('../config/legacy-publications.json', import.meta.url)));
  assert.equal(source.status, 'unapproved'); assert.deepEqual(source.entries, []);
  assert.equal(legacyReleaseStatus.approved, false); assert.equal(legacyReleaseStatus.entryCount, 0);
  assert.equal(legacyPolicy.matches('2025-05-26', hash([['S', ' ', 'E']])), false);
  assert.throws(assertLegacyReleaseReady, { code: 'LEGACY_RELEASE_APPROVAL_REQUIRED' });
});

test('approved manifest pins exact versioned date/hash/evidence and cannot mutate the loaded policy', () => {
  const fixture = approvedFixture(), result = validateLegacyManifest(fixture);
  assert.deepEqual(result.policy.dates, ['2025-05-26']); assert.equal(result.status.approved, true);
  assert.equal(result.policy.matches(fixture.entries[0].date, fixture.entries[0].gridHash), true);
  fixture.entries[0].gridHash = '0'.repeat(64);
  assert.equal(result.policy.matches('2025-05-26', hash([['S', ' ', 'E']])), true);
  assert.equal(result.policy.matches('2025-05-27', hash([['S', ' ', 'E']])), false);
  assert.ok(Object.isFrozen(result.policy.dates));
  const reordered = approvedFixture(), entry = reordered.entries[0];
  reordered.entries[0] = { evidence: { observedAt: entry.evidence.observedAt,
    gridObservationRef: entry.evidence.gridObservationRef, publicationRef: entry.evidence.publicationRef }, gridHash: entry.gridHash, date: entry.date };
  assert.equal(legacyEntriesHash(reordered), result.status.entriesHash);
  assert.equal(validateLegacyManifest(reordered).status.approved, true);
});

test('malformed, unapproved, partial, stale, future-observed and ambiguous manifests fail closed', () => {
  for (const mutate of [
    m => { m.schemaVersion = 2; }, m => { m.status = 'unapproved'; }, m => { m.status = 'draft'; },
    m => { m.entries = []; }, m => { m.approval = null; }, m => { m.approval.entriesHash = '0'.repeat(64); },
    m => { m.entries[0].gridHash = 'A'.repeat(64); }, m => { m.entries[0].date = '2025-02-29'; },
    m => { m.entries[0].evidence.publicationRef = ''; }, m => { delete m.entries[0].evidence.gridObservationRef; },
    m => { m.entries[0].evidence.observedAt = '2025-06-02T00:00:00.000Z'; },
    m => { m.entries[0].evidence.observedAt = '2025-05-25T00:00:00.000Z'; },
    m => { m.approval.approvedAt = '2025-06-01T00:00:00+23:59'; },
    m => { m.entries.push(structuredClone(m.entries[0])); }, m => { m.typo = true; },
    m => { Object.defineProperty(m, 'hidden', { value: true }); }, m => { m[Symbol('hidden')] = true; },
    m => { Object.setPrototypeOf(m, { status: 'approved' }); }, m => { m.entries = Array(3661).fill(m.entries[0]); },
  ]) {
    const fixture = approvedFixture(); mutate(fixture);
    assert.throws(() => validateLegacyManifest(fixture), { code: 'LEGACY_MANIFEST_INVALID' });
  }
  for (const value of [undefined, null, [], new Date(), {}]) assert.throws(() => validateLegacyManifest(value), { code: 'LEGACY_MANIFEST_INVALID' });
});

test('index assessment accepts exact simple indexes, rejecting missing/partial/sparse/hidden/TTL/collation drift', () => {
  assert.equal(assessIndexReadiness(validIndexes).ready, true);
  for (const change of [{ unique: false }, { sparse: true }, { partialFilterExpression: { date: { $exists: true } } },
    { hidden: true }, { buildUUID: 'fixture-building' }, { expireAfterSeconds: 1 }, { collation: { locale: 'en' } }]) {
    const metadata = structuredClone(validIndexes); Object.assign(metadata.mazes[0], change);
    assert.equal(assessIndexReadiness(metadata).ready, false);
  }
  const wrongOrder = structuredClone(validIndexes); wrongOrder.mazes[1].key = { date: 1, publicationEra: 1, publishedAt: 1 };
  assert.equal(assessIndexReadiness(wrongOrder).ready, false);
  assert.equal(assessIndexReadiness({}).ready, false);
});

test('preflight issues only bounded listIndexes commands and never returns raw private metadata/errors', async () => {
  const calls = [], db = { command: async command => { calls.push(command); return { cursor: { id: 0,
    firstBatch: validIndexes[command.listIndexes].map(index => ({ ...index, name: 'private-canary' })) } }; } };
  const report = await readIndexReadiness(db); assert.equal(report.ready, true);
  assert.equal(calls.length, 3); assert.ok(calls.every(c => c.maxTimeMS === 2000 && c.cursor.batchSize === 16 && c.listIndexes));
  assert.ok(!JSON.stringify(report).includes('canary'));
  for (const command of [async () => { throw Error('private-canary'); },
    async () => ({ cursor: { id: 1, firstBatch: [] } }), async () => ({ cursor: { id: 0, firstBatch: Array(17).fill({}) } })]) {
    await assert.rejects(readIndexReadiness({ command }), { code: 'ARCHIVE_INDEX_CHECK_FAILED' });
  }
});
