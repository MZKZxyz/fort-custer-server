// LOCAL SYNTHETIC MODEL ONLY. No AWS SDK, HTTP, MongoDB, URI or production adapter.
// SQLite is a cross-process atomicity fixture, not DynamoDB or Object Lock emulation.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkApproval, canonical, digest, signedPayload } from './artifacts.mjs';
import { exactKeys } from '../../services/publication/fresh-release.js';

const reject = code => { throw Object.assign(new Error(code), { code }); };
const clone = value => {
  const text = canonical(value);
  if (Buffer.byteLength(text) > 256 * 1024) reject('FIXTURE_INPUT_INVALID');
  return JSON.parse(text);
};
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
function file(root, name) {
  if (realpathSync(root) !== root || dirname(root) !== realpathSync(tmpdir()) || !basename(root).startsWith('fc18c-')) reject('FIXTURE_ROOT_INVALID');
  return join(root, name + '.sqlite');
}
function connect(root, name, readOnly = false) {
  const db = new DatabaseSync(file(root, name), { readOnly });
  db.exec('PRAGMA busy_timeout=2000');
  return db;
}
function immutable(db, table) {
  for (const operation of ['UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER no_${operation}_${table} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END`);
}

// Provisioning/disposal is performed only by test owner, never by a runtime job.
export function provisionAuthorityFixture(policy) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'fc18c-'));
  for (const name of ['authority', 'audit', 'maze']) {
    const db = connect(root, name);
    try {
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE metadata (body TEXT NOT NULL)');
      db.prepare('INSERT INTO metadata VALUES (?)').run(canonical({ syntheticOnly: true, resources: policy.resources }));
      if (name === 'authority') {
        db.exec('CREATE TABLE claims (approval TEXT PRIMARY KEY, namespace TEXT NOT NULL, date TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(namespace,date))');
        immutable(db, 'claims');
      } else if (name === 'audit') {
        db.exec('CREATE TABLE events (id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL)');
        immutable(db, 'events');
      } else {
        db.exec('CREATE TABLE target (uuid TEXT NOT NULL); CREATE TABLE submissions (id TEXT PRIMARY KEY); CREATE TABLE mazes (date TEXT PRIMARY KEY, body TEXT NOT NULL)');
        db.prepare('INSERT INTO target VALUES (?)').run(policy.target.uuid);
      }
    } finally { db.close(); }
  }
  return root;
}
function resources(db, policy) {
  const rows = db.prepare('SELECT body FROM metadata').all();
  if (rows.length !== 1 || canonical(JSON.parse(rows[0].body)) !== canonical({ syntheticOnly: true, resources: policy.resources })) reject('RESOURCE_DRIFT');
}
function intentFor(request, policy, now, reconcile = false) {
  exactKeys(request, ['plan', 'approval', 'image', 'binding']);
  const { payload } = checkApproval(policy.context, request.plan, request.approval, now, reconcile);
  const image = signedPayload(request.image, 'release', policy.context.keys);
  exactKeys(image, ['kind', 'sourceSha', 'imageId', 'releaseHash', 'resourcesHash']);
  if (image.kind !== 'authority-fixture-image-v1' || image.sourceSha !== policy.context.sourceSha
      || image.imageId !== policy.imageId || image.releaseHash !== digest(policy.context.certificate)
      || image.resourcesHash !== digest(policy.resources)) reject('RESOURCE_OR_IMAGE_DRIFT');
  const binding = signedPayload(request.binding, 'publish', policy.context.keys);
  exactKeys(binding, ['kind', 'approvalHash', 'imageHash', 'namespace', 'attemptId']);
  if (binding.kind !== 'authority-fixture-scope-v1' || binding.approvalHash !== digest(request.approval)
      || binding.imageHash !== digest(request.image) || binding.namespace !== policy.namespace || !uuid(binding.attemptId)
      || digest(request.plan.target) !== digest(policy.target)) reject('SCOPE_DRIFT');
  return { kind: 'authority-fixture-intent-v1', approvalId: payload.approvalId, namespace: binding.namespace,
    attemptId: binding.attemptId, date: payload.date, sourceSha: policy.context.sourceSha, imageId: policy.imageId,
    resourcesHash: digest(policy.resources), releaseHash: digest(policy.context.certificate), planHash: digest(request.plan),
    approvalHash: digest(request.approval), scopeHash: digest(request.binding), imageCertificateHash: digest(request.image),
    releaseSigner: policy.context.certificate.keyId, publishSigner: request.approval.keyId,
    limitsHash: request.plan.limitsHash, solverHash: digest(request.plan.solver),
    targetHash: digest(request.plan.target), uuid: request.plan.target.uuid, contentHash: request.plan.contentHash,
    gridHash: request.plan.gridHash, notBefore: request.plan.notBefore, expiresAt: request.plan.expiresAt };
}
function append(db, intent, kind, code = kind) {
  const body = { intent, code };
  db.prepare('INSERT INTO events VALUES (?,?,?)').run(`${intent.attemptId}:${kind}`, kind, canonical(body));
}
function target(db, intent) {
  const rows = db.prepare('SELECT uuid FROM target').all();
  if (rows.length !== 1 || rows[0].uuid !== intent.uuid) reject('TARGET_DRIFT');
}
function winner(db, intent) {
  target(db, intent);
  const row = db.prepare('SELECT body FROM mazes WHERE date=?').get(intent.date);
  if (!row) return 'NO_WINNER_UNCERTAIN';
  return canonical(JSON.parse(row.body)) === canonical({ uuid: intent.uuid, contentHash: intent.contentHash, planHash: intent.planHash })
    ? 'VERIFIED_WINNER' : 'CONFLICT_UNCERTAIN';
}
const known = new Set(['CERTIFICATE_INVALID', 'ARTIFACT_INVALID', 'PLAN_INVALID', 'APPROVAL_INVALID', 'TARGET_INVALID',
  'RESOURCE_DRIFT', 'RESOURCE_OR_IMAGE_DRIFT', 'SCOPE_DRIFT', 'TARGET_DRIFT', 'CLOCK_REVERSED', 'AUDIT_UNAVAILABLE', 'ATTEMPT_UNCERTAIN', 'APPROVAL_OR_DATE_SPENT']);

