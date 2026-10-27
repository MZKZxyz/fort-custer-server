import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { hash } from '../../services/playable/repository.js';
import { POLICY } from '../../services/playable/policy.js';
import { LIMITS, ROUTE_POLICY } from '../../services/playable/transcript.js';
import { date, alternateDate, grid, transcript, shortTranscript, catalog } from './fixtures.mjs';

const sourceFiles = ['routes/playableRoutes.js', 'routes/userRoutes.js', 'routes/mazeRoutes.js',
  'middleware/authMiddleware.js', 'services/playable/service.js', 'services/playable/policy.js',
  'services/playable/transcript.js', 'services/playable/repository.js', 'services/collectibles/bundle.js',
  'services/collectibles/shared-rewards.js', 'services/collectibles/lifecycle.js', 'services/collectibles/legacy-completion.js'];
export async function buildContract() {
  const sourceSha256 = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file,
    createHash('sha256').update(await readFile(new URL(`../../${file}`, import.meta.url))).digest('hex')])));
  const gridHash = hash(grid);
  const manifest = { ...ROUTE_POLICY, date, gridHash, mazeVersion: hash({ date, gridHash, seed: 'synthetic-integration-v1' }),
    abilityIds: [], runClass: 'standard', competitionVersion: 'cardinal-fire-standard-v1',
    scoringMethod: 'playable-receipt-v2', protocol: 'session-v2' };
  const prepared = { protocol: 'session-v2', attemptId: '$attemptId', date, state: 'PREPARED', revision: 1,
    expiresAt: '$prepareDeadline', startedAt: null, manifest, gridHash, grid, nonce: '$nonce' };
  const started = { ...prepared, state: 'STARTED', revision: 2, expiresAt: '$playDeadline', startedAt: '$startedAt' };
  delete started.nonce;
  const receipt = { protocol: 'session-v2', attemptId: '$attemptId', date, status: 'accepted', routeValidated: true,
    progress: { completed: true }, timing: { status: 'untimed', elapsedMs: null, reason: 'TIMING_REVIEW_REQUIRED' },
    collectible: { version: 'date-grant-v1', status: 'awarded', opportunityId: '$opportunityId',
      reward: { ...catalog[0], marketValue: 0 }, collectionComplete: false, message: 'This date’s collectible is saved.' },
    integrity: { tier: ROUTE_POLICY.integrityTier, validator: ROUTE_POLICY.validationPolicyVersion, label: 'Route validated · untimed' } };
  const body = fields => ({ subProfileId: '$subProfileId', ...fields });
  const endpoints = [
    { method: 'GET', path: '/capabilities', response: 'capabilities' },
    { method: 'POST', path: '/sessions', body: body({ date, createKey: 'create-key-0001' }), negotiationRequired: true, response: 'prepared' },
    { method: 'POST', path: '/sessions/$attemptId/ready', ifMatch: '"1"', body: body({ key: 'ready-key-0001', nonce: '$nonce',
      gridHash, rulesVersion: ROUTE_POLICY.rulesVersion }), response: 'started' },
    { method: 'GET', path: '/sessions/$attemptId/status?subProfileId=$subProfileId', response: 'started' },
    { method: 'POST', path: '/sessions/$attemptId/complete', ifMatch: '"2"',
      body: body({ completionKey: 'complete-key-0001', transcript }), response: 'receipt' },
    { method: 'GET', path: '/sessions/$attemptId/result?subProfileId=$subProfileId', response: 'receipt' },
    { method: 'POST', path: '/sessions/$attemptId/recover', body: body({}), response: 'receiptOrRecovery' },
    { method: 'POST', path: '/sessions/$attemptId/abandon', ifMatch: '$currentRevision',
      body: body({ key: 'abandon-key-0001', reason: 'user-choice' }), response: 'abandoned' },
  ];
  return { schemaVersion: 1, contractVersion: 'fc-session-v2-integration-1',
    serverBaseline: 'f33ce52a86ffccae5c28c661ce560ff783a9b836', sourceSha256,
    basePath: '/api/v2', auth: { scheme: 'Bearer', algorithm: 'HS256', claim: 'id',
      bootstrap: 'Private launcher IPC returns ephemeral credentials/token; no committed JWT or signing secret.' },
    headers: { Authorization: 'Bearer $token', 'Content-Type': 'application/json',
      'X-Fort-Custer-Protocol': 'session-v2', 'X-Fort-Custer-Capabilities': 'route-transcript-v1' },
    endpoints, strictEnvelopes: true, readQueryFields: ['subProfileId'],
    identifiers: { accountId: '24 lowercase hex ObjectId', subProfileId: '24 lowercase hex ObjectId',
      attemptId: 'lowercase UUID', nonce: 'lowercase UUID', date: 'real UTC YYYY-MM-DD', gridHash: '64 lowercase hex SHA-256' },
    keyPattern: '^[A-Za-z0-9_-]{8,128}$',
    keyScopes: { create: ['accountId', 'operation', 'key'], complete: ['accountId', 'operation', 'key'],
      ready: ['accountId', 'operation', 'attemptId', 'key'], abandon: ['accountId', 'operation', 'attemptId', 'key'] },
    bindings: { create: ['profileId', 'date'], ready: ['profileId', 'nonce', 'gridHash', 'rulesVersion'],
      complete: ['profileId', 'attemptId', 'transcriptHash'], abandon: ['profileId', 'reason'] },
    ifMatch: 'Fresh ready/abandon/complete require current positive revision (quoted or bare). Exact bound replay bypasses stale/missing revision; read status after conflicts/abort.',
    replay: 'Create/ready/abandon replay returns current effective session view, not necessarily the original state. Attempt identity, pinned grid and trusted start stay fixed. Complete/result/recover winner returns immutable receipt.',
    fixture: { date, alternateDate, grid, transcript, shortTranscript, catalog, gridHash, transcriptHash: hash(transcript),
      fixtureHash: hash({ date, alternateDate, grid, transcript, shortTranscript, catalog }),
      replay: { position: [1, 4], equipment: false, pickups: 1, cleared: 1, blocked: 2, commandCount: 10 } },
    policy: POLICY, limits: LIMITS,
    transcriptPolicy: { version: 'route-transcript-v1', exactFields: ['version', 'commands'], commandFields: ['seq', 'dir'],
      sequence: 'Contiguous positive safe integers starting at one; no skips or duplicate commands.', directions: ['up', 'down', 'left', 'right'],
      recordBoundary: 'One actual dispatched canonical input, including blocked wall/unarmed fire and stationary fire clear; never renderer ticks or client positions.',
      fire: 'X gives one equipment. F with equipment consumes it and clears F while stationary. A fresh command enters the cleared cell.',
      goal: 'Transcript must reach E and end immediately. Legal fabricated routes remain possible; no human-input or cadence certification.' },
    transport: { cacheControl: 'no-store', errorEnvelope: { error: '$code' }, retryAfter: '1 on 429/503',
      decodedBodyBytes: LIMITS.maxBytes + POLICY.maxEnvelopeBytes, compression: 'rejected', maxInflight: 8, bodyTimeoutMs: 10000 },
    timing: { authority: 'Server sample at guarded ready write, authoritative only after durable commit; not client mount or response arrival.',
      completion: 'Original server receipt before validation; no RTT subtraction, pause or client elapsed authority.',
      harness: 'unmonitored-wall-v1', officialCertified: false, acceptedUntimedHasProgressAndReward: true },
    responses: { capabilities: { protocol: 'session-v2', capabilities: ['route-transcript-v1'], admission: true,
      timing: 'continuous-server-receipt', publicRanking: false }, prepared, started, receipt,
      exhaustedReceipt: { ...receipt, date: alternateDate, collectible: { version: 'date-grant-v1', status: 'exhausted',
        opportunityId: '$opportunityId', reward: null, collectionComplete: true,
        message: 'This date’s collectible opportunity is complete; no unowned item remained.' } },
      historicalCollectibles: {
        reviewRequired: { version: 'date-ledger-v1', status: 'review-required',
          message: 'Your maze completion is saved. This date’s collectible history needs review.' },
        alreadyUsed: { version: 'date-ledger-v1', status: 'already-used',
          message: 'Your maze completion is saved. This date’s collectible opportunity was already used.' },
        exhaustedLegacy: { version: 'date-ledger-v1', status: 'exhausted',
          message: 'Your maze completion is saved. This date’s collectible opportunity was already used.' } },
      completedStatus: { ...started, state: 'COMPLETED', revision: 5 },
      abandoned: { ...started, state: 'ABANDONED', revision: 3 },
      receiptOrRecovery: { winner: receipt, noPending: { outcome: 'no-pending', session: started },
        aborted: { outcome: 'aborted', revision: 5, retrySameOperation: true } },
      resolvingStatus: { ...started, revision: 4, saveStatus: 'resolving' } },
    errors: [
      { status: 400, codes: ['REQUEST_SCHEMA', 'REQUEST_JSON', 'INVALID_PROFILE', 'INVALID_ATTEMPT', 'INVALID_KEY', 'INVALID_DATE',
        'INVALID_REVISION', 'TRANSCRIPT_SCHEMA', 'TRANSCRIPT_ORDER_OR_COMMAND'], action: 'Correct request; retain original operation identity.' },
      { status: 401, codes: ['AUTH_REQUIRED'], action: 'Restore same account authentication; do not switch profile or downgrade an unresolved attempt.' },
      { status: 404, codes: ['NOT_FOUND', 'MAZE_NOT_FOUND', 'MAZE_NOT_PUBLISHED'], action: 'Resolve ownership/date; never infer success or grant.' },
      { status: 409, codes: ['KEY_CONFLICT', 'ACTIVE_SESSION', 'SESSION_CHANGED', 'SESSION_TERMINAL', 'READY_BINDING', 'PROFILE_VERSION_REQUIRED'],
        action: 'Read owned status/result/recover; changed bindings cannot reuse a scoped key.' },
      { status: 410, codes: ['SESSION_EXPIRED'], action: 'Read owned status; no accepted progress or reward without a saved receipt.' },
      { status: 413, codes: ['REQUEST_TOO_LARGE', 'TRANSCRIPT_TOO_LARGE'], action: 'Fail before silent truncation; retain recovery evidence.' },
      { status: 415, codes: ['UNSUPPORTED_ENCODING'], action: 'Send uncompressed bounded JSON.' },
      { status: 422, codes: ['TRANSCRIPT_INCOMPLETE', 'TRANSCRIPT_AFTER_GOAL'], action: 'Route rejected; no accepted result/grant.' },
      { status: 426, codes: ['CAPABILITY_REQUIRED'], action: 'Negotiate before create. Legacy is allowed only before any potentially admitted v2 create.' },
      { status: 428, codes: ['IF_MATCH_REQUIRED'], action: 'Read current status; persist payload/key before retry.' },
      { status: 429, codes: ['OPERATION_LIMIT'], action: 'Keep original evidence; no automatic key rotation or legacy fallback.' },
      { status: 503, codes: ['COMMIT_UNKNOWN', 'SAVE_UNAVAILABLE', 'SERVER_BUSY', 'ADMISSION_DISABLED',
        'VALIDATION_BUSY', 'VALIDATION_TIMEOUT', 'VALIDATION_UNAVAILABLE', 'CLOCK_UNAVAILABLE', 'CLOCK_REVIEW_REQUIRED',
        'CLOCK_EVIDENCE_UNAVAILABLE', 'RETRY_REQUIRED', 'GRID_INVALID', 'POLICY_UNSUPPORTED', 'RECOVERY_LIMIT',
        'MANIFEST_CHANGED', 'WRITER_EPOCH_UNAVAILABLE', 'CATALOG_REVIEW_REQUIRED', 'INVENTORY_REVIEW_REQUIRED', 'GRANT_REVIEW_REQUIRED', 'SELECTION_UNAVAILABLE'],
        body: { error: '$code', retrySameOperation: true, outcome: 'unresolved' }, action: 'Use Retry-After, owned result/status/recover and same bound payload/key. Never infer abort from an empty read.' },
    ],
    recovery: [
      { loss: 'before-create-ACK', action: 'Persist date/profile/createKey before send; replay that createKey to discover original attempt.', fallback: false },
      { loss: 'after-ready-commit-before-ACK', action: 'Replay stored ready payload/key or read owned status. Original startedAt is unchanged. Movement waits for acknowledged STARTED.', fallback: false },
      { loss: 'after-intake-before-finalization', action: 'Read status (may be resolving) and result. Retry same complete or call recover; only outcome aborted proves old generation fenced.', fallback: false },
      { loss: 'after-final-commit-before-ACK', action: 'Owned result/recover/repeated complete return the same immutable receipt. Do not credit inventory locally.', fallback: false },
      { loss: 'reload', action: 'Validate saved account/profile/date/keys/gridHash/manifest and prefix; get owned status/result. Rebuild from pinned grid plus actual prefix or explicitly abandon. Never fabricate missing commands.', fallback: false },
    ],
    states: ['PREPARED', 'STARTED', 'COMPLETED', 'ABANDONED', 'EXPIRED'],
    collectibleStatuses: ['awarded', 'exhausted', 'review-required', 'already-used'],
    publicResultFields: ['protocol', 'attemptId', 'date', 'status', 'routeValidated', 'progress', 'timing', 'collectible', 'integrity'],
    guaranteesExcluded: ['production activation', 'monitored official timing', 'live writer drain/provenance audit',
      'multi-member elections/partitions', 'physical power loss', 'browser input/storage/accessibility certification'] };
}

export function normalizeResponse(body) {
  const value = structuredClone(body);
  if (value.attemptId) value.attemptId = '$attemptId';
  if (value.nonce) value.nonce = '$nonce';
  if (value.expiresAt) value.expiresAt = value.state === 'PREPARED' ? '$prepareDeadline' : '$playDeadline';
  if (value.startedAt !== null && value.startedAt !== undefined) value.startedAt = '$startedAt';
  if (value.collectible?.opportunityId) value.collectible.opportunityId = '$opportunityId';
  return value;
}
