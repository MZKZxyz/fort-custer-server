export const directions = Object.freeze({ up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] });
export function compile(grid) {
  if (!Array.isArray(grid) || !grid.length || grid.length > 101) throw new Error('Invalid grid height');
  const rows = grid.map(row => typeof row === 'string' ? [...row] : Array.from(row));
  const width = rows[0].length;
  if (!width || width > 101 || rows.some(row => row.length !== width)) throw new Error('Grid must be rectangular, at most 101 by 101');
  const cells = rows.flat(), starts = [], goals = [], items = [], fires = [], bits = new Map();
  cells.forEach((tile, pos) => {
    if (!['#', ' ', 'S', 'E', 'X', 'F'].includes(tile)) throw new Error(`Unknown tile at ${pos}: ${tile}`);
    if (tile === 'S') starts.push(pos);
    if (tile === 'E') goals.push(pos);
    if (tile === 'X' || tile === 'F') {
      bits.set(pos, 1n << BigInt(bits.size));
      (tile === 'X' ? items : fires).push(pos);
    }
  });
  if (starts.length !== 1 || goals.length !== 1) throw new Error('Exactly one S and one E required');
  return { cells, width, height: rows.length, start: starts[0], goal: goals[0], items, fires, bits };
}
export const initialState = maze => ({ pos: maze.start, inventory: false, changed: 0n });
export const stateKey = s => `${s.pos}/${Number(s.inventory)}/${s.changed}`;
export const coordinate = (maze, pos) => [Math.floor(pos / maze.width), pos % maze.width];

// One accepted directional input. null means a blocked/invalid input.
export function transition(maze, state, direction) {
  const delta = Object.prototype.hasOwnProperty.call(directions, direction) ? directions[direction] : null;
  if (!delta || state.pos === maze.goal) return null;
  const [r, c] = coordinate(maze, state.pos);
  const nr = r + delta[0], nc = c + delta[1];
  if (nr < 0 || nc < 0 || nr >= maze.height || nc >= maze.width) return null;
  const target = nr * maze.width + nc;
  let tile = maze.cells[target];
  const bit = maze.bits.get(target) || 0n;
  if (state.changed & bit) tile = ' ';
  if (tile === '#' || (tile === 'F' && !state.inventory)) return null;
  return {
    pos: tile === 'F' ? state.pos : target,
    inventory: tile === 'X' ? true : tile === 'F' ? false : state.inventory,
    changed: state.changed | bit,
    interaction: tile === 'X' ? 'pickup' : tile === 'F' ? 'extinguish' : null,
    target,
  };
}

export function solve(maze, { maxStates = 100000 } = {}) {
  if (!Number.isInteger(maxStates) || maxStates < 1 || maxStates > 1000000) throw new Error('maxStates must be 1..1000000');
  const first = initialState(maze);
  const nodes = [{ ...first, parent: -1, depth: 0, ways: 1 }];
  const visited = new Map([[stateKey(first), 0]]), reachedItems = new Set();
  let head = 0, best = -1, limited = false, shortestSolutions = 0, countCapped = false;
  const cap = 1000000000;
  while (head < nodes.length && !limited) {
    const index = head++, node = nodes[index];
    if (node.pos === maze.goal) {
      if (best === -1) best = index;
      if (node.depth === nodes[best].depth) {
        const total = shortestSolutions + node.ways;
        if (total > cap) countCapped = true;
        shortestSolutions = Math.min(cap, total);
      }
      continue;
    }
    for (const direction of Object.keys(directions)) {
      const next = transition(maze, node, direction);
      if (!next) continue;
      if (next.interaction === 'pickup') reachedItems.add(next.target);
      const key = stateKey(next), existing = visited.get(key);
      if (existing !== undefined) {
        if (nodes[existing].depth === node.depth + 1) {
          const total = nodes[existing].ways + node.ways;
          if (total > cap) countCapped = true;
          nodes[existing].ways = Math.min(cap, total);
        }
        continue;
      }
      if (nodes.length === maxStates) { limited = true; break; }
      visited.set(key, nodes.length);
      nodes.push({ ...next, parent: index, direction, depth: node.depth + 1, ways: node.ways });
    }
  }
  // A limit may interrupt a BFS layer: do not claim a shortest solution/count.
  if (limited) return { status: 'limit', solvable: null, minimumMoves: null, actions: null, path: null,
    interactions: null, exploredStates: head, discoveredStates: nodes.length, maxStates };
  const actions = [], path = [], interactions = [];
  if (best !== -1) {
    let index = best;
    while (index !== -1) {
      const node = nodes[index];
      path.push(coordinate(maze, node.pos));
      if (node.parent !== -1) {
        actions.push(node.direction);
        if (node.interaction) interactions.push({ type: node.interaction, at: coordinate(maze, node.target), input: node.depth });
      }
      index = node.parent;
    }
    actions.reverse(); path.reverse(); interactions.reverse();
  }
  return { status: best === -1 ? 'unsolvable' : 'solved', solvable: best !== -1,
    minimumMoves: best === -1 ? null : actions.length,
    movementSteps: best === -1 ? null : actions.length - interactions.filter(x => x.type === 'extinguish').length,
    actions, path, interactions, shortestSolutions, shortestSolutionsCapped: countCapped,
    exploredStates: head, discoveredStates: nodes.length,
    unreachableItems: maze.items.filter(pos => !reachedItems.has(pos)).map(pos => coordinate(maze, pos)),
  };
}
