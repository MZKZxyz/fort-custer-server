import { generateInWorker } from './executor.js';
import { publisherInput, trustedInstant, fail } from './ingress.js';
import { publicationDocument, validManifest } from './policy.js';
import { generationIdentity } from '../../lib/maze/engine.js';

export function disposableOnly(model) {
  const db = model?.db, options = db?.getClient()?.options;
  if (db?.readyState !== 1 || !/^fc_publication_synthetic_[a-z0-9_]{1,40}$/.test(db.name)
      || !options?.hosts?.length || options.hosts.some(host => !['127.0.0.1', '::1', 'localhost'].includes(host.host))
      || options.srvHost || options.auth?.username) throw fail('LIVE_PUBLICATION_NOT_AUTHORIZED');
  for (const key of ['serverSelectionTimeoutMS', 'connectTimeoutMS', 'socketTimeoutMS']) {
    if (!Number.isInteger(options[key]) || options[key] < 1 || options[key] > 5000) throw fail('PUBLICATION_DB_TIMEOUTS_REQUIRED');
  }
}

// Deliberately unhooked and restricted to disposable local fixtures. There is no
// production authorization switch or ambient URI. A live adapter needs a later review.
export async function publishMaze({ model, input, now }) {
  disposableOnly(model);
  const sampled = trustedInstant(now), safe = publisherInput(input, sampled);
  const identity = generationIdentity(safe);
  const winner = async () => {
    try { return await model.findOne({ date: safe.date }).maxTimeMS(2000).lean(); }
    catch { throw fail('PUBLICATION_UNAVAILABLE'); }
  };
  let indexes;
  try { indexes = await model.collection.indexes({ maxTimeMS: 2000 }); }
  catch { throw fail('PUBLICATION_INDEX_REQUIRED'); }
  if (!indexes.some(index => index.unique && Object.keys(index.key).length === 1 && index.key.date === 1
      && !index.partialFilterExpression && !index.sparse)) throw fail('PUBLICATION_INDEX_REQUIRED');
  const outcome = (stored, created, metrics, expectedHash) => ({ created, maze: stored, metrics,
    diagnostics: validManifest(stored) && stored.provenance.identityHash === identity.identityHash
      && (expectedHash === undefined || stored.provenance.gridHash === expectedHash) ? [] : ['STORED_WINNER_IDENTITY_MISMATCH'] });
  const existing = await winner();
  if (existing) return outcome(existing, false);
  const { result, metrics } = await generateInWorker(safe, sampled);
  const candidate = publicationDocument(result, sampled);
  if (!validManifest(candidate)) throw fail('INVALID_PUBLICATION_MANIFEST');
  try {
    const inserted = await model.create([candidate], { writeConcern: { w: 'majority', wtimeout: 2000 }, maxTimeMS: 2000 });
    return outcome(inserted[0].toObject(), true, metrics, result.gridHash);
  } catch (error) {
    if (error.code === 11000) {
      const stored = await winner();
      if (stored) return outcome(stored, false, metrics, result.gridHash);
    }
    // No alternate seed, write retry or partial publication. A caller retries the
    // exact identity; a lost insert ACK is recovered by the next exact-date read.
    throw fail('PUBLICATION_UNCERTAIN');
  }
}
