import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { compile, initialState, transition, solve, coordinate, stateKey, directions } from '../tools/maze-analyzer/solver.js';
import { analyze } from '../tools/maze-analyzer/analyzer.js';
import { generate, seededRandom } from '../tools/maze-analyzer/generator.js';
import { batch, summarize } from '../tools/maze-analyzer/batch.js';
import { move } from './fixtures/client-movement.js';

const result = rows => analyze(rows);
test('simple path, blocked goal, and boundary rejection', () => {
  const r = result(['S E']);
  assert.equal(r.solution.minimumMoves, 2);
  assert.deepEqual(r.solution.actions, ['right', 'right']);
  assert.deepEqual(r.solution.path, [[0, 0], [0, 1], [0, 2]]);
  assert.equal(result(['S#E']).solution.solvable, false);
  const maze = compile(['SE']);
  assert.equal(transition(maze, initialState(maze), 'up'), null);
});
test('fire needs an extinguisher and an extra stationary input', () => {
  const r = result(['SXF E']).solution;
  assert.equal(r.minimumMoves, 5);
  assert.equal(r.movementSteps, 4);
  assert.deepEqual(r.path.slice(1, 4), [[0, 1], [0, 1], [0, 2]]);
  assert.deepEqual(r.interactions.map(x => x.type), ['pickup', 'extinguish']);
  assert.equal(result(['SFE']).solution.solvable, false);
  assert.equal(result(['SXFFE']).solution.solvable, false);
});
test('a legal detour beats a blocked geometric shortcut, without mutating input', () => {
  const grid = ['SFE', ' # ', '   '];
  const before = JSON.stringify(grid), r = result(grid);
  assert.equal(r.solution.minimumMoves, 6);
  assert.deepEqual(r.solution.interactions, []);
  assert.equal(JSON.stringify(grid), before);
  assert.equal(result(['SE']).heuristics.estimatedDifficulty, 'easy');
});
test('inventory does not stack, pickups disappear even when full', () => {
  assert.equal(result(['SXXFFE']).solution.solvable, false);
  assert.equal(result(['SXFXFE']).solution.solvable, true);
});
test('state-dependent detour revisits a position with inventory and cleared fire', () => {
  const r = result(['#######', '#S F E#', '## ####', '##X####', '#######']).solution;
  assert.equal(r.minimumMoves, 9);
  assert.equal(r.interactions.length, 2);
  assert.equal(r.path.filter(p => p[0] === 1 && p[1] === 2).length, 3);
});
test('multiple equal shortest routes and exact geometry', () => {
  const r = result(['S ', ' E']);
  assert.equal(r.solution.minimumMoves, 2);
  assert.equal(r.solution.shortestSolutions, 2);
  assert.equal(r.exact.geometricCycleRank, 1);
  assert.equal(r.exact.nonWallCells, 4);
  assert.equal(r.exact.deadEnds, 0);
});
test('limits are inconclusive; malformed grids fail explicitly', () => {
  const r = result(['SE']);
  assert.equal(r.solution.solvable, true);
  assert.equal(solve(compile(['SE']), { maxStates: 1 }).solvable, null);
  for (const grid of [[], ['S'], ['SSE'], ['SE?'], ['S E', '#'], ['E']]) {
    assert.throws(() => compile(grid));
  }
  assert.throws(() => solve(compile(['SE']), { maxStates: 0 }));
});
test('missing and inaccessible items are reported independently of solvability', () => {
  assert.ok(result(['SFE']).issues.includes('missing-extinguisher'));
  assert.deepEqual(result(['SE#X']).solution.unreachableItems, [[0, 3]]);
});

