import { createHash } from 'node:crypto';
import { seededRandom, rngVersion } from './random-v2.js';

export const algorithmVersion = 'daily-dfs-v2';
export const tileRules = 'stamp-card-interact-v2';
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const dirs = Object.freeze({ up: [-1, 0], right: [0, 1], down: [1, 0], left: [0, -1] });
const key = ([r, c]) => `${r},${c}`;
const equal = (a, b) => a[0] === b[0] && a[1] === b[1];
const passable = (g, [r, c]) => g[r]?.[c] !== undefined && g[r][c] !== '#';
const neighbors = (g, p) => Object.values(dirs).map(([dr, dc]) => [p[0] + dr, p[1] + dc]).filter(q => passable(g, q));
function find(g, tile) { const result = []; g.forEach((row, r) => row.forEach((v, c) => { if (v === tile) result.push([r, c]); })); return result; }
function route(g, from, to) {
  const queue = [from], parent = new Map([[key(from), null]]), points = new Map([[key(from), from]]);
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i]; if (equal(p, to)) break;
    for (const q of neighbors(g, p)) if (!parent.has(key(q))) { parent.set(key(q), key(p)); points.set(key(q), q); queue.push(q); }
  }
  if (!parent.has(key(to))) return null;
  const path = []; for (let k = key(to); k !== null; k = parent.get(k)) path.push(points.get(k));
  return path.reverse();
}
export function canonicalConfig(input = {}) {
  const defaults = { width: 13, height: 17, minDistance: 25, maxAttempts: 32, tileRules };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !(k in defaults))) throw new Error('INVALID_CONFIG');
  const c = { ...defaults, ...input };
  if (['width', 'height'].some(k => !Number.isInteger(c[k]) || c[k] < 5 || c[k] > 101 || c[k] % 2 !== 1)
    || !Number.isInteger(c.minDistance) || c.minDistance < 2 || c.minDistance > c.width * c.height
    || !Number.isInteger(c.maxAttempts) || c.maxAttempts < 1 || c.maxAttempts > 128 || c.tileRules !== tileRules) throw new Error('INVALID_CONFIG');
  return Object.freeze(c);
}
function carve(width, height, random) {
  const g = Array.from({ length: height }, () => Array(width).fill('#'));
  const stack = [[1, 1]]; g[1][1] = ' ';
  while (stack.length) {
    const [r, c] = stack.at(-1);
    const choices = Object.values(dirs).map(([dr, dc]) => [r + 2 * dr, c + 2 * dc, r + dr, c + dc])
      .filter(([nr, nc]) => nr > 0 && nc > 0 && nr < height - 1 && nc < width - 1 && g[nr][nc] === '#');
    if (!choices.length) { stack.pop(); continue; }
    const [nr, nc, mr, mc] = choices[Math.floor(random() * choices.length)];
    g[mr][mc] = ' '; g[nr][nc] = ' '; stack.push([nr, nc]);
  }
  return g;
}
// Pure state model. interact works only while standing on P; repeated presses are idempotent.
export function initialState(grid) { const [start] = find(grid, 'S'); if (!start) throw new Error('MISSING_START'); return { position: start, stamped: false, completed: false }; }
export function transition(grid, required, state, input) {
  if (state.completed) return state;
  if (input === 'interact') return { ...state, stamped: state.stamped || grid[state.position[0]][state.position[1]] === 'P' };
  const delta = dirs[input]; if (!delta) return state;
  const next = [state.position[0] + delta[0], state.position[1] + delta[1]];
  if (!passable(grid, next)) return state;
  return { ...state, position: next, completed: grid[next[0]][next[1]] === 'E' && (!required || state.stamped) };
}
export function solve(grid, required) {
  const first = initialState(grid), nodes = [{ state: first, parent: -1, input: null }], seen = new Set([`${key(first.position)}/0`]);
  let end = -1;
  for (let i = 0; i < nodes.length; i++) {
    const current = nodes[i].state;
    if (current.completed) { end = i; break; }
    for (const input of [...Object.keys(dirs), 'interact']) {
      const next = transition(grid, required, current, input), k = `${key(next.position)}/${Number(next.stamped)}`;
      if (seen.has(k)) continue;
      seen.add(k); nodes.push({ state: next, parent: i, input });
    }
  }
  if (end < 0) return { solvable: false, actions: null };
  const actions = [], positions = [];
  for (let i = end; i >= 0; i = nodes[i].parent) { positions.push(nodes[i].state.position); if (nodes[i].input) actions.push(nodes[i].input); }
  actions.reverse(); positions.reverse();
  return { solvable: true, actions, positions, movementSteps: actions.filter(a => a !== 'interact').length,
    turns: actions.filter((a, i) => a !== 'interact' && i > 0 && actions[i - 1] !== 'interact' && a !== actions[i - 1]).length };
}
export function verify(grid, tier) {
  if (!['easy', 'medium', 'hard'].includes(tier) || !Array.isArray(grid) || !grid.length || grid.some(row => !Array.isArray(row) || row.length !== grid[0].length)) return { code: 'INVALID_GRID' };
  const cells = grid.flat(), required = tier !== 'easy';
  if (cells.some(t => !['#', ' ', 'S', 'E', 'P'].includes(t)) || find(grid, 'S').length !== 1 || find(grid, 'E').length !== 1 || find(grid, 'P').length !== Number(required)) return { code: 'INVALID_TILES' };
  if (grid[0].some(x => x !== '#') || grid.at(-1).some(x => x !== '#') || grid.some(row => row[0] !== '#' || row.at(-1) !== '#')) return { code: 'INVALID_BORDER' };
  const start = find(grid, 'S')[0], exit = find(grid, 'E')[0], direct = route(grid, start, exit);
  const open = cells.filter(x => x !== '#').length;
  if (!direct || route(grid, start, start).length !== 1) return { code: 'DISCONNECTED' };
  const seen = new Set(direct.map(key)), all = routeReach(grid, start);
  if (all.size !== open || [...all].reduce((n, k) => n + neighbors(grid, k.split(',').map(Number)).length, 0) / 2 !== open - 1) return { code: 'NOT_TREE' };
  const station = required ? find(grid, 'P')[0] : null;
  if (required && seen.has(key(station))) return { code: 'STATION_ON_DIRECT_ROUTE' };
  const solved = solve(grid, required);
  if (!solved.solvable) return { code: 'UNSOLVABLE' };
  const stem = station && route(grid, start, station), junction = station && [...stem].reverse().find(p => seen.has(key(p)));
  const depth = station ? route(grid, junction, station).length - 1 : 0;
  const detour = solved.movementSteps - (direct.length - 1);
  if (required && (depth < 1 || detour !== 2 * depth || solved.actions.filter(a => a === 'interact').length !== 1)) return { code: 'INVALID_DETOUR' };
  const branch = station && route(grid, junction, station), branchSet = new Set(branch?.map(key));
  const misleading = branch ? branch.flatMap(p => neighbors(grid, p)).filter(p => !branchSet.has(key(p)) && !seen.has(key(p))).length : 0;
  if (tier === 'medium' && (depth < 2 || depth > 8)) return { code: 'MEDIUM_BRANCH_DEPTH_REJECTED' };
  if (tier === 'hard' && depth < 9) return { code: 'HARD_BRANCH_DEPTH_REJECTED' };
  if (tier === 'hard' && misleading < 1) return { code: 'HARD_MISLEADING_BRANCH_REJECTED' };
  const degrees = [...all].map(k => neighbors(grid, k.split(',').map(Number)).length);
  return { code: 'ACCEPTED', metrics: { directDistance: direct.length - 1, mandatoryBacktrack: detour, detourRatio: detour / (direct.length - 1), branchDepth: depth,
    misleadingBranches: misleading, deadEnds: degrees.filter(d => d === 1).length, decisionPoints: degrees.filter(d => d >= 3).length,
    movementSteps: solved.movementSteps, optimalInputs: solved.actions.length, turns: solved.turns, visitedRatio: new Set(solved.positions.map(key)).size / open,
    navigationBurden: solved.actions.length + degrees.filter(d => d >= 3).length + misleading * 2 } };
}
function routeReach(grid, start) { const out = new Set([key(start)]), q = [start]; for (let i = 0; i < q.length; i++) for (const p of neighbors(grid, q[i])) if (!out.has(key(p))) { out.add(key(p)); q.push(p); } return out; }
export function generate({ seed, tier, config = {} }) {
  if (typeof seed !== 'string' || !seed.length || seed.length > 256 || !['easy', 'medium', 'hard'].includes(tier)) throw new Error('INVALID_IDENTITY');
  const c = canonicalConfig(config), identityHash = hash([algorithmVersion, rngVersion, tier, c, seed]);
  const rejections = {};
  for (let attempt = 0; attempt < c.maxAttempts; attempt++) {
    const random = seededRandom(hash([identityHash, attempt]));
    const grid = carve(c.width, c.height, random), walk = [];
    grid.forEach((row, r) => row.forEach((t, col) => { if (t === ' ') walk.push([r, col]); }));
    const endpoints = [walk[Math.floor(random() * walk.length)], walk[Math.floor(random() * walk.length)]];
    if (equal(...endpoints)) { rejections.ENDPOINTS = (rejections.ENDPOINTS || 0) + 1; continue; }
    const direct = route(grid, ...endpoints);
    if (direct.length - 1 < c.minDistance) { rejections.DISTANCE = (rejections.DISTANCE || 0) + 1; continue; }
    const [s, e] = endpoints; grid[s[0]][s[1]] = 'S'; grid[e[0]][e[1]] = 'E';
    if (tier !== 'easy') {
      const directSet = new Set(direct.map(key));
      const options = walk.filter(p => !directSet.has(key(p))).map(p => {
        const stem = route(grid, s, p), j = [...stem].reverse().find(x => directSet.has(key(x)));
        const depth = route(grid, j, p).length - 1;
        const misleading = route(grid, j, p).flatMap(x => neighbors(grid, x)).filter(x => !directSet.has(key(x)) && !stem.some(y => equal(x, y))).length;
        return { p, depth, misleading };
      }).filter(x => tier === 'medium' ? x.depth >= 2 && x.depth <= 8 : x.depth >= 9 && x.misleading >= 1);
      if (!options.length) { rejections.PLACEMENT = (rejections.PLACEMENT || 0) + 1; continue; }
      options.sort((a, b) => tier === 'medium' ? a.depth - b.depth : b.depth + b.misleading - a.depth - a.misleading);
      const pool = options.slice(0, Math.max(1, Math.ceil(options.length / 4)));
      const p = pool[Math.floor(random() * pool.length)].p; grid[p[0]][p[1]] = 'P';
    }
    const check = verify(grid, tier);
    if (check.code !== 'ACCEPTED') { rejections[check.code] = (rejections[check.code] || 0) + 1; continue; }
    return { algorithmVersion, rngVersion, tileRules, tier, config: c, seed, identityHash, acceptedAttempt: attempt, rejections, grid, metrics: check.metrics };
  }
  const error = new Error('GENERATION_EXHAUSTED'); error.rejections = rejections; throw error;
}
