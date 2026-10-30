import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync, chmodSync,
  symlinkSync, linkSync, unlinkSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createBatch, generateBatch, validateBatch, cleanupTemporary, recoverLock, yearDates, canonicalPlan } from '../tools/year-ahead/batch.js';
import { metrics, summarize } from '../tools/year-ahead/metrics.js';
import { generateDaily, hash } from '../lib/maze/engine.js';
import { utcDate } from '../lib/maze/dates.js';
import { move, findStart } from './fixtures/client-movement.js';

const plan = JSON.parse(readFileSync(new URL('../tools/year-ahead/experiment.json', import.meta.url)));
const revision = 'cec541d71f83eca42463182b62c00433acc53746';
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, object) => writeFileSync(path, JSON.stringify(object), { mode: 0o600 });
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fc-year-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = { root, id: 'test-batch', year: 2031, plan, sourceRevision: revision, ...options };
  createBatch(input);
  return { ...input, dir: join(root, input.id) };
}
function replay(record) {
  let state = { grid: structuredClone(record.result.maze.grid), position: findStart(record.result.maze.grid), inventory: [], completed: false };
  for (const action of record.result.analysis.solution.actions) state = move(state, action).state;
  assert.equal(state.completed, true);
  assert.equal(hash(record.result.maze.grid), record.result.gridHash);
}
const stripTime = summary => JSON.parse(JSON.stringify(summary), (key, value) => key === 'generationMs' ? undefined : value);

for (const year of [2031, 2032]) test(`private random ${year} annual batch: complete, unique, reproducible, client-playable and aggregate-only`, t => {
  const f = fixture(t, { year }), expected = year === 2032 ? 366 : 365;
  const generated = generateBatch(f);
  assert.equal(generated.total.accepted, expected);
  const manifest = json(join(f.dir, 'manifest.json'));
  const seeds = manifest.entries.flatMap(e => e.seeds);
  assert.equal(new Set(seeds).size, seeds.length);
  assert.ok(seeds.every(s => /^[a-f0-9]{64}$/.test(s)));
  const records = manifest.entries.map(e => json(join(f.dir, `${e.date}.json`)));
  assert.equal(new Set(records.map(r => r.result.gridHash)).size, expected);
  assert.equal(new Set(records.map(r => r.result.identityHash)).size, expected);
  assert.deepEqual(Object.values(generated.sizes).map(s => s.accepted), year === 2032 ? [122, 122, 122] : [122, 122, 121]);
  for (const record of records) {
    replay(record);
    const { date, seed, config, algorithmVersion: version } = record.result;
    assert.equal(hash(generateDaily({ date, seed, config, version })), hash(record.result));
    assert.equal(record.result.analysis.exact.geometricComponents, 1);
    assert.equal(record.result.analysis.exact.fireTiles, 1);
    assert.equal(record.result.analysis.exact.extinguisherTiles, 1);
    assert.deepEqual(record.result.analysis.solution.unreachableItems, []);
    assert.ok(record.trials.at(-1).status === 'ACCEPTED');
  }
  assert.deepEqual(validateBatch(f), generated);
  const before = hash(readdirSync(f.dir).map(n => [n, readFileSync(join(f.dir, n), 'utf8')]));
  assert.deepEqual(generateBatch(f), generated);
  assert.equal(hash(readdirSync(f.dir).map(n => [n, readFileSync(join(f.dir, n), 'utf8')])), before);
  assert.throws(() => createBatch(f), /EEXIST/);
  assert.equal(cleanupTemporary(f).removed, 0);
  const output = JSON.stringify(generated);
  for (const record of records) {
    for (const sensitive of [record.date, record.result.seed, record.result.gridHash, record.result.identityHash, JSON.stringify(record.result.maze.grid), JSON.stringify(record.result.analysis.solution.actions)]) {
      assert.equal(output.includes(sensitive), false);
    }
  }
  assert.ok(!/seed":|grid":|path":|actions":\[|sourceRevision|createdAt|date":|identityHash/.test(output));
  // An external owner marker is respected without interpreting it as tool approval.
  save(join(f.dir, 'APPROVED.json'), { ownerManaged: true });
  assert.throws(() => generateBatch(f), /APPROVED_BATCH_IMMUTABLE/);
  assert.throws(() => cleanupTemporary(f), /APPROVED_BATCH_IMMUTABLE/);
  assert.deepEqual(validateBatch(f), generated);
});

test('UTC annual dates include leap centuries and DST boundaries independent of process timezone', () => {
  assert.equal(yearDates(1900).length, 365); assert.equal(yearDates(2000).length, 366);
  assert.equal(yearDates(2032).filter(d => d === '2032-02-29').length, 1);
  for (const year of [0, 10000, NaN, 2032.5]) assert.throws(() => yearDates(year));
  for (const instant of ['2031-03-09T01:59:59-08:00', '2031-03-09T03:00:00-07:00']) assert.equal(utcDate(instant), '2031-03-09');
  for (const instant of ['2031-11-02T01:30:00-07:00', '2031-11-02T01:30:00-08:00']) assert.equal(utcDate(instant), '2031-11-02');
  const script = "import {yearDates} from './tools/year-ahead/batch.js'; process.stdout.write(JSON.stringify(yearDates(2032)))";
  const outputs = ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati'].map(TZ => spawnSync(process.execPath,
    ['--input-type=module', '-e', script], { env: { ...process.env, TZ }, encoding: 'utf8' }).stdout);
  assert.equal(outputs[0], outputs[1]); assert.equal(outputs[1], outputs[2]); assert.equal(JSON.parse(outputs[0]).length, 366);
});

