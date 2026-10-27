import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { generateDaily, generationIdentity, canonicalConfig, verifyCandidate, hash, GenerationError } from '../lib/maze/engine.js';
import { validateDate, utcDate, inclusiveDates, isDateAdmitted } from '../lib/maze/dates.js';
import { generate as legacyGenerate, algorithmVersion as legacyVersion } from '../tools/maze-analyzer/generator.js';
import { carveCandidate } from '../lib/maze/candidate-v1.js';
import { seededRandom } from '../lib/maze/random-v1.js';
import { compile, coordinate, initialState, transition } from '../tools/maze-analyzer/solver.js';
import { move } from './fixtures/client-movement.js';
import Maze from '../models/Maze.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/daily-maze-v1.json', import.meta.url)));
const cli = (args, { nodeArgs = [], ...extra } = {}) => spawnSync(process.execPath, [...nodeArgs, 'tools/daily-maze/cli.js', ...args],
  { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, ...extra });

function replay(result) {
  const { maze, analysis } = result, compiled = compile(maze.grid);
  let client = { grid: structuredClone(maze.grid), position: coordinate(compiled, compiled.start), inventory: [], completed: false };
  let state = initialState(compiled);
  for (const action of analysis.solution.actions) {
    const before = client;
    state = transition(compiled, state, action);
    client = move(client, action).state;
    assert.ok(state);
    assert.deepEqual(client.position, coordinate(compiled, state.pos));
    assert.equal(client.inventory.includes('extinguisher'), state.inventory);
    if (state.interaction === 'extinguish') {
      assert.deepEqual(client.position, before.position);
      assert.deepEqual(client.inventory, []);
    }
  }
  assert.equal(client.completed, true);
  assert.equal(state.pos, compiled.goal);
  assert.equal(hash(maze.grid), result.gridHash, 'replay never mutates stored grid');
}

test('v1 snapshots retain grids, identities, rejection traces and canonical replay at both sizes', () => {
  for (const fixture of fixtures.accepted) {
    const result = generateDaily(fixture.input);
    assert.equal(result.gridHash, fixture.gridHash);
    assert.equal(result.identityHash, fixture.identityHash);
    assert.deepEqual(result.attempts, fixture.attempts);
    if (fixture.grid) assert.deepEqual(result.maze.grid, fixture.grid.map(row => [...row]));
    assert.equal(result.analysis.solution.status, 'solved');
    assert.deepEqual(result.analysis.solution.unreachableItems, []);
    assert.equal(new Maze(result.maze).validateSync(), undefined);
    replay(result);
  }
  assert.ok(fixtures.accepted.some(f => f.input.config?.width === 21));
  assert.ok(fixtures.accepted.some(f => generateDaily(f.input).analysis.solution.interactions.some(i => i.type === 'extinguish')));
});

test('same config canonicalizes in any order; random globals, mutation and call order cannot change output', () => {
  const input = { date: '2026-01-01', config: { width: 21, height: 21 } };
  const expected = generateDaily(input);
  const random = Math.random;
  try {
    Math.random = () => { throw new Error('global RNG used'); };
    generateDaily({ date: '2028-02-29' });
    const actual = generateDaily({ date: input.date, config: { height: 21, width: 21 } });
    assert.equal(JSON.stringify(actual), JSON.stringify(expected));
    actual.maze.grid[0][0] = 'S';
    assert.deepEqual(generateDaily(input), expected);
  } finally { Math.random = random; }
  assert.deepEqual(input.config, { width: 21, height: 21 });
  assert.equal(Object.isFrozen(canonicalConfig()), true);
  for (const options of [{ date: '2026-01-02' }, { date: input.date, seed: 'override' },
    { date: input.date, config: { width: 21 } }, { date: input.date, config: { maxAttempts: 11 } }]) {
    assert.notEqual(generationIdentity(options).identityHash, expected.identityHash);
    assert.notEqual(generateDaily(options).gridHash, expected.gridHash);
  }
});

test('fresh processes and UTC/DST timezones emit byte-identical output', () => {
  for (const fixture of fixtures.accepted) {
    const args = ['--date', fixture.input.date];
    if (fixture.input.seed) args.push('--seed', fixture.input.seed);
    for (const key of ['width', 'height']) {
      if (fixture.input.config?.[key]) args.push(`--${key}`, String(fixture.input.config[key]));
    }
    const outputs = ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati'].map(TZ => {
      const child = cli(args, { env: { ...process.env, TZ } });
      assert.equal(child.status, 0, child.stderr);
      assert.equal(JSON.parse(child.stdout).records[0].gridHash, fixture.gridHash);
      assert.equal(JSON.parse(child.stdout).records[0].identityHash, fixture.identityHash);
      return child.stdout;
    });
    assert.equal(outputs[0], outputs[1]); assert.equal(outputs[1], outputs[2]);
  }
});

