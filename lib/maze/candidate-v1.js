// Extracted from the baseline seeder; all randomness is supplied by the caller.
// preserveEndpoints=false retains the historical analyzer stream and rejection evidence.
const placeFireAndExtinguisher = (grid, path, walkable, isInBounds, random, rules) => {
  const height = grid.length;
  const width = grid[0].length;

  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };

  // 60%: search near the path midpoint; 40%: search shuffled walkable neighbors.
  let firePlaced = false;
  let firePos = null;

  const tryPlaceFire = () => {
    if (random() < 0.6) {
      // Try branch from mid path
      const fireIndex = Math.floor(path.length / 2);
      const [baseR, baseC] = path[fireIndex];
      const offsets = shuffle([[0,1],[1,0],[0,-1],[-1,0]]);
      for (const [dr, dc] of offsets) {
        const fr = baseR + dr;
        const fc = baseC + dc;
        if (isInBounds(fr, fc) && grid[fr][fc] === ' ') {
          grid[fr][fc] = 'F';
          firePos = [fr, fc];
          firePlaced = true;
          break;
        }
      }
    } else {
      // Search blank neighbors (not necessarily off the solution path).
      const shuffled = shuffle(walkable);
      for (const [r, c] of shuffled) {
        const offsets = shuffle([[0,1],[1,0],[0,-1],[-1,0]]);
        for (const [dr, dc] of offsets) {
          const fr = r + dr;
          const fc = c + dc;
          if (isInBounds(fr, fc) && grid[fr][fc] === ' ') {
            grid[fr][fc] = 'F';
            firePos = [fr, fc];
            firePlaced = true;
            break;
          }
        }
        if (firePlaced) break;
      }
    }
  };

  const find = (target) => {
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        if (grid[r][c] === target) return [r, c];
      }
    }
    return null;
  };

  const canReach = (start, goal, allowFire = false) => {
    const queue = [start];
    const visited = new Set([`${start[0]}-${start[1]}`]);

    while (queue.length) {
      const [r, c] = queue.shift();
      if (r === goal[0] && c === goal[1]) return true;

      for (const [dr, dc] of [[0,1],[1,0],[0,-1],[-1,0]]) {
        const nr = r + dr;
        const nc = c + dc;
        const key = `${nr}-${nc}`;
        if (!isInBounds(nr, nc) || visited.has(key)) continue;

        const tile = grid[nr][nc];
        if (tile === '#' || tile === 'F') {
          if (tile === 'F' && allowFire) {
            // passable with extinguisher
          } else {
            continue;
          }
        }

        visited.add(key);
        queue.push([nr, nc]);
      }
    }

    return false;
  };

  let attempts = 0;
  while (!firePlaced && attempts < rules.fireAttempts) {
    tryPlaceFire();
    attempts++;
  }

  if (!firePlaced) throw new Error('Unable to place fire');

  // Choose a non-fire tile; daily rules also protect the endpoint markers.
  const fireKey = `${firePos[0]}-${firePos[1]}`;
  const candidates = walkable.filter(([r, c]) => `${r}-${c}` !== fireKey &&
    (!rules.preserveEndpoints || grid[r][c] === ' '));
  if (!candidates.length) throw new Error('No extinguisher locations');

  const [xr, xc] = candidates[Math.floor(random() * candidates.length)];
  grid[xr][xc] = 'X';

  const start = find('S');
  const ext = [xr, xc];
  const end = find('E');

  if (!canReach(start, ext) || !canReach(start, end, true)) {
    throw new Error('Maze invalid: extinguisher or exit unreachable');
  }
};


export const carveCandidate = (seed, { width, height, minDistance,
  endpointAttempts = 10, fireAttempts = 5, preserveEndpoints = false }, random) => {
  const grid = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => '#')
  );

  const directions = [
    [0, 2], [0, -2],
    [2, 0], [-2, 0]
  ];

  const isInBounds = (r, c) =>
    r >= 0 && c >= 0 && r < height && c < width;

  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };

  const carve = (r, c) => {
    grid[r][c] = ' ';
    for (const [dy, dx] of shuffle(directions)) {
      const nr = r + dy;
      const nc = c + dx;
      const midR = r + dy / 2;
      const midC = c + dx / 2;

      if (isInBounds(nr, nc) && grid[nr][nc] === '#') {
        grid[midR][midC] = ' ';
        carve(nr, nc);
      }
    }
  };

  carve(1, 1);

  // Collect walkable cells
  const walkable = [];
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (grid[r][c] === ' ') walkable.push([r, c]);
    }
  }

  const getPath = (start, end) => {
    const queue = [[...start, []]];
    const visited = new Set([`${start[0]}-${start[1]}`]);

    while (queue.length) {
      const [r, c, path] = queue.shift();
      if (r === end[0] && c === end[1]) return [...path, [r, c]];

      for (const [dr, dc] of [[0,1],[1,0],[0,-1],[-1,0]]) {
        const nr = r + dr, nc = c + dc, key = `${nr}-${nc}`;
        if (isInBounds(nr, nc) && grid[nr][nc] === ' ' && !visited.has(key)) {
          visited.add(key);
          queue.push([nr, nc, [...path, [r, c]]]);
        }
      }
    }
    return [];
  };

  // Try finding a good S/E pair
  for (let attempt = 0; attempt < endpointAttempts; attempt++) {
    const shuffled = shuffle([...walkable]);
    const start = shuffled[0];
    const end = shuffled[1];

    const path = getPath(start, end);
    if (path.length < minDistance) continue;

    const [sr, sc] = start;
    const [er, ec] = end;
    grid[sr][sc] = 'S';
    grid[er][ec] = 'E';

    placeFireAndExtinguisher(grid, path, walkable, isInBounds, random, { fireAttempts, preserveEndpoints });

    return {
      seed,
      grid,
      width,
      height,
    };
  }

  throw new Error('Maze generation failed: no valid path found');
};