export async function runAuthorityFixture(root, trustedPolicy, input, { clock = () => new Date(), fault, phase = async () => {} } = {}) {
  let authority, audit, maze, intent, consumed = false, claiming = false, submitted = false, last = -Infinity;
  const sample = () => {
    const now = clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) reject('APPROVAL_INVALID');
    if (now.getTime() < last) reject('CLOCK_REVERSED');
    last = now.getTime(); return now;
  };
  const report = code => ({ mode: 'synthetic-authority-only', code });
  try {
    const policy = clone(trustedPolicy), request = clone(input);
    intent = intentFor(request, policy, sample());
    authority = connect(root, 'authority'); audit = connect(root, 'audit'); maze = connect(root, 'maze');
    for (const db of [authority, audit, maze]) resources(db, policy);
    // Fast refusal only; this read can NEVER authorize continuation. The write
    // transaction below independently rechecks both keys after lock acquisition.
    if (authority.prepare('SELECT 1 FROM claims WHERE approval=? OR (namespace=? AND date=?)').get(intent.approvalId, intent.namespace, intent.date)) reject('APPROVAL_OR_DATE_SPENT');
    if (audit.prepare('SELECT 1 FROM events WHERE id IN (?,?)').get(`${intent.attemptId}:PREPARED`, `${intent.attemptId}:UNCERTAIN`)) reject('ATTEMPT_UNCERTAIN');
    target(maze, intent);
    if (fault === 'prepared-audit') reject('AUDIT_UNAVAILABLE');
    append(audit, intent, 'PREPARED');
    await phase('PREPARED');
    claiming = true;
    // A single insert enforces BOTH unique constraints with the complete intent.
    // BEGIN IMMEDIATE serializes actual independent processes; never retry it.
    authority.exec('BEGIN IMMEDIATE');
    try {
      intentFor(request, policy, sample());
      if (authority.prepare('SELECT 1 FROM claims WHERE approval=? OR (namespace=? AND date=?)').get(intent.approvalId, intent.namespace, intent.date)) reject('APPROVAL_OR_DATE_SPENT');
      authority.prepare('INSERT INTO claims VALUES (?,?,?,?)').run(intent.approvalId, intent.namespace, intent.date, canonical(intent));
      authority.exec('COMMIT'); consumed = true;
    } catch (error) { if (authority.isTransaction) authority.exec('ROLLBACK'); throw error; }
    if (fault === 'claim-ack') { append(audit, intent, 'UNCERTAIN', 'CLAIM_UNCERTAIN'); return report('CLAIM_UNCERTAIN'); }
    await phase('CONSUMED'); // tests can kill this process; no resume API exists
    if (fault === 'intent-audit') reject('AUDIT_UNAVAILABLE');
    append(audit, intent, 'INTENT'); // retained acknowledged intent BEFORE submit
    await phase('INTENT');
    intentFor(request, policy, sample()); target(maze, intent);
    submitted = true;
    maze.prepare('INSERT INTO submissions VALUES (?)').run(randomUUID());
    if (fault !== 'insert-before-commit') {
      maze.prepare('INSERT INTO mazes VALUES (?,?)').run(intent.date, canonical({ uuid: intent.uuid, contentHash: intent.contentHash, planHash: intent.planHash }));
    }
    await phase('SUBMITTED');
    // Lost ACK never retries the insert, even if reconciliation cannot find it.
    const outcome = fault === 'read-unavailable' ? 'READ_UNCERTAIN' : winner(maze, intent);
    if (fault === 'result-audit') reject('AUDIT_UNAVAILABLE');
    const code = outcome === 'VERIFIED_WINNER' ? (fault === 'insert-ack' ? 'RECONCILED_VERIFIED' : 'INSERTED_VERIFIED') : outcome;
    append(audit, intent, 'RESULT', code);
    return report(code);
  } catch (error) {
    // Only fixed codes leave this fixture; no raw caught error, request or grid.
    const code = known.has(error?.code) ? error.code : submitted ? 'WRITE_UNCERTAIN' : claiming ? 'CLAIM_UNCERTAIN' : 'FIXTURE_UNAVAILABLE';
    if (audit && intent) { try { append(audit, intent, 'UNCERTAIN', code); } catch { /* retained PREPARED/INTENT still identifies incomplete outcome */ } }
    return report(code === 'AUDIT_UNAVAILABLE' && consumed ? 'AUDIT_UNCERTAIN' : code);
  } finally { authority?.close(); audit?.close(); maze?.close(); }
}