test('endpoint protection repairs legacy marker overwrite with the identical candidate RNG stream', () => {
  for (const seed of ['sprint4-128', 'sprint4-136', 'sprint4-235']) {
    assert.throws(() => legacyGenerate(seed), /Cannot read properties of null/);
    const candidate = carveCandidate(seed, { width: 13, height: 17, minDistance: 25, preserveEndpoints: true }, seededRandom(seed));
    assert.equal(verifyCandidate(candidate.grid, {}).code, 'ACCEPTED');
  }
});

test('retained legacy version pins sprint4-42; unknown versions never fall back', () => {
  assert.equal(legacyVersion, 'legacy-analyzer-v1');
  for (const fixture of fixtures.legacyRejected) assert.throws(() => legacyGenerate(fixture.seed), { message: fixture.message });
  assert.throws(() => generateDaily({ date: '2026-01-01', version: 'daily-dfs-v2' }), /UNSUPPORTED_ALGORITHM_VERSION/);
  const daily = generateDaily({ date: '2026-01-01', seed: 'sprint4-0' });
  assert.notEqual(daily.algorithmVersion, legacyVersion);
  assert.notEqual(daily.gridHash, hash(legacyGenerate('sprint4-0').grid));
});

test('exhaustion is repeatable, bounded, diagnostic, and contains no partial grid', () => {
  for (const fixture of fixtures.exhausted) {
    const capture = () => {
      try { generateDaily(fixture.input); assert.fail('expected exhaustion'); }
      catch (error) {
        assert.ok(error instanceof GenerationError);
        assert.equal(error.code, 'GENERATION_EXHAUSTED');
        assert.equal(error.maze, undefined);
        assert.equal(error.grid, undefined);
        assert.deepEqual(error.attempts, fixture.attempts);
        assert.equal(error.attempts.length, error.identity.config.maxAttempts);
        return JSON.stringify(error);
      }
    };
    assert.equal(capture(), capture());
  }
});

test('candidate verification refuses missing markers, border violations, inaccessible pickups and limits', () => {
  const config = { width: 5, height: 5, minDistance: 1 };
  const rows = lines => lines.map(line => [...line]);
  assert.equal(verifyCandidate(rows(['#####', '#SEXF', '#####', '#####', '#####']), config).code, 'BORDER_REJECTED');
  assert.equal(verifyCandidate(rows(['#####', '#SE##', '#####', '#####', '#####']), config).code, 'TILE_COUNTS_REJECTED');
  assert.equal(verifyCandidate([], config).code, 'GRID_SHAPE_REJECTED');
  assert.equal(verifyCandidate(rows(['#####', '#SEX#', '###F#', '#####', '#####']), config).code, 'EXTINGUISHER_UNREACHABLE_BEFORE_EXIT');
  assert.equal(verifyCandidate(rows(['#####', '#SFE#', '#X###', '#####', '#####']), { ...config, maxStates: 1 }).code, 'SOLVER_LIMIT');
  assert.equal(verifyCandidate(rows(['#####', '#SF##', '##XE#', '#####', '#####']), config).code, 'UNSOLVABLE');
});

test('actual calendar dates and explicit instants define UTC boundaries without local clock defaults', () => {
  for (const date of ['0001-01-01', '1900-02-28', '2000-02-29', '2025-05-26', '2028-02-29', '9999-12-31']) {
    assert.equal(validateDate(date), date);
  }
  for (const date of ['2025-02-29', '1900-02-29', '2026-04-31', '2026-00-01', '2026-13-01', '2026-1-01',
    '0000-01-01', '2026-01-01T00:00:00Z', '', null, undefined]) assert.throws(() => validateDate(date));
  const boundaries = [
    ['2028-02-29T23:59:59-08:00', '2028-03-01'],
    ['2026-01-01T00:15:00+14:00', '2025-12-31'],
    ['2026-03-08T01:59:59-08:00', '2026-03-08'],
    ['2026-03-08T03:00:00-07:00', '2026-03-08'],
    ['2026-11-01T01:30:00-07:00', '2026-11-01'],
    ['2026-11-01T01:30:00-08:00', '2026-11-01'],
  ];
  for (const [instant, date] of boundaries) {
    assert.equal(utcDate(instant), date);
    assert.equal(generateDaily({ date: utcDate(instant) }).gridHash, generateDaily({ date }).gridHash);
  }
  for (const instant of ['2026-01-01', '2026-01-01T01:00:00', '2026-02-30T00:00:00Z',
    '2026-01-01T24:00:00Z', '2026-01-01T00:00:00+25:00', new Date(NaN), null, undefined]) assert.throws(() => utcDate(instant));
  assert.equal(utcDate(new Date('2026-01-01T00:00:00Z')), '2026-01-01');
  assert.equal(utcDate(Date.parse('2026-01-01T00:00:00Z')), '2026-01-01');
  assert.equal(isDateAdmitted('2026-01-01', '2025-12-31T23:59:59.999Z'), false);
  assert.equal(isDateAdmitted('2026-01-01', '2026-01-01T00:00:00.000Z'), true);
  assert.equal(isDateAdmitted('2025-05-26', '2026-01-01T00:00:00Z'), true);
});

