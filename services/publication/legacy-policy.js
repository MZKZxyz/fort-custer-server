import { validateDate } from '../../lib/maze/dates.js';
import { plainKeys, fail } from './ingress.js';

// A reviewed inventory pins both date and grid hash. No source-derived season assumption.
export function createLegacyPolicy(entries = []) {
  if (!Array.isArray(entries) || entries.length > 3660) throw fail('INVALID_LEGACY_INVENTORY');
  const inventory = new Map();
  for (const entry of entries) {
    plainKeys(entry, ['date', 'gridHash', 'evidence'], 'INVALID_LEGACY_INVENTORY');
    validateDate(entry.date);
    if (!/^[a-f0-9]{64}$/.test(entry.gridHash) || typeof entry.evidence !== 'string'
        || !entry.evidence.trim() || entry.evidence.length > 256 || inventory.has(entry.date)) throw fail('INVALID_LEGACY_INVENTORY');
    inventory.set(entry.date, entry.gridHash);
  }
  return Object.freeze({ dates: Object.freeze([...inventory.keys()].sort()),
    matches: (date, gridHash) => inventory.get(date) === gridHash });
}
