import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Maze from '../models/Maze.js';

dotenv.config();

const START_DATE = new Date('2025-05-26');
const END_DATE = new Date('2025-09-01');

const formatDate = (date) =>
  date.toISOString().split('T')[0];

const placeFireAndExtinguisher = (grid, path, walkable, isInBounds) => {
  const height = grid.length;
  const width = grid[0].length;

  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };

  // 60% chance to branch from path, 40% random off-path
  let firePlaced = false;
  let firePos = null;

  const tryPlaceFire = () => {
    if (Math.random() < 0.6) {
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
      // Try to find an off-path wall neighbor
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
  while (!firePlaced && attempts < 5) {
    tryPlaceFire();
    attempts++;
  }

  if (!firePlaced) throw new Error('Unable to place fire');

  // Place extinguisher far from fire
  const fireKey = `${firePos[0]}-${firePos[1]}`;
  const candidates = walkable.filter(([r, c]) => `${r}-${c}` !== fireKey);
  if (!candidates.length) throw new Error('No extinguisher locations');

  const [xr, xc] = candidates[Math.floor(Math.random() * candidates.length)];
  grid[xr][xc] = 'X';

  const start = find('S');
  const ext = [xr, xc];
  const end = find('E');

  if (!canReach(start, ext) || !canReach(start, end, true)) {
    throw new Error('Maze invalid: extinguisher or exit unreachable');
  }
};


const generateDummyMaze = (seed, width = 13, height = 17, minDistance = 25) => {
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
      const j = Math.floor(Math.random() * (i + 1));
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
  for (let attempt = 0; attempt < 10; attempt++) {
    const shuffled = shuffle([...walkable]);
    const start = shuffled[0];
    const end = shuffled[1];

    const path = getPath(start, end);
    if (path.length < minDistance) continue;

    const [sr, sc] = start;
    const [er, ec] = end;
    grid[sr][sc] = 'S';
    grid[er][ec] = 'E';

    placeFireAndExtinguisher(grid, path, walkable, isInBounds);
    
    return {
      seed,
      grid,
      width,
      height,
    };
  }

  throw new Error('Maze generation failed: no valid path found');
};


const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to DB');

  let date = new Date(START_DATE);

  const MAX_ATTEMPTS = 10;

  while (date <= END_DATE) {
    const formatted = formatDate(date);
    const seed = `fortcuster-${formatted}`;
  
    let success = false;
  
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const maze = generateDummyMaze(seed);
        await Maze.findOneAndUpdate(
          { date: formatted },
          { $set: { ...maze, seed, date: formatted } },
          { upsert: true }
        );
        console.log(`✅ Saved maze for ${formatted} (attempt ${attempt})`);
        success = true;
        break;
      } catch (err) {
        console.warn(`⚠️  Attempt ${attempt} failed for ${formatted}: ${err.message}`);
      }
    }
  
    if (!success) {
      console.error(`❌ Failed to generate valid maze for ${formatted} after ${MAX_ATTEMPTS} attempts`);
    }
  
    date.setDate(date.getDate() + 1);
  }

  await mongoose.disconnect();
  console.log('Done!');
};


run().catch((err) => {
  console.error('Maze generation failed:', err);
  process.exit(1);
});