test('inclusive ranges span full years, leap days, DST and old season boundaries with a hard cap', () => {
  assert.equal(inclusiveDates('2026-01-01', '2026-12-31').length, 365);
  assert.equal(inclusiveDates('2028-01-01', '2028-12-31').length, 366);
  assert.deepEqual(inclusiveDates('2028-02-28', '2028-03-01'), ['2028-02-28', '2028-02-29', '2028-03-01']);
  assert.deepEqual(inclusiveDates('2026-03-07', '2026-03-09'), ['2026-03-07', '2026-03-08', '2026-03-09']);
  assert.equal(inclusiveDates('2025-09-01', '2025-09-01').length, 1);
  for (const [start, end] of [['2026-02-02', '2026-02-01'], ['2026-01-01', '2027-01-02'], ['bad', '2026-01-01']]) {
    assert.throws(() => inclusiveDates(start, end));
  }
});

test('a full leap year replays through client rules with fixed aggregate hash and retry counts', () => {
  const records = inclusiveDates(fixtures.year.start, fixtures.year.end).map(date => generateDaily({ date }));
  for (const result of records) replay(result);
  assert.equal(records.length, 366);
  assert.equal(hash(records.map(r => [r.date, r.gridHash, r.attempts])), fixtures.year.hash);
  assert.equal(records.reduce((sum, r) => sum + r.acceptedAttempt, 0), fixtures.year.rejections);
});

test('invalid engine inputs fail closed before candidate generation', () => {
  for (const config of [null, [], { typo: 1 }, { width: 4 }, { height: 3 }, { width: 103 }, { height: 5.5 },
    { maxAttempts: 0 }, { maxAttempts: 33 }, { fireAttempts: -1 }, { endpointAttempts: 0 }, { minDistance: 0 },
    { maxStates: 0 }, { maxStates: 100001 }, { tileRules: 'other' }, { minDistance: NaN }]) {
    assert.throws(() => generateDaily({ date: '2026-01-01', config }));
  }
  for (const seed of ['', 123, 'x'.repeat(257)]) assert.throws(() => generateDaily({ date: '2026-01-01', seed }));
});

test('CLI is offline under denied network/process/database capabilities; ranges have atomic stdout', () => {
  const child = cli(['--date', '2026-01-01'], {
    nodeArgs: ['--import', './tools/test-support/offline-only.mjs'],
    env: { ...process.env, MONGO_URI: 'synthetic-do-not-connect', MONGODB_URI: 'synthetic-do-not-connect' },
  });
  assert.equal(child.status, 0, child.stderr);
  for (const specifier of ['mongoose', 'dotenv', 'node:net', 'node:http', 'node:child_process']) {
    const refused = spawnSync(process.execPath, ['--import', './tools/test-support/offline-only.mjs',
      '--input-type=module', '-e', `await import(${JSON.stringify(specifier)})`], { encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /OFFLINE_IMPORT_REFUSED/);
  }
  const parsed = JSON.parse(child.stdout);
  assert.equal(parsed.mode, 'offline-dry-run');
  assert.equal(parsed.records[0].solution.status, 'solved');
  const range = cli(['--range', '2028-02-28:2028-03-01']);
  assert.equal(range.status, 0, range.stderr);
  assert.equal(JSON.parse(range.stdout).records.length, 3);
  for (const args of [[], ['--date', '2026-02-30'], ['--date', '2026-01-01', '--range', '2026-01-01:2026-01-02'],
    ['--range', '2026-01-02:2026-01-01'], ['--range', '2026-01-01:2027-01-02'],
    ['--range', '2026-01-01:2026-01-02', '--seed', 'x'], ['--date', '2026-01-01', '--width', '4']]) {
    const invalid = cli(args); assert.equal(invalid.status, 1, invalid.stderr); assert.equal(invalid.stdout, '');
  }
  const exhausted = cli(['--range', '2026-01-01:2026-01-03', '--min-distance', '10201', '--max-attempts', '2']);
  assert.equal(exhausted.status, 2, exhausted.stderr); assert.equal(exhausted.stdout, '');
  assert.equal(JSON.parse(exhausted.stderr).attempts.length, 2);
  // The first day succeeds, then the second exhausts: buffered output is discarded.
  const laterFailure = cli(['--range', '2026-01-03:2026-01-04', '--max-attempts', '1']);
  assert.equal(laterFailure.status, 2, laterFailure.stderr);
  assert.equal(JSON.parse(laterFailure.stderr).date, '2026-01-04');
  assert.equal(laterFailure.stdout, '');
});
