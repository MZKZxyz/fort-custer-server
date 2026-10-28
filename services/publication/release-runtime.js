import { readFileSync } from 'node:fs';
import { validateFreshRelease } from './fresh-release.js';
import { legacyReleaseStatus } from './legacy-runtime.js';
import { fail } from './ingress.js';

function load() {
  try {
    const bytes = readFileSync(new URL('../../config/fresh-release.json', import.meta.url));
    if (bytes.length > 8192) throw fail('FRESH_RELEASE_INVALID');
    // Mutually exclusive policy: fresh release never enables a legacy inventory.
    if (legacyReleaseStatus.approved || legacyReleaseStatus.entryCount) throw fail('FRESH_RELEASE_INVALID');
    return validateFreshRelease(JSON.parse(bytes.toString('utf8')), new Date());
  } catch { throw fail('FRESH_RELEASE_INVALID'); }
}
const runtime = load();
export const publicationPolicy = runtime.policy;
export const freshReleaseStatus = runtime.status;
export function assertFreshReleaseReady() {
  if (!freshReleaseStatus.approved) throw fail('FRESH_RELEASE_APPROVAL_REQUIRED');
}
