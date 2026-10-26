import { hash, identity } from './repository.js';
import { fail } from './errors.js';

// Versioned SYS-03 boundary. Call ONLY inside the receipt/all-writer transaction.
// This records the date opportunity; it never mutates inventory or selects rarity.
export async function recordAcceptedDate(repo, actor, receipt, session) {
  if (receipt.validity !== 'accepted' || !['route-replay-v1', 'legacy-compat-v1'].includes(receipt.validationVersion)) fail('VALIDITY_REQUIRED');
  if (receipt.accountId !== actor.accountId || receipt.profileId !== actor.profileId
    || typeof receipt._id !== 'string' || !/^[a-zA-Z0-9:-]{1,128}$/.test(receipt._id)
    || typeof receipt.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(receipt.date)
    || !Number.isFinite(Date.parse(`${receipt.date}T00:00:00Z`))
    || new Date(`${receipt.date}T00:00:00Z`).toISOString().slice(0, 10) !== receipt.date) fail('LEDGER_SCOPE');
  const scope = { ...identity(actor), date: receipt.date };
  await repo.c('progress').updateOne(scope, { $setOnInsert: { firstResultId: receipt._id, completed: true,
    policyVersion: 'accepted-date-v1' } }, { upsert: true, session });
  let ledger = await repo.c('dateLedger').findOne(scope, { session });
  if (!ledger) {
    const history = await repo.c('dateHistory').findOne(scope, { session });
    // Missing history is not evidence that a legacy reward was never awarded.
    const clear = history?.state === 'known-clear' && typeof history.evidenceRef === 'string' && history.evidenceRef.length > 0;
    const priorState = history?.evidenceRef && ['awarded', 'exhausted'].includes(history.state) ? `${history.state}-legacy` : 'legacy-held';
    ledger = { ...scope, _id: hash(scope), version: 'date-ledger-v1',
      state: clear ? 'claimed' : priorState, firstResultId: receipt._id,
      grantId: clear ? `date:${hash(scope)}` : null, revision: 1 };
    await repo.c('dateLedger').insertOne(ledger, { session });
    if (clear) await repo.c('outbox').insertOne({ _id: ledger.grantId, type: 'date-grant-requested',
      resultId: receipt._id, ledgerId: ledger._id, ledgerRevision: ledger.revision, version: 'sys03-grant-v1' }, { session });
  }
  const status = ledger.state === 'legacy-held' ? 'review-required' : ledger.state === 'awarded-legacy' ? 'already-used'
    : ledger.state === 'exhausted-legacy' ? 'exhausted' : 'pending';
  return { version: 'date-ledger-v1', status,
    message: status === 'review-required' ? 'Your maze completion is saved. This date’s collectible history needs review.'
      : status === 'pending' ? 'Your maze completion is saved. Its once-per-date collectible opportunity is recorded.'
        : 'Your maze completion is saved. This date’s collectible opportunity was already used.' };
}