// Independent read-only recovery: no claim/insert/write database handles.
export function reconcileAuthorityFixture(root, trustedPolicy, input, now) {
  const dbs = [];
  try {
    const policy = clone(trustedPolicy), request = clone(input), intent = intentFor(request, policy, now, true);
    const [authority, audit, maze] = ['authority', 'audit', 'maze'].map(name => { const db = connect(root, name, true); dbs.push(db); return db; });
    for (const db of dbs) resources(db, policy);
    const claim = authority.prepare('SELECT body FROM claims WHERE approval=?').get(intent.approvalId);
    if (!claim || claim.body !== canonical(intent)) return 'INTENT_UNCERTAIN';
    for (const kind of ['PREPARED', 'INTENT']) {
      const row = audit.prepare('SELECT body FROM events WHERE id=?').get(`${intent.attemptId}:${kind}`);
      if (!row || row.body !== canonical({ intent, code: kind })) return 'INTENT_UNCERTAIN';
    }
    const outcome = winner(maze, intent);
    if (outcome !== 'VERIFIED_WINNER') return outcome;
    const result = audit.prepare('SELECT body FROM events WHERE id=?').get(`${intent.attemptId}:RESULT`);
    if (!result) return 'WINNER_VERIFIED_AUDIT_UNCERTAIN';
    const body = JSON.parse(result.body);
    return canonical(body.intent) === canonical(intent) && ['INSERTED_VERIFIED', 'RECONCILED_VERIFIED'].includes(body.code)
      ? outcome : 'WINNER_VERIFIED_AUDIT_UNCERTAIN';
  } catch { return 'RECONCILIATION_UNCERTAIN'; }
  finally { for (const db of dbs) db.close(); }
}

export function inspectAuthorityFixture(root) {
  const counts = {};
  for (const [name, tables] of [['authority', ['claims']], ['audit', ['events']], ['maze', ['submissions', 'mazes']]]) {
    const db = connect(root, name, true);
    try { for (const table of tables) counts[table] = db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n; }
    finally { db.close(); }
  }
  return counts;
}