test('interruption retains exact seed plan, verifies records on resume, cleans orphan writes and detects corruption', t => {
  const f = fixture(t), manifestPath = join(f.dir, 'manifest.json'), m = json(manifestPath);
  const entry = m.entries[0], tier = m.plan.tiers[0];
  const result = generateDaily({ date: entry.date, seed: entry.seeds[0], config: tier.config });
  const record = { date: entry.date, tier: entry.tier, choice: 0, result, metrics: metrics(result),
    trials: [{ index: 0, status: 'ACCEPTED', attempts: result.attempts, durationMs: 1 }] };
  save(join(f.dir, `${entry.date}.json`), record);
  const temp = join(f.dir, '.tmp-' + 'a'.repeat(24)); linkSync(manifestPath, temp);
  assert.throws(() => validateBatch(f), /UNSAFE_PRIVATE_PATH/);
  assert.equal(cleanupTemporary(f).removed, 1);
  const before = readFileSync(manifestPath, 'utf8');
  assert.throws(() => validateBatch(f), /BATCH_INCOMPLETE/);
  const summary = generateBatch(f); assert.equal(summary.total.accepted, 365);
  assert.equal(readFileSync(manifestPath, 'utf8'), before);
  assert.equal(json(join(f.dir, `${entry.date}.json`)).trials[0].durationMs, 1);
  record.result.maze.grid[0][0] = ' ';
  save(join(f.dir, `${entry.date}.json`), record);
  assert.throws(() => validateBatch(f), /BATCH_INTEGRITY_FAILED/);
  assert.throws(() => generateBatch(f), /BATCH_INTEGRITY_FAILED/);
  writeFileSync(join(f.dir, `${entry.date}.json`), '{broken');
  assert.throws(() => validateBatch(f));
});

test('malformed manifests, duplicate private seeds, changed versions and unexpected artifacts fail closed', t => {
  const f = fixture(t), path = join(f.dir, 'manifest.json'), original = json(path);
  for (const mutate of [m => { m.entries[1].seeds[0] = m.entries[0].seeds[0]; },
    m => { m.entries.at(-1).seeds[0] = (m.entries.at(-1).seeds[0][0] === 'a' ? 'b' : 'a') + m.entries.at(-1).seeds[0].slice(1); },
    m => { m.plan.tiers[0].config.minDistance++; },
    m => { m.entries.pop(); }, m => { m.algorithmVersion = 'unknown'; },
    m => { m.provenance.sourceDigest = '0'.repeat(64); }, m => { m.entries[2].date = m.entries[0].date; }]) {
    const copy = structuredClone(original); mutate(copy); save(path, copy);
    assert.throws(() => generateBatch(f));
  }
  save(path, original); save(join(f.dir, 'unexpected.json'), {});
  assert.throws(() => generateBatch(f), /UNEXPECTED_BATCH_ARTIFACT/);
});

