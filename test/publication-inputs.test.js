import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { publisherInput, parseCivilInstant, trustedInstant, monthDates } from '../services/publication/ingress.js';
import { generateInWorker, WORKER_LIMITS } from '../services/publication/executor.js';
import { generateDaily } from '../lib/maze/engine.js';
import { publicationDocument, isPublished, createLegacyPolicy, validManifest } from '../services/publication/policy.js';

const now = new Date('2028-03-01T00:00:00Z'), input = { date: '2028-02-29' };

test('publisher rejects QA non-JSON config shapes, own-key tricks and timestamps before spawning', async () => {
  const getter = Object.defineProperty({}, 'width', { enumerable: true, get() { assert.fail('getter must not run'); } });
  for (const config of [new Date(0), Object.create({ width: 103 }), Object.create(null),
    Object.defineProperty({}, 'typo', { value: 1 }), { [Symbol('x')]: 1 }, getter,
    JSON.parse('{"__proto__":{"width":13}}'), [], null, { width: undefined }]) {
    assert.throws(() => publisherInput({ ...input, config }, now));
    await assert.rejects(generateInWorker({ ...input, config }, now));
  }
  for (const value of [now.toISOString(), null, undefined, NaN, new Date(NaN)]) assert.throws(() => trustedInstant(value));
  for (const value of ['2028-01-01T00:00:00+23:59', '2028-01-01T00:00:00+14:01',
    '2028-01-01T00:00:00+15:00', '2028-01-01T00:00:00-12:01', '2028-01-01T00:00:00-00:00', '2028-01-01T00:00:00+13:59',
    '2028-01-01T24:00:00Z', '2028-02-30T00:00:00Z', '2028-01-01T00:00:00', '2028-01-01']) {
    assert.throws(() => parseCivilInstant(value));
  }
  for (const value of ['2028-01-01T00:00:00+14:00', '2028-01-01T00:00:00-12:00',
    '2028-03-12T01:59:59-08:00', '2028-03-12T03:00:00-07:00', '2028-11-05T01:30:00-07:00',
    '2028-11-05T01:30:00-08:00', '0001-01-01T00:00:00Z', '9999-12-31T23:59:59.999Z']) {
    assert.ok(Number.isFinite(parseCivilInstant(value).getTime()));
  }
  for (const value of [{ ...input, config: { width: 4 } }, { ...input, date: '2028-02-30' },
    { ...input, seed: null }, { ...input, version: undefined }, { ...input, typo: 1 },
    { date: '2028-03-02' }]) assert.throws(() => publisherInput(value, now));
  assert.deepEqual(publisherInput(input, now), publisherInput({ ...input, config: {} }, now));
});

test('month validation supports all domain endpoints and Gregorian leap rules without normalization', () => {
  for (const [month, length] of [['0001-01', 31], ['9999-12', 31], ['1900-02', 28], ['2000-02', 29], ['2028-02', 29]]) {
    assert.equal(monthDates(month).length, length);
  }
  for (const month of ['0000-01', '2028-00', '2028-13', '2028-2', ' 2028-02', ['2028-02'], null]) assert.throws(() => monthDates(month));
});

test('shared predicate verifies hashes and manifests; legacy approval pins exact bytes and never mutates', () => {
  const record = publicationDocument(generateDaily(input), now);
  assert.equal(validManifest(record), true);
  assert.equal(isPublished(record, now), true);
  assert.equal(isPublished(record, now.getTime() - 1), false);
  for (const mutate of [m => { m.grid[1][1] = '#'; }, m => { m.seed += 'changed'; },
    m => { m.provenance.config.width = 21; }, m => { m.provenance.gridHash = '0'.repeat(64); },
    m => { m.provenance.attempts[0].code = 'UNKNOWN'; }, m => { delete m.publishedAt; },
    m => { m.publicationEra = 'legacy'; }, m => { m.width = 1; }]) {
    const bad = structuredClone(record); mutate(bad); assert.equal(isPublished(bad, now), false);
  }
  assert.throws(() => createLegacyPolicy([{ date: '2025-05-26', gridHash: '0'.repeat(64), evidence: '' }]));
  assert.throws(() => createLegacyPolicy(Array(3661).fill({})));
});

test('isolated worker retains exact accepted v1 bytes and leaves global RNG untouched', async () => {
  const expected = generateDaily(input), random = Math.random;
  try {
    Math.random = () => { throw Error('global RNG'); };
    const actual = await generateInWorker(input, now);
    assert.deepEqual(actual.result.maze, expected.maze);
    assert.equal(actual.result.identityHash, expected.identityHash);
    assert.deepEqual(actual.result.attempts, expected.attempts);
    assert.ok(actual.metrics.peakRssBytes > 0 && actual.metrics.peakRssBytes <= WORKER_LIMITS.rssBytes);
  } finally { Math.random = random; }
});

test('worker timeout, RSS watchdog, queue refusal and exhaustion free the single execution slot', async () => {
  const worst = { date: '2028-01-01', config: { width: 101, height: 101, minDistance: 10201,
    endpointAttempts: 32, fireAttempts: 32, maxAttempts: 32, maxStates: 100000 } };
  const running = generateInWorker(worst, now, { timeoutMs: 250 });
  await assert.rejects(generateInWorker(input, now), { code: 'GENERATOR_BUSY' });
  await assert.rejects(running, error => ['GENERATOR_TIMEOUT', 'GENERATOR_MEMORY_LIMIT', 'GENERATOR_FAILED'].includes(error.code)
    && error.metrics.elapsedMs < 3000);
  await assert.rejects(generateInWorker(input, now, { rssBytes: 1 }), { code: 'GENERATOR_MEMORY_LIMIT' });
  await assert.rejects(generateInWorker(input, now, { timeoutMs: 1 }), { code: 'GENERATOR_TIMEOUT' });
  await assert.rejects(generateInWorker({ ...input, config: { minDistance: 10201, maxAttempts: 2 } }, now),
    error => error.code === 'GENERATION_EXHAUSTED' && error.attempts.length === 2);
  const large = await generateInWorker({ date: '2028-01-01', seed: 'independent-large-0', config: { width: 101, height: 101 } }, now);
  assert.equal(large.result.maze.width, 101);
  assert.ok(large.metrics.peakRssBytes <= WORKER_LIMITS.rssBytes);
  for (const limits of [{ timeoutMs: 1501 }, { rssBytes: 129 * 1024 * 1024 }, { maxConcurrency: 2 }, new Date()]) {
    await assert.rejects(generateInWorker(input, now, limits));
  }
});

test('operator CLI is always dry-run, fails closed, and ignores every ambient database selector', () => {
  const run = args => spawnSync(process.execPath, ['tools/maze-publisher/cli.js', ...args], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, MONGO_URI: 'synthetic-refused', MONGODB_URI: 'synthetic-refused', MONGO_URL: 'synthetic-refused', DATABASE_URL: 'synthetic-refused' } });
  const args = ['--date', input.date, '--at', now.toISOString()];
  const result = run(args); assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'offline-dry-run');
  assert.equal(report.document.provenance.gridHash, generateDaily(input).gridHash);
  for (const bad of [['--apply'], ['--date', '2028-02-30'], ['--date', '2028-03-02', '--at', now.toISOString()],
    [...args, '--config', '[]'], [...args, '--config', '{"typo":1}'], [...args, '--at', '2028-01-01T00:00:00+23:59']]) {
    const child = run(bad); assert.notEqual(child.status, 0); assert.equal(child.stdout, '');
  }
});
