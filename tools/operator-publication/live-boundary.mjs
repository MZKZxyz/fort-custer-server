// No arguments, selectors, credentials, network imports or environment override.
export const LIVE_BLOCKERS = Object.freeze(['dedicated-runner-not-approved', 'os-containment-not-proven',
  'scoped-credential-and-target-not-provisioned', 'owner-release-not-approved', 'independent-security-qa-required']);
export function applyProduction() {
  return Object.freeze({ schemaVersion: 1, mode: 'production-blocked', code: 'LIVE_APPLY_BLOCKED', blockers: LIVE_BLOCKERS });
}