test('engine exhaustion and quality rejection are bounded and leave no completed batch', t => {
  for (const kind of ['engine', 'quality']) {
    const tiers = [{ name: 'reject', weight: 1, config: kind === 'engine'
      ? { minDistance: 10201, maxAttempts: 1 } : { maxAttempts: 32 }, ...(kind === 'quality' ? { minActions: 99999 } : {}) }];
    const f = fixture(t, { id: kind, plan: { schemaVersion: 1, maxCandidateSeeds: 2, tiers } });
    assert.throws(() => generateBatch(f), /DATE_CANDIDATES_EXHAUSTED/);
    assert.deepEqual(readdirSync(f.dir), ['manifest.json']);
    assert.throws(() => generateBatch(f), /DATE_CANDIDATES_EXHAUSTED/);
  }
});

test('tier plan validates dimensions, bounds, names and weights without choosing a production mix', () => {
  for (const p of [{ ...plan, maxCandidateSeeds: 17 }, { ...plan, tiers: [] },
    { ...plan, tiers: [plan.tiers[0], plan.tiers[0]] }, { ...plan, typo: true },
    { ...plan, tiers: [{ ...plan.tiers[0], config: { width: 12 } }] },
    { ...plan, tiers: [{ ...plan.tiers[0], minActions: 100, maxActions: 99 }] }]) assert.throws(() => canonicalPlan(p));
  assert.equal(canonicalPlan({ ...plan, tiers: [{ ...plan.tiers[0], minActions: 30, maxActions: 70 }] }).tiers[0].maxActions, 70);
});

