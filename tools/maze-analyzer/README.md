# Offline maze analyzer

Node.js 24; no dependency installation, database, environment secrets, network, or running API required. Run commands from the server repository root:

```sh
npm test
npm run analyze -- --seed sprint4-0
npm run analyze -- --seed sprint4-42 # reproduces a generator rejection
npm run analyze -- --batch 10000 --prefix sprint4 --format jsonl > batch.jsonl
npm run analyze -- --batch 1000 --format csv > batch.csv
node tools/maze-analyzer/cli.js --batch 1000 > batch.json
node --max-old-space-size=64 tools/maze-analyzer/benchmark.js 10000
```

Use direct `node` invocations when redirecting machine-readable output: npm prints a script banner unless run with `--silent`. `--help` lists all flags. `--grid file.json` accepts an array of strings or character arrays, or an object with `grid`. Example: `["#####","#SXE#","#####"]`. This also analyzes handcrafted multi-item/multi-fire fixtures. Grids must be rectangular, at most 101×101, contain only `#`, space, `S`, `E`, `X`, `F`, and have exactly one start and goal. Invalid input fails explicitly instead of following the client's unsafe missing-start fallback. Single-seed generation rejections exit 1 with the original message; batch reports retain every rejected seed and continue. Reports distinguish `solved`, `unsolvable`, and `limit`; completion of a batch exits 0 even if records report failures.

## Rules and shortest solutions

The reference is `MZKZxyz/fort-custer-client/src/game/movement.js`, Git blob `382a5c5abb4a70cb3c12b76bc06b4d264adf2344` on main when inspected. An unmodified copy is pinned in `test/fixtures/client-movement.js`; tests compare every outgoing transition of reachable fixture states and replay generated solutions against it. A client change requires reviewing this contract and updating that fixture deliberately. No client checkout is needed to run tests.

Movement is orthogonal. Walls/bounds block inputs. Inventory starts empty and holds at most one extinguisher. Entering `X` removes that tile and leaves inventory full, including when already full: no stacking or second pickup on revisiting. Input toward uncleared `F` requires and consumes inventory, permanently clears the fire, and **does not move the player**. A subsequent input enters the cleared tile. Entering `E` completes immediately; movement after completion is disabled. Start is the unique `S`. Fog hides visuals with radius 1 but does not restrict movement; this is a full-map oracle solver, not a human fog exploration agent.

BFS gives a shortest sequence of accepted directional inputs because every input has cost 1. A state is `(position, hasExtinguisher, changedTileBitset)`, using arbitrary-width BigInt bits for each pickup/fire. This preserves both consumed pickups and permanently cleared fires; position-only or inventory-only visited keys are incorrect. No global RNG or client code is patched. Direction tie order is up, down, left, right. The solver returns directional actions, coordinates including the initial position and stationary extinguishing steps, and item interactions with 1-based input indices. `minimumMoves` counts inputs; `movementSteps` excludes extinguishing inputs. Interaction counts describe the chosen shortest solution, not a claim about every valid solution.

Search exhausts the reachable state graph, treating goals as terminal, so it also determines which pickups cannot be reached before completion. BFS predecessors retain one path per state, not a path per queue entry. Counts of shortest action sequences include equal-cost routes merging into the same state and across terminal states. Counts saturate at 1 billion; `shortestSolutionsCapped` conservatively indicates any internal count saturation. The graph has a worst-case exponential size in item/fire count. `--max-states` defaults to 100,000 (maximum 1,000,000); on exhaustion of this budget, `solvable: null` and `status: limit` deliberately make **no shortest-path or unsolvability claim**, even if a partial solution was encountered. Each seed runs sequentially; no graphs or solutions accumulate across the batch. Generation is separately limited to 2 seconds per seed and dimensions up to 101×101.

## Generation discrepancies and reproducibility

The production generator's `seed` argument is only a label: its randomness is **not seeded**. This tool loads only the existing pure generator declarations from `scripts/generateMazes.js` into an isolated VM, injecting a SHA-256-derived 32-bit Mulberry32 random stream. It never imports/evaluates the seeding script's imports, dotenv setup, `run()`, database writes, or date loop. Tests compare output with the unchanged generator supplied the identical random stream. One VM realm is reused to avoid accumulating per-context V8 overhead. This is deterministic synthetic simulation of current logic, **not reconstruction of historical daily mazes from their stored seed labels**. Actual grids can be analyzed through `--grid`.

