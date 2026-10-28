import { fail } from './ingress.js';

const exact = (index, key, unique) => index && JSON.stringify(index.key) === JSON.stringify(key)
  && (unique ? index.unique === true : index.unique !== true)
  && !index.sparse && !index.partialFilterExpression && !index.hidden && !index.buildUUID
  && index.expireAfterSeconds === undefined && (!index.collation || index.collation.locale === 'simple');
export function assessIndexReadiness(metadata) {
  const checks = {
    mazeDateUnique: metadata.mazes?.some(index => exact(index, { date: 1 }, true)) === true,
    mazeArchive: metadata.mazes?.some(index => exact(index, { publicationEra: 1, date: 1, publishedAt: 1 }, false)) === true,
    userEmailUnique: metadata.users?.some(index => exact(index, { email: 1 }, true)) === true,
    rewardIdUnique: metadata.rewarditems?.some(index => exact(index, { id: 1 }, true)) === true,
  };
  return { schemaVersion: 1, ready: Object.values(checks).every(Boolean), checks };
}

// Explicit connected Db only. No URI/config lookup, models, connection, scans or DDL.
// Production invocation needs separate owner authorization; this task uses fixtures only.
export async function readIndexReadiness(db) {
  try {
    const metadata = {};
    for (const collection of ['mazes', 'users', 'rewarditems']) {
      const response = await db.command({ listIndexes: collection, cursor: { batchSize: 16 }, maxTimeMS: 2000 });
      if (response.cursor?.id?.toString() !== '0' || !Array.isArray(response.cursor.firstBatch)
          || response.cursor.firstBatch.length > 16) throw fail('ARCHIVE_INDEX_CHECK_FAILED');
      metadata[collection] = response.cursor.firstBatch;
    }
    return assessIndexReadiness(metadata);
  } catch { throw fail('ARCHIVE_INDEX_CHECK_FAILED'); }
}