// Compare every outgoing edge of every reachable state with actual client code.
function compareClient(rows) {
  const maze = compile(rows), queue = [initialState(maze)], visited = new Set([stateKey(queue[0])]);
  for (let i = 0; i < queue.length; i++) {
    const state = queue[i];
    const grid = maze.cells.map((tile, pos) => state.changed & (maze.bits.get(pos) || 0n) ? ' ' : tile);
    const client = { grid: Array.from({ length: maze.height }, (_, r) => grid.slice(r * maze.width, (r + 1) * maze.width)),
      position: coordinate(maze, state.pos), inventory: state.inventory ? ['extinguisher'] : [], completed: state.pos === maze.goal };
    for (const direction of Object.keys(directions)) {
      const actual = move(client, direction).state, next = transition(maze, state, direction);
      if (next === null) { assert.equal(actual, client); continue; }
      assert.deepEqual(actual.position, coordinate(maze, next.pos));
      assert.equal(actual.inventory.includes('extinguisher'), next.inventory);
      assert.equal(actual.completed, next.pos === maze.goal);
      actual.grid.flat().forEach((tile, pos) => {
        assert.equal(tile, next.changed & (maze.bits.get(pos) || 0n) ? ' ' : maze.cells[pos]);
      });
      const key = stateKey(next);
      if (!visited.has(key)) { visited.add(key); queue.push(next); }
    }
  }
}
test('all reachable transitions agree with pinned client rules', () => {
  for (const rows of [['SXXFFE'], ['SXFXFE'], ['S F E', ' X#X ', '     '], ['S ', ' E']]) compareClient(rows);
});
test('seed adapter matches unchanged generator with the same RNG stream', () => {
  const source = readFileSync(new URL('../scripts/generateMazes.js', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('const placeFireAndExtinguisher ='), source.indexOf('const run = async'));
  const random = seededRandom('sprint4-0'), math = Object.create(Math); math.random = random;
  const expected = vm.runInNewContext(`${fn}\ngenerateDummyMaze('sprint4-0');`, { Math: math });
  assert.deepEqual(JSON.parse(JSON.stringify(generate('sprint4-0'))), JSON.parse(JSON.stringify(expected)));
  assert.equal(JSON.stringify(generate('sprint4-0')), JSON.stringify(generate('sprint4-0')));
  assert.throws(() => generate('sprint4-42'), /unreachable/);
  assert.throws(() => generate('a', { width: 4 }));
});
test('deterministic batch replay, generated paths agree with client', () => {
  const first = [...batch({ count: 50 })];
  assert.deepEqual([...batch({ count: 50 })], first);
  assert.ok(first.some(r => r.error));
  for (const record of first.filter(r => r.solution?.solvable).slice(0, 10)) {
    const grid = JSON.parse(JSON.stringify(generate(record.seed).grid));
    const solution = result(grid).solution;
    const maze = compile(grid);
    let state = { grid, position: coordinate(maze, maze.start), inventory: [], completed: false };
    for (const action of solution.actions) state = move(state, action).state;
    assert.equal(state.completed, true);
  }
});
test('CLI JSON/JSONL/CSV are parseable, deterministic and reject bad options', () => {
  const cli = args => {
    const dir = mkdtempSync(join(tmpdir(), 'maze-cli-'));
    const output = join(dir, 'stdout'), fd = openSync(output, 'w');
    try {
      const child = spawnSync(process.execPath, ['tools/maze-analyzer/cli.js', ...args], { stdio: ['ignore', fd, 'inherit'] });
      assert.equal(child.status, 0);
      return readFileSync(output, 'utf8');
    } finally { closeSync(fd); rmSync(dir, { recursive: true, force: true }); }
  };
  const report = JSON.parse(cli(['--batch', '10']));
  assert.deepEqual(report.summary, summarize(report.records));
  assert.equal(report.metadata.options.count, 10);
  const lines = cli(['--batch', '10', '--format', 'jsonl']).trim().split('\n').map(x => JSON.parse(x));
  assert.deepEqual(lines.slice(1), report.records);
  assert.equal(cli(['--batch', '2', '--format', 'csv']).trim().split('\n').length, 3);
  assert.equal(JSON.parse(cli(['--seed', 'sprint4-0'])).solution.solvable, true);
  for (const args of [[], ['--batch', '-1'], ['--seed', 'x', '--batch', '2'], ['--batch', '2', '--width', '4'], ['--batch', '2', '--format', 'bad']]) {
    assert.equal(spawnSync(process.execPath, ['tools/maze-analyzer/cli.js', ...args]).status, 1);
  }
});
test('large batches run in a 64 MiB V8 heap and streaming output is bounded', { timeout: 60000 }, () => {
  const child = spawnSync(process.execPath, ['--max-old-space-size=64', 'tools/maze-analyzer/cli.js', '--batch', '5000', '--format', 'jsonl'],
    { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 55000 });
  assert.equal(child.status, 0, child.stderr);
});