Every report records the entire generator source SHA-256, RNG version, rule version, dimensions, minimum generator distance and search budget. Batch seed `i` is exactly `${prefix}-${i}` for `start <= i < start + count`. Each seed receives a fresh RNG; its result is independent of batch size/order and earlier failures. There is exactly one generator invocation per record, including its existing internal 10 attempts to select endpoints. It does not apply the production seeder's outer retry loop: hiding failures would obscure bad outcomes. A rejected invocation is a generator error, **not evidence of an unsolvable valid grid**.

Observed generator issues, preserved without changing production behavior:

- `walkable` candidates are collected before `S`/`E` placement. Extinguisher placement can overwrite either marker, causing validation failure or a null dereference in the generator's reachability check.
- Fire placement can sever the only path to the extinguisher. The generator rejects many such invocations.
- The generator's `canReach(..., allowFire=true)` treats every fire as passable without tracking inventory. This is not a general proof of stateful solvability. Fixtures cover insufficient inventory even when geometry connects the goal.
- A pickup may be reachable only by crossing the exit. The generator's connectivity check allows that, but the client completes on the exit and cannot continue. Such items are reported as inaccessible before completion; that does not imply the item is required to win.
- `minDistance=25` tests path **cells including endpoints**, so an accepted fire-free solution may take only 24 movement inputs.

Malformed generated grids are rejected rather than silently normalizing them. Production generation, movement, APIs, persistence, rewards and dates are untouched.

## Metrics and experimental scores

`exact` contains dimensions, non-wall cells (includes fire), initially traversable cells (excludes fire), degree-1 dead ends, degree≥3 branch cells/frequency, geometric component count and cycle rank `edges - vertices + components` treating fire as passable. Geometry does not establish playable connectivity. Exact shortest inputs, chosen-path fire/pickup interactions and explored/discovered state counts come from stateful search. `solution.shortestSolutions` counts **shortest action sequences**, not all simple routes.

`heuristics` is explicitly experimental v1:

- `score = round(100 * (shortestInputs + 3*branchCells + 5*fireInteractions + deadEnds) / max(25, nonWallCells))`.
- Difficulty: easy below 75, medium below 125, otherwise hard. Unsolved/limited results have no score.
- Exploration proxy: `deadEnds + 3*branchCells`; no fog exploration was simulated.
- Alternative-route proxy: geometric cycle rank, not an exact count of playable routes.
- Flags: short solution below 25 inputs; long above twice non-wall cells; difficulty outlier score below 25 or above 175. These are fixed experimental thresholds, **not population quantiles**. Missing/inaccessible pickups are diagnostic flags, not proof that an item is necessary.

JSON batch output streams metadata, compact records (without paths/actions) and a constant-space summary. JSONL streams a metadata line followed by one record per seed. CSV streams compact rows, quoting all fields; pair it with the JSON report to retain provenance/options. Reproduce flagged seeds individually for full paths, or use the JSONL `seed` and `error` fields for rejections.

## Sample and performance

`reports/sample-difficulty.json` records a reproducible 1,000-seed sample (`sprint4-0` through `sprint4-999`), aggregates, and **every** flagged seed. The larger raw report can be regenerated with the batch command above. `reports/performance.json` records a measured 10,000-seed run with Node version, elapsed time, OS peak RSS (KiB), heap usage and maximum discovered states. Time/RSS vary by host and workload; the 64 MiB V8 limit is not a total-process RSS limit. The automated 5,000-seed subprocess test enforces that heap budget and a 55-second timeout. This bounds the sample workload, not arbitrary exponential state spaces.

## Integration and validation

This branch starts at server main `e5b69742c7849eb58fb58755fa909a44c8d87dc7`. It adds tools/tests/reports and npm scripts. It has no dependency on Sprint 3 completion API work and touches no routes, models or production generator. Sprint 3 may also add a root `test` script: both use `node --test`; preserve its API tests when combining branches. Any future generator refactor must update/review the VM declaration boundary and report hash; a client inventory/fire-rule change requires solver/fixture review.

`npm test` runs all server tests available on this main plus the analyzer suite. This repository has no production compilation/build script; the production server is interpreted JavaScript. Validate syntax with `node --check` for all production and tool JavaScript. Do not start the API or run the destructive maze/reward seeders for this sprint. No deployment is part of this tool.
