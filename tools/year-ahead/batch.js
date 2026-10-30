import { randomBytes } from 'node:crypto';
import { constants, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { algorithmVersion, canonicalConfig, generateDaily, GenerationError, hash } from '../../lib/maze/engine.js';
import { inclusiveDates } from '../../lib/maze/dates.js';
import { metrics, summarize } from './metrics.js';

const repo = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const schemaVersion = 1;
export class BatchError extends Error {}
const fail = code => { throw new BatchError(code); };
const same = (a, b) => { if (!isDeepStrictEqual(a, b)) fail('BATCH_INTEGRITY_FAILED'); };
const digestFiles = ['lib/maze/engine.js', 'lib/maze/candidate-v1.js', 'lib/maze/random-v1.js',
  'lib/maze/dates.js', 'lib/maze/analyzer.js', 'lib/maze/solver.js',
  'tools/year-ahead/batch.js', 'tools/year-ahead/metrics.js'];
export const sourceDigest = () => hash(digestFiles.map(path => [path, readFileSync(join(repo, path), 'utf8')]));
export function yearDates(year) {
  if (!Number.isInteger(year) || year < 1 || year > 9999) fail('INVALID_YEAR');
  const y = String(year).padStart(4, '0');
  return inclusiveDates(`${y}-01-01`, `${y}-12-31`);
}
export function canonicalPlan(plan) {
  if (!plan || plan.schemaVersion !== 1 || Object.keys(plan).some(k => !['schemaVersion', 'maxCandidateSeeds', 'tiers'].includes(k))
      || !Number.isInteger(plan.maxCandidateSeeds) || plan.maxCandidateSeeds < 1 || plan.maxCandidateSeeds > 16
      || !Array.isArray(plan.tiers) || !plan.tiers.length || plan.tiers.length > 12) fail('INVALID_PLAN');
  const names = new Set();
  const tiers = plan.tiers.map(tier => {
    if (!tier || Object.keys(tier).some(k => !['name', 'weight', 'config', 'minActions', 'maxActions'].includes(k))
        || !/^[a-z][a-z0-9-]{0,31}$/.test(tier.name) || names.has(tier.name)
        || !Number.isInteger(tier.weight) || tier.weight < 1 || tier.weight > 32) fail('INVALID_PLAN');
    names.add(tier.name);
    const minActions = tier.minActions ?? 1, maxActions = tier.maxActions ?? 100000;
    if (!Number.isInteger(minActions) || !Number.isInteger(maxActions) || minActions < 1 || maxActions < minActions || maxActions > 100000) fail('INVALID_PLAN');
    return { name: tier.name, weight: tier.weight, config: canonicalConfig(tier.config), minActions, maxActions };
  });
  return { schemaVersion, maxCandidateSeeds: plan.maxCandidateSeeds, tiers };
}
const schedule = plan => plan.tiers.flatMap(t => Array(t.weight).fill(t));
function privatePath(path, directory) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
      || (stat.mode & 0o077) || stat.uid !== process.getuid() || (!directory && stat.nlink !== 1)) fail('UNSAFE_PRIVATE_PATH');
}
function rootPath(root) {
  if (!isAbsolute(root)) fail('ABSOLUTE_PRIVATE_ROOT_REQUIRED');
  const absolute = resolve(root);
  // Reject symlinks and repositories at every existing ancestor, including nested checkouts.
  for (let cursor = absolute; ; cursor = dirname(cursor)) {
    if (existsSync(cursor)) {
      const git = join(cursor, '.git');
      if (lstatSync(cursor).isSymbolicLink() || existsSync(git)
          && (lstatSync(git).isFile() || existsSync(join(git, 'HEAD')))) fail('ROOT_MUST_BE_OUTSIDE_REPOSITORIES');
    }
    if (['public', 'static', 'dist', 'build', '.next'].includes(cursor.split(sep).at(-1))) fail('PUBLIC_ROOT_REFUSED');
    if (dirname(cursor) === cursor) break;
  }
  if (absolute === repo || absolute.startsWith(repo + sep)) fail('ROOT_MUST_BE_OUTSIDE_REPOSITORIES');
  if (!existsSync(absolute)) mkdirSync(absolute, { mode: 0o700 });
  privatePath(absolute, true);
  return absolute;
}
function batchPath(root, id) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(id)) fail('INVALID_BATCH_NAME');
  return join(rootPath(root), id);
}
function read(path) {
  privatePath(path, false);
  return JSON.parse(readFileSync(path, 'utf8'));
}
function syncDirectory(dir) {
  const fd = openSync(dir, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
// Same-filesystem hard-link installation never overwrites an existing artifact.
function install(dir, name, value) {
  const temporary = join(dir, `.tmp-${randomBytes(12).toString('hex')}`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(temporary, join(dir, name)); } finally { unlinkSync(temporary); }
  syncDirectory(dir);
}
function withLock(dir, work) {
  privatePath(dir, true);
  if (existsSync(join(dir, 'APPROVED.json'))) fail('APPROVED_BATCH_IMMUTABLE');
  const lock = join(dir, '.lock');
  try { mkdirSync(lock, { mode: 0o700 }); } catch { fail('BATCH_LOCKED'); }
  try {
    install(lock, 'owner.json', { pid: process.pid, host: hostname() });
    return work();
  } finally { unlinkSync(join(lock, 'owner.json')); rmdirSync(lock); }
}
export function createBatch({ root, id, year, plan, sourceRevision }) {
  plan = canonicalPlan(plan);
  const dates = yearDates(year);
  if (!/^[a-f0-9]{40}$/.test(sourceRevision)) fail('SOURCE_REVISION_REQUIRED');
  const dir = batchPath(root, id), slots = schedule(plan);
  const manifest = { schemaVersion, year, plan, algorithmVersion,
    provenance: { sourceRevision, sourceDigest: sourceDigest(), nodeVersion: process.version, createdAt: new Date().toISOString() },
    entries: dates.map((date, i) => ({ date, tier: slots[i % slots.length].name,
      seeds: Array.from({ length: plan.maxCandidateSeeds }, () => randomBytes(32).toString('hex')) })) };
  // mkdir is exclusive; an existing approved, interrupted or complete batch is never replaced.
  mkdirSync(dir, { mode: 0o700 });
  install(dir, 'manifest.json', manifest);
  return { status: 'created', expected: dates.length };
}
function load(dir) {
  privatePath(dir, true);
  const m = read(join(dir, 'manifest.json'));
  same(m.schemaVersion, schemaVersion); same(m.algorithmVersion, algorithmVersion);
  same(m.provenance.sourceDigest, sourceDigest());
  if (!/^[a-f0-9]{40}$/.test(m.provenance.sourceRevision)) fail('BATCH_INTEGRITY_FAILED');
  const plan = canonicalPlan(m.plan), dates = yearDates(m.year), slots = schedule(plan), seeds = new Set();
  same(plan, m.plan); same(m.entries.length, dates.length);
  for (const [i, entry] of m.entries.entries()) {
    same(entry.date, dates[i]); same(entry.tier, slots[i % slots.length].name);
    same(entry.seeds.length, plan.maxCandidateSeeds);
    for (const seed of entry.seeds) {
      if (!/^[a-f0-9]{64}$/.test(seed) || seeds.has(seed)) fail('REPEATED_OR_INVALID_SEED');
      seeds.add(seed);
    }
  }
  const allowed = new Set(['manifest.json', 'COMPLETE.json', 'APPROVED.json', '.lock', ...dates.map(d => `${d}.json`)]);
  for (const name of readdirSync(dir)) if (!allowed.has(name) && !/^\.tmp-[a-f0-9]{24}$/.test(name)) fail('UNEXPECTED_BATCH_ARTIFACT');
  return m;
}
function trial(entry, tier, index) {
  const started = performance.now();
  try {
    const result = generateDaily({ date: entry.date, seed: entry.seeds[index], version: algorithmVersion, config: tier.config });
    const accepted = result.analysis.solution.minimumMoves >= tier.minActions && result.analysis.solution.minimumMoves <= tier.maxActions;
    return { result, evidence: { index, status: accepted ? 'ACCEPTED' : 'QUALITY_REJECTED', attempts: result.attempts,
      durationMs: performance.now() - started } };
  } catch (error) {
    if (!(error instanceof GenerationError)) throw error;
    return { evidence: { index, status: 'GENERATION_EXHAUSTED', attempts: error.attempts, durationMs: performance.now() - started } };
  }
}
function produce(entry, tier) {
  const trials = [];
  for (let index = 0; index < entry.seeds.length; index++) {
    const attempt = trial(entry, tier, index); trials.push(attempt.evidence);
    if (attempt.evidence.status === 'ACCEPTED') return { date: entry.date, tier: entry.tier,
      choice: index, result: attempt.result, metrics: metrics(attempt.result), trials };
  }
  // All candidates remain reproducible from the frozen manifest; diagnostics stay private.
  fail('DATE_CANDIDATES_EXHAUSTED');
}
function checkRecord(record, entry, tier) {
  const expected = produce(entry, tier);
  same(record.trials.length, expected.trials.length);
  const stripTiming = r => ({ ...r, trials: r.trials.map(t => {
    if (!Number.isFinite(t.durationMs) || t.durationMs < 0) fail('BATCH_INTEGRITY_FAILED');
    const { durationMs, ...rest } = t; return rest;
  }) });
  same(stripTiming(record), stripTiming(expected));
}
function collect(dir, manifest, generate) {
  const records = [], identities = new Set(), grids = new Set();
  for (const entry of manifest.entries) {
    const path = join(dir, `${entry.date}.json`), tier = manifest.plan.tiers.find(t => t.name === entry.tier);
    let record;
    if (existsSync(path)) { record = read(path); checkRecord(record, entry, tier); }
    else if (generate) { record = produce(entry, tier); install(dir, `${entry.date}.json`, record); }
    else fail('BATCH_INCOMPLETE');
    if (identities.has(record.result.identityHash) || grids.has(record.result.gridHash)) fail('REPEATED_MAZE');
    identities.add(record.result.identityHash); grids.add(record.result.gridHash); records.push(record);
  }
  return records;
}
const seal = (manifest, records) => ({ schemaVersion, manifestHash: hash(manifest), count: records.length,
  recordHashes: records.map(r => hash(r)) });
export function generateBatch({ root, id }) {
  const dir = batchPath(root, id);
  return withLock(dir, () => {
    const manifest = load(dir), complete = existsSync(join(dir, 'COMPLETE.json'));
    const records = collect(dir, manifest, !complete), expected = seal(manifest, records);
    if (complete) same(read(join(dir, 'COMPLETE.json')), expected);
    else install(dir, 'COMPLETE.json', expected);
    return summarize(records);
  });
}
export function validateBatch({ root, id }) {
  const dir = batchPath(root, id), manifest = load(dir);
  if (existsSync(join(dir, '.lock'))) fail('BATCH_LOCKED');
  const records = collect(dir, manifest, false);
  same(read(join(dir, 'COMPLETE.json')), seal(manifest, records));
  return summarize(records);
}
export function cleanupTemporary({ root, id }) {
  const dir = batchPath(root, id);
  return withLock(dir, () => {
    let removed = 0;
    for (const name of readdirSync(dir)) if (/^\.tmp-[a-f0-9]{24}$/.test(name)) {
      const path = join(dir, name), stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) fail('UNSAFE_PRIVATE_PATH');
      if (stat.nlink === 2) {
        // A crash after link but before unlink leaves exactly this private twin.
        const twin = readdirSync(dir).find(n => /^(manifest|COMPLETE|\d{4}-\d{2}-\d{2})\.json$/.test(n)
          && lstatSync(join(dir, n)).ino === stat.ino && lstatSync(join(dir, n)).dev === stat.dev);
        if (!twin) fail('UNSAFE_PRIVATE_PATH');
      } else if (stat.nlink !== 1) fail('UNSAFE_PRIVATE_PATH');
      unlinkSync(path); removed++;
    }
    const manifest = load(dir);
    if (existsSync(join(dir, 'COMPLETE.json'))) same(read(join(dir, 'COMPLETE.json')), seal(manifest, collect(dir, manifest, false)));
    syncDirectory(dir);
    return { status: 'temporary-files-cleaned', removed };
  });
}
export function recoverLock({ root, id }) {
  const dir = batchPath(root, id); privatePath(dir, true);
  if (existsSync(join(dir, 'APPROVED.json'))) fail('APPROVED_BATCH_IMMUTABLE');
  const lock = join(dir, '.lock'); privatePath(lock, true);
  const owner = read(join(lock, 'owner.json'));
  if (owner.host !== hostname() || !Number.isInteger(owner.pid) || owner.pid < 1) fail('LOCK_RECOVERY_REFUSED');
  try { process.kill(owner.pid, 0); fail('LOCK_OWNER_ACTIVE'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  unlinkSync(join(lock, 'owner.json')); rmdirSync(lock); syncDirectory(dir);
  return { status: 'stale-lock-removed' };
}
