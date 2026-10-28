import { readFileSync } from 'node:fs';
import { validateLegacyManifest } from './legacy-manifest.js';
import { fail } from './ingress.js';

// Exactly one fixed, committed artifact per process; no environment path or hot reload.
function load() {
  try {
    const bytes = readFileSync(new URL('../../config/legacy-publications.json', import.meta.url));
    if (bytes.length > 2 * 1024 * 1024) throw fail('LEGACY_MANIFEST_INVALID');
    const manifest = JSON.parse(bytes.toString('utf8'));
    const checked = validateLegacyManifest(manifest);
    if (checked.status.approved && Date.parse(manifest.approval.approvedAt) > Date.now()) throw fail('LEGACY_MANIFEST_INVALID');
    return checked;
  } catch { throw fail('LEGACY_MANIFEST_INVALID'); }
}
const runtime = load();
export const legacyPolicy = runtime.policy;
export const legacyReleaseStatus = runtime.status;
export function assertLegacyReleaseReady() {
  if (!legacyReleaseStatus.approved || !legacyReleaseStatus.entryCount) throw fail('LEGACY_RELEASE_APPROVAL_REQUIRED');
}
