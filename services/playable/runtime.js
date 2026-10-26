// These are code-level release blockers, not environment switches. An operator
// cannot accidentally turn on v2 while the unchanged v1 reward writer is live.
export const RELEASE_BLOCKERS = Object.freeze(['all-writer-ledger-not-integrated',
  'sys03-grant-worker-not-integrated', 'independent-runtime-qa-required', 'release-approval-required']);

export function installPlayableRuntime(app, { env = process.env } = {}) {
  if (env.FC_SESSION_V2_ENABLED !== 'true') return Object.freeze({ mounted: false, enabled: false });
  throw new Error('PLAYABLE_V2_ACTIVATION_BLOCKED: shared writer/grant compatibility and release review required');
}
