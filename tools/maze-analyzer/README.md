# Offline maze analyzer

Node.js 24; no dependency installation, database, environment secrets, network, or running API required. Run commands from the server repository root:

```sh
npm run test:analyzer
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

Search exhausts the reachable state graph, treating goals as terminal, so it also determines which pickups cannot be reached before completion. BFS predecessors retain one path per state, not a path per queue entry. Counts of shortest action sequences include equal-cost routes merging into the same state and across terminal states. Counts saturate at 1 billion; `shortestSolutionsCapped` conservatively indicates any internal count saturation. The graph has a worst-case exponential size in item/fire count. `--max-states` defaults to 100,000 (maximum 1,000,000); on exhaustion of this budget, `solvable: null` and `status: limit` deliberately make **no shortest-path or unsolvability claim**, even if a partial solution was encountered. Each seed runs sequentially; no graphs or solutions accumulate across the batch. Generation has finite grid/placement/endpoint bounds and dimensions up to 101×101. The former VM two-second timer has been removed with the VM; there is no wall-clock timeout on synchronous generation.

## Generation discrepancies and reproducibility

The production generator's `seed` argument remains only a label: its randomness is **not seeded**. The analyzer now imports `lib/maze/candidate-v1.js` with a SHA-256-derived Mulberry32 stream. This extracted algorithm retains historical analyzer behavior as `legacy-analyzer-v1`, including rejection seeds. It never imports or evaluates the seeder, dotenv, database writes or date loop. There is no VM, source slicing, or global RNG patching. Fixed pre-extraction grid hashes and the existing 1,000/10,000-seed reports verify parity. Actual stored grids can be analyzed through `--grid`; seed labels cannot reconstruct historical daily grids.

Every report records the extracted candidate + RNG source SHA-256 (`generatorHash`), the unchanged seeder's historical SHA-256 (`legacySourceHash`), algorithm/RNG/rule versions, dimensions, minimum generator distance and search budget. Existing sample outcomes remain unchanged; provenance explicitly identifies the extraction. Batch seed `i` is exactly `${prefix}-${i}` for `start <= i < start + count`. Each invocation gets a fresh RNG independent of batch order. The analyzer retains one invocation per record, with 10 endpoint attempts and five fire attempts; it does not hide failures with outer retries. Rejection is a generator error, not proof of an unsolvable valid grid.

The new daily contract uses the same candidate module with endpoint protection, versioned date/config identity, bounded retries and solver acceptance. Use [the daily engine documentation](../../docs/deterministic-daily-maze.md) and `tools/daily-maze/cli.js` for that contract. The legacy analyzer CLI deliberately keeps old behavior for evidence comparison. Both share the pure solver/analyzer in `lib/maze`; existing tool import paths re-export those functions.

Observed legacy generator issues, preserved by the legacy analyzer without changing production behavior:

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

Sprint 1.7A extracts the pure algorithm, solver and analyzer from baseline main `8e3eac84f7081f3b1a51df317b35f782d64561db`. Routes, models, runtime and the production seeder remain unchanged. Future algorithm changes must retain historical versions and review source hashes/fixtures; client inventory or fire-rule changes require solver/fixture review. See the daily engine documentation for generation identity and the separately gated publisher proposal.

`npm run test:analyzer` runs the offline analyzer suite without dependency installation or MongoDB. `npm test` runs the complete combined server suite, including analyzer/report tests and completion integration tests; the full suite requires `npm ci` and a local `mongod` binary selected with `MONGOD_BINARY`. This repository has no production compilation/build script; the production server is interpreted JavaScript. Validate syntax with `node --check` for all production and tool JavaScript. Do not start the API or run the destructive maze/reward seeders for this sprint. No deployment is part of this tool.

## GitHub Actions CI

`.nvmrc` declares Node 24 for development and CI. Server CI runs on pull requests to main and pushes to main, with read-only repository permissions and no production secrets/environments. It uses `npm ci`, installs the checksum-verified MongoDB 8.0.16 test binary, and runs **`npm test` with automatic discovery**. This includes analyzer/CLI smoke tests, report validation, and the completion integration tests; those tests spawn their own loopback MongoDB with temporary synthetic data. No shared database service, production server, Railway command, or seeder is started. Automatic discovery also includes the offline daily-engine regression suite.

CI also runs a successful single-seed CLI smoke check, regenerates the 1,000-seed sample and 10,000-seed benchmark, and validates every flagged seed plus deterministic counts/options/provenance against the committed reports. Timing, RSS and final heap usage vary by runner and are checked for valid positive measurements rather than equal to one host. Reproduce validation locally:

```sh
node tools/maze-analyzer/cli.js --batch 1000 --prefix sprint4 > /tmp/maze-sample.json
node --max-old-space-size=64 tools/maze-analyzer/benchmark.js 10000 > /tmp/maze-benchmark.json
node tools/maze-analyzer/validate-reports.js /tmp/maze-sample.json /tmp/maze-benchmark.json
```
