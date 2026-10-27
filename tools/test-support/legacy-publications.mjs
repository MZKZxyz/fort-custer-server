import { createLegacyPolicy } from '../../services/publication/policy.js';
import { hash } from '../../lib/maze/engine.js';

// Synthetic fixtures only; never a production inventory or an inferred date range.
export const fixturePublications = entries => createLegacyPolicy(entries.map(([date, grid]) =>
  ({ date, gridHash: hash(grid), evidence: 'disposable-synthetic-fixture' })));
