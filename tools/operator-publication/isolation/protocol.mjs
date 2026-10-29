// Synthetic protocol only. No URI, production keys, ambient selectors or live adapter.
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { digest, signedPayload } from '../artifacts.mjs';
import { exactKeys } from '../../../services/publication/fresh-release.js';
import { validManifest } from '../../../services/publication/policy.js';
import { assessIndexReadiness } from '../../../services/publication/readiness.js';

export const database = 'fc_publication_synthetic_isolation';
export const socketUri = `mongodb://%2Fsocket%2Fmongodb-27017.sock/${database}?directConnection=true&replicaSet=fcIsolated`;
export async function client(auth) {
  // One sequential fixture operation per client; command <=2s, socket 3s,
  // selection/connect/queue 2s. Single member, no retry or transaction callback retry.
  const connection = new mongoose.mongo.MongoClient(auth ? socketUri : socketUri.replace('&replicaSet=fcIsolated', ''), { auth, authSource: 'admin',
    maxPoolSize: 1, minPoolSize: 0, waitQueueTimeoutMS: 2000, serverSelectionTimeoutMS: 2000,
    connectTimeoutMS: 2000, socketTimeoutMS: 3000, retryReads: false, retryWrites: false });
  await connection.connect(); return connection;
}
export function validateRequest(request, policy, measured) {
  exactKeys(request, ['release', 'approval', 'candidate']);
  const release = signedPayload(request.release, 'release', policy.keys);
  exactKeys(release, ['kind', 'sourceSha', 'measurement', 'imageId']);
  if (release.kind !== 'isolated-fixture-release-v1' || release.sourceSha !== measured.sourceSha
      || release.measurement !== measured.hash || release.imageId !== policy.imageId) throw Error('SOURCE_UNTRUSTED');
  const approval = signedPayload(request.approval, 'publish', policy.keys);
  exactKeys(approval, ['kind', 'approvalId', 'date', 'candidateHash', 'releaseHash', 'targetHash']);
  if (approval.kind !== 'isolated-fixture-approval-v1' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(approval.approvalId)
      || approval.date !== request.candidate.date || approval.candidateHash !== digest(request.candidate)
      || approval.releaseHash !== digest(request.release) || approval.targetHash !== digest(policy.target)) throw Error('APPROVAL_INVALID');
  if (!validManifest({ ...request.candidate, publishedAt: new Date(request.candidate.publishedAt) })) throw Error('APPROVAL_INVALID');
  return approval;
}
export async function target(db) {
  const rows = await db.listCollections({ name: 'mazes' }, { maxTimeMS: 2000 }).toArray();
  const indexes = await db.collection('mazes').listIndexes({ maxTimeMS: 2000 }).toArray();
  // Names are labels, not evidence of date uniqueness. Reuse the server's exact
  // key/options assessment; retain the full metadata fingerprint below.
  if (rows.length !== 1 || !assessIndexReadiness({ mazes: indexes }).checks.mazeDateUnique) throw Error('TARGET_INVALID');
  return { database, collection: 'mazes', uuid: rows[0].info.uuid.toString('hex'),
    optionsHash: digest(rows[0].options), indexesHash: digest(indexes.map(i => ({ ...i, key: Object.entries(i.key) }))) };
}
async function exactWinner(db, policy, date) {
  const result = await db.command({ find: 'mazes', collectionUUID: new mongoose.mongo.Binary(Buffer.from(policy.target.uuid, 'hex'), 4),
    filter: { date }, limit: 1, batchSize: 1, singleBatch: true, maxTimeMS: 2000, readConcern: { level: 'majority' } }, { readPreference: 'primary' });
  if (result.cursor?.id?.toString() !== '0' || !Array.isArray(result.cursor.firstBatch) || result.cursor.firstBatch.length > 1) throw Error('READ_UNCERTAIN');
  return result.cursor.firstBatch[0];
}
export async function writeFixture({ request, policy, measured, fault }) {
  const approval = validateRequest(request, policy, measured);
  const auth = JSON.parse(await readFile('/writer/auth.json', 'utf8'));
  const connection = await client(auth), db = connection.db(database);
  let consumed = false, insertStarted = false;
  // One document claims both uniqueness constraints, with its immutable intent.
  // Logical namespace/date stays spent across UUID, index or validator changes.
  const intent = { _id: approval.approvalId, namespace: `${database}/mazes`, date: approval.date,
    candidateHash: approval.candidateHash, targetHash: approval.targetHash };
  const readWinner = async () => {
    const row = await exactWinner(db, policy, approval.date);
    if (!row) return 'NO_WINNER_UNCERTAIN';
    const { _id, ...content } = row;
    return digest(content) === approval.candidateHash ? 'VERIFIED_WINNER' : 'DATE_COLLISION';
  };
  try {
    if (digest(await target(db)) !== digest(policy.target)) return 'TARGET_DRIFT';
    try {
      await db.collection('claims').insertOne(intent, { writeConcern: { w: 'majority', wtimeout: 2000 }, maxTimeMS: 2000 });
      // An uncertain commit NEVER authorizes an insert, even if claims are visible.
      consumed = true;
      if (fault === 'claim-ack') return 'CLAIM_UNCERTAIN';
      // Synthetic crash fixture only: hold after the real majority claim ACK.
      // A killed supervisor/container must never restore this consumed intent.
      if (fault === 'claim-hold') {
        await writeFile('/tmp/fc18a-claim-ack', 'ack', { mode: 0o600, flag: 'wx' });
        await new Promise(() => { setInterval(() => {}, 1000); });
      }
    } catch (error) {
      return error.code === 11000 ? 'APPROVAL_OR_DATE_SPENT' : 'CLAIM_UNCERTAIN';
    }
    if (fault === 'before-insert') return 'NO_WINNER_UNCERTAIN';
    if (digest(await target(db)) !== digest(policy.target)) return 'TARGET_DRIFT';
    // UUID protects namespace replacement; concurrent index/validator DDL still
    // requires a separate external fence. No DDL privilege is granted here.
    insertStarted = true; let acknowledged = false;
    try {
      const result = await db.command({ insert: 'mazes', collectionUUID: new mongoose.mongo.Binary(Buffer.from(policy.target.uuid, 'hex'), 4),
        documents: [request.candidate], maxTimeMS: 2000, writeConcern: { w: 'majority', wtimeout: 2000 } });
      acknowledged = result.ok === 1 && result.n === 1 && !result.writeErrors && !result.writeConcernError;
      if (fault === 'write-ack') acknowledged = false;
    } catch { /* Exactly one submit; only a majority read can resolve uncertainty. */ }
    const outcome = await readWinner();
    const code = outcome === 'VERIFIED_WINNER' ? (acknowledged ? 'INSERTED_VERIFIED' : 'RECONCILED_VERIFIED') : outcome;
    try { await db.collection('audit').insertOne({ ...intent, _id: randomUUID(), approvalId: intent._id, kind: 'result', code }, { writeConcern: { w: 'majority', wtimeout: 2000 }, maxTimeMS: 2000 }); }
    catch { return 'AUDIT_UNAVAILABLE'; }
    return code;
  } catch { return consumed || insertStarted ? 'WRITE_UNCERTAIN' : 'FIXTURE_UNAVAILABLE'; }
  finally { await connection.close(); }
}

export async function reconcileFixture({ request, policy, measured }) {
  const approval = validateRequest(request, policy, measured);
  const connection = await client(JSON.parse(await readFile('/writer/auth.json', 'utf8')));
  try {
    const db = connection.db(database);
    const intent = await db.collection('claims').findOne({ _id: approval.approvalId }, { readConcern: { level: 'majority' }, maxTimeMS: 2000 });
    if (!intent || intent.candidateHash !== approval.candidateHash || intent.targetHash !== approval.targetHash) return 'INTENT_UNPROVEN';
    const row = await exactWinner(db, policy, approval.date);
    if (!row) return 'NO_WINNER_UNCERTAIN';
    const { _id, ...content } = row;
    return digest(content) === approval.candidateHash ? 'VERIFIED_WINNER' : 'DATE_COLLISION';
  } finally { await connection.close(); }
}
