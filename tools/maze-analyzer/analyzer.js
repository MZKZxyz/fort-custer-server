import { compile, solve, directions, coordinate } from './solver.js';

function geometry(maze) {
  const open = maze.cells.map((tile, pos) => tile === '#' ? -1 : pos).filter(pos => pos >= 0);
  const neighbors = pos => {
    const [r, c] = coordinate(maze, pos);
    return Object.values(directions).flatMap(([dr, dc]) => {
      const nr = r + dr, nc = c + dc, target = nr * maze.width + nc;
      return nr >= 0 && nc >= 0 && nr < maze.height && nc < maze.width && maze.cells[target] !== '#' ? [target] : [];
    });
  };
  let deadEnds = 0, branches = 0, edges = 0, components = 0;
  const visited = new Set();
  for (const pos of open) {
    const degree = neighbors(pos).length;
    deadEnds += Number(degree === 1); branches += Number(degree >= 3); edges += degree;
    if (visited.has(pos)) continue;
    components++;
    const queue = [pos]; visited.add(pos);
    for (let i = 0; i < queue.length; i++) {
      for (const next of neighbors(queue[i])) if (!visited.has(next)) { visited.add(next); queue.push(next); }
    }
  }
  return { width: maze.width, height: maze.height, nonWallCells: open.length,
    initiallyTraversableCells: open.length - maze.fires.length,
    deadEnds, branchCells: branches, branchingFrequency: branches / open.length,
    geometricComponents: components, geometricCycleRank: edges / 2 - open.length + components,
    fireTiles: maze.fires.length, extinguisherTiles: maze.items.length };
}

export function analyze(grid, options = {}) {
  const maze = compile(grid), exact = geometry(maze), solution = solve(maze, options);
  const fireInteractions = solution.interactions?.filter(x => x.type === 'extinguish').length ?? null;
  const pickupInteractions = solution.interactions?.filter(x => x.type === 'pickup').length ?? null;
  Object.assign(exact, { shortestSolutionLength: solution.minimumMoves, fireInteractions, pickupInteractions });
  // Full-map oracle difficulty, not a fog-aware human exploration simulation.
  const score = solution.solvable === true ? Math.round((solution.minimumMoves + 3 * exact.branchCells +
    5 * fireInteractions + exact.deadEnds) / Math.max(25, exact.nonWallCells) * 100) : null;
  const issues = [];
  if (solution.status === 'unsolvable') issues.push('unsolvable');
  if (solution.status === 'limit') issues.push('search-limit');
  if (!maze.items.length && maze.fires.length) issues.push('missing-extinguisher');
  if (solution.unreachableItems?.length) issues.push('inaccessible-extinguisher');
  if (solution.solvable && solution.minimumMoves < 25) issues.push('short-solution');
  if (solution.solvable && solution.minimumMoves > 2 * exact.nonWallCells) issues.push('long-solution');
  if (score !== null && (score < 25 || score > 175)) issues.push('difficulty-outlier');
  return { exact, solution, heuristics: { version: 'v1', score,
    estimatedDifficulty: score === null ? null : score < 75 ? 'easy' : score < 125 ? 'medium' : 'hard',
    explorationComplexity: exact.deadEnds + 3 * exact.branchCells,
    // Cycle rank is exact geometry; it is NOT a count of playable alternative routes.
    geometricAlternativeRouteProxy: exact.geometricCycleRank }, issues };
}
