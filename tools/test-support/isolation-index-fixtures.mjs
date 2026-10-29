// Adversarial metadata for disposable tests only; never an operator selector.
export const isolationIndexFixtures = {
  'wrong-field': { key: { seed: 1 }, options: { unique: true } },
  descending: { key: { date: -1 }, options: { unique: true } },
  compound: { key: { date: 1, seed: 1 }, options: { unique: true } },
  nonunique: { key: { date: 1 }, options: {} },
  sparse: { key: { date: 1 }, options: { unique: true, sparse: true } },
  partial: { key: { date: 1 }, options: { unique: true, partialFilterExpression: { date: { $gte: '2026-06-01' } } } },
  hidden: { key: { date: 1 }, options: { unique: true, hidden: true } },
  ttl: { key: { date: 1 }, options: { unique: true, expireAfterSeconds: 3600 } },
  collation: { key: { date: 1 }, options: { unique: true, collation: { locale: 'en', strength: 2 } } },
};