for (const [kind, names] of [
  ['array', [[], ['easy'], [['easy']]]],
  ['object', [{}, { toString: 'easy' }, { toString: () => 'easy' },
    { toString() { throw new Error('NAME_MUST_NOT_BE_COERCED'); } }]],
]) test(`${kind} tier names fail plan validation before creating a batch`, t => {
  const root = mkdtempSync(join(tmpdir(), 'fc-tier-name-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [index, name] of names.entries()) {
    const malformed = { ...plan, tiers: [{ ...plan.tiers[0], name }] };
    assert.throws(() => canonicalPlan(malformed), { message: 'INVALID_PLAN' });
    assert.throws(() => createBatch({ root, id: `invalid-name-${index}`, year: 2031,
      plan: malformed, sourceRevision: revision }), { message: 'INVALID_PLAN' });
    assert.deepEqual(readdirSync(root), [], 'invalid plans must leave no batch artifacts');
  }
});

test('locks refuse active owners, recover only dead same-host owners and preserve approved batches', t => {
  const f = fixture(t), lock = join(f.dir, '.lock'); mkdirSync(lock, { mode: 0o700 });
  const path = join(lock, 'owner.json'); save(path, { pid: process.pid, host: hostname() });
  assert.throws(() => generateBatch(f), /BATCH_LOCKED/); assert.throws(() => recoverLock(f), /LOCK_OWNER_ACTIVE/);
  save(path, { pid: 2147483647, host: 'different-host' }); assert.throws(() => recoverLock(f), /LOCK_RECOVERY_REFUSED/);
  save(path, { pid: 2147483647, host: hostname() }); assert.equal(recoverLock(f).status, 'stale-lock-removed');
  save(join(f.dir, '.tmp-' + 'b'.repeat(24)), { private: true }); assert.equal(cleanupTemporary(f).removed, 1);
  save(join(f.dir, 'APPROVED.json'), {}); assert.throws(() => generateBatch(f), /APPROVED_BATCH_IMMUTABLE/);
});

test('private store refuses repositories, public directories, traversal, loose permissions and symlinks', t => {
  const root = mkdtempSync(join(tmpdir(), 'fc-store-test-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = { root, id: 'safe', year: 2031, plan, sourceRevision: revision };
  assert.throws(() => createBatch({ ...input, root: process.cwd() }), /ROOT_MUST_BE_OUTSIDE_REPOSITORIES/);
  assert.throws(() => createBatch({ ...input, root: join(root, 'public') }), /PUBLIC_ROOT_REFUSED/);
  assert.throws(() => createBatch({ ...input, id: '../bad' }), /INVALID_BATCH_NAME/);
  chmodSync(root, 0o755); assert.throws(() => createBatch(input), /UNSAFE_PRIVATE_PATH/); chmodSync(root, 0o700);
  const alias = join(root, 'alias'); symlinkSync(root, alias); assert.throws(() => createBatch({ ...input, root: alias }));
  createBatch(input); const manifest = join(root, 'safe', 'manifest.json');
  const copy = json(manifest); unlinkSync(manifest); const elsewhere = join(root, 'elsewhere.json'); save(elsewhere, copy); symlinkSync(elsewhere, manifest);
  assert.throws(() => generateBatch(input), /UNSAFE_PRIVATE_PATH/);
});

test('CLI errors never disclose arguments, private fs paths or malformed JSON; offline imports reject network/db', t => {
  const f = fixture(t);
  const secret = 'DO-NOT-DISCLOSE-private-seed-and-path';
  const cli = args => spawnSync(process.execPath, ['--import', './tools/test-support/year-ahead-offline.mjs', 'tools/year-ahead/cli.js', ...args], { encoding: 'utf8' });
  for (const args of [['--command', secret], ['--command', 'validate', '--root', join(f.root, secret), '--id', 'missing'],
    ['--command', 'create', '--root', f.root, '--id', secret, '--year', '2031', '--plan', secret]]) {
    const child = cli(args); assert.equal(child.status, 1); assert.equal(child.stdout, '');
    assert.equal(child.stderr.includes(secret), false); assert.equal(child.stderr.split('\n').filter(Boolean).length, 1);
  }
  const child = cli(['--command', 'validate', '--root', f.root, '--id', f.id]);
  assert.equal(child.status, 1); assert.match(child.stderr, /BATCH_INCOMPLETE/);
  for (const specifier of ['mongoose', 'dotenv', 'node:net', 'node:http', 'node:child_process']) {
    const denied = spawnSync(process.execPath, ['--import', './tools/test-support/year-ahead-offline.mjs', '--input-type=module', '-e', `await import('${specifier}')`], { encoding: 'utf8' });
    assert.notEqual(denied.status, 0); assert.match(denied.stderr, /OFFLINE_IMPORT_REFUSED/);
  }
});

test('a real killed generator resumes the frozen private plan without replacing completed records', async t => {
  const { spawn } = await import('node:child_process');
  const { setTimeout: delay } = await import('node:timers/promises');
  const f = fixture(t), before = readFileSync(join(f.dir, 'manifest.json'), 'utf8');
  const child = spawn(process.execPath, ['--import', './tools/test-support/year-ahead-offline.mjs',
    'tools/year-ahead/cli.js', '--command', 'generate', '--root', f.root, '--id', f.id], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const deadline = Date.now() + 10000;
  while (!readdirSync(f.dir).some(n => /^\d{4}-/.test(n)) && child.exitCode === null && Date.now() < deadline) await delay(2);
  assert.ok(readdirSync(f.dir).some(n => /^\d{4}-/.test(n)), 'generator reached a durable record');
  child.kill('SIGKILL'); await exited;
  assert.equal(stdout, ''); assert.equal(stderr, '');
  const retained = readdirSync(f.dir).filter(n => /^\d{4}-/.test(n)).map(n => [n, readFileSync(join(f.dir, n), 'utf8')]);
  assert.ok(retained.length > 0 && retained.length < 365);
  assert.throws(() => generateBatch(f), /BATCH_LOCKED/);
  assert.equal(recoverLock(f).status, 'stale-lock-removed');
  cleanupTemporary(f);
  const resumed = spawnSync(process.execPath, ['--import', './tools/test-support/year-ahead-offline.mjs',
    'tools/year-ahead/cli.js', '--command', 'generate', '--root', f.root, '--id', f.id], { encoding: 'utf8', timeout: 30000 });
  assert.equal(resumed.status, 0, resumed.stderr); assert.equal(JSON.parse(resumed.stdout).total.accepted, 365);
  assert.equal(readFileSync(join(f.dir, 'manifest.json'), 'utf8'), before);
  for (const [name, content] of retained) assert.equal(readFileSync(join(f.dir, name), 'utf8'), content);
});

test('package and public source files exclude disposable private annual data', t => {
  const f = fixture(t);
  const m = json(join(f.dir, 'manifest.json'));
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(packed.status, 0, packed.stderr);
  const files = JSON.parse(packed.stdout)[0].files.map(f => f.path);
  assert.ok(files.includes('tools/year-ahead/batch.js'));
  assert.ok(!files.some(p => /manifest\.json$|COMPLETE\.json$|APPROVED\.json$|private-maze-batches|\.map$/.test(p)
    && !p.startsWith('config/')));
  for (const path of files) {
    const content = readFileSync(path);
    for (const seed of m.entries.flatMap(e => e.seeds)) assert.equal(content.includes(seed), false, 'package file contains a private seed');
  }
});

test('quality bounds reject a solvable candidate, retain its trial and advance to an independent seed', t => {
  const f = fixture(t, { plan: { schemaVersion: 1, maxCandidateSeeds: 8, tiers: [
    { name: 'bounded', weight: 1, config: { maxAttempts: 32 }, maxActions: 40 },
  ] } });
  const path = join(f.dir, 'manifest.json'), m = json(path), entry = m.entries[0];
  let accepted, rejected;
  for (let i = 1; (!accepted || !rejected) && i <= 100; i++) {
    const seed = i.toString(16).padStart(64, '0');
    const result = generateDaily({ date: entry.date, seed, config: m.plan.tiers[0].config });
    if (result.analysis.solution.minimumMoves <= 40) accepted ??= seed; else rejected ??= seed;
  }
  assert.ok(accepted && rejected); entry.seeds[0] = rejected; entry.seeds[1] = accepted;
  // Deliberately author a synthetic fixture, rather than simulate unnoticed corruption.
  const { contentHash, ...payload } = m; m.contentHash = hash(payload); save(path, m);
  try { generateBatch(f); } catch (error) { assert.equal(error.message, 'DATE_CANDIDATES_EXHAUSTED'); }
  const record = json(join(f.dir, `${entry.date}.json`));
  assert.equal(record.choice, 1); assert.deepEqual(record.trials.map(t => t.status), ['QUALITY_REJECTED', 'ACCEPTED']);
  assert.ok(record.metrics.actions <= 40);
  const report = summarize([record]); assert.equal(report.total.qualityRejectedSeeds, 1); assert.equal(report.total.seedTrials, 2);
});

test('a crash while sealing can recover its dead lock and hard-link twin without changing sealed bytes', t => {
  const f = fixture(t); generateBatch(f);
  const complete = join(f.dir, 'COMPLETE.json'), bytes = readFileSync(complete, 'utf8');
  const lock = join(f.dir, '.lock'); mkdirSync(lock, { mode: 0o700 });
  save(join(lock, 'owner.json'), { pid: 2147483647, host: hostname() });
  linkSync(complete, join(f.dir, '.tmp-' + 'c'.repeat(24)));
  assert.equal(recoverLock(f).status, 'stale-lock-removed');
  assert.equal(cleanupTemporary(f).removed, 1);
  assert.equal(readFileSync(complete, 'utf8'), bytes);
  assert.equal(validateBatch(f).total.accepted, 365);
});
