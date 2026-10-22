const DELTAS = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };

// Pure transition shared by every input method. Never mutate the loaded maze.
export function move(state, direction) {
  const delta = DELTAS[direction];
  if (!delta || state.completed) return { state };
  const [r, c] = state.position.map((value, index) => value + delta[index]);
  const tile = state.grid[r]?.[c];
  if (tile === undefined || tile === '#') return { state };
  if (tile === 'F' && !state.inventory.includes('extinguisher')) {
    return { state, blockedByFire: true };
  }
  let { grid, inventory } = state;
  if (tile === 'X' || tile === 'F') {
    grid = grid.map(row => [...row]);
    grid[r][c] = ' ';
    inventory = tile === 'X'
      ? [...new Set([...inventory, 'extinguisher'])]
      : inventory.filter(item => item !== 'extinguisher');
  }
  return { state: {
    grid, inventory,
    position: tile === 'F' ? state.position : [r, c],
    completed: tile === 'E',
  } };
}

export function findStart(grid) {
  for (let r = 0; r < grid.length; r++) {
    const c = grid[r].indexOf('S');
    if (c !== -1) return [r, c];
  }
  return [0, 0];
}

export function formatElapsed(elapsed) {
  const ms = Math.max(0, Math.floor(elapsed));
  return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
