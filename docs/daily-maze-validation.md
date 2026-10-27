# Sprint 1.7A local validation

Baseline: `8e3eac84f7081f3b1a51df317b35f782d64561db`. Node v24.19.0,
Linux x64, MongoDB 8.0.16. Commands below run from the repository root. No
production URI, player data, API deployment, seeder, migration or publisher was
used. The full suite starts only disposable synthetic loopback MongoDB instances
and application fixtures. No production server was started.

`MONGOD_BINARY` selects the provisioned local test binary; supply its location in
the invoking environment. All external DB selectors were **unset**, including
empty values. No machine-specific binary location is part of this evidence.

```sh
env -u MONGO_URI -u MONGODB_URI -u MONGO_URL -u DATABASE_URL \
  npm test
env -u MONGO_URI -u MONGODB_URI -u MONGO_URL -u DATABASE_URL \
  npm run test:daily-maze
env -u MONGO_URI -u MONGODB_URI -u MONGO_URL -u DATABASE_URL \
  npm run test:analyzer
```

Final results: full discovery **473 passed, 0 failed, 0 skipped**; daily suite
**12 passed, 0 failed**; analyzer suite **14 passed, 0 failed**. The full run
includes the existing runtime, transcript, integration, completion, collectible,
schema-assessment and transaction/crash-recovery tests. It also includes the
5,000-seed analyzer subprocess with a 64 MiB V8 heap cap. Two intermediate full
runs passed 471 and 472 tests respectively before adding the final regression
cases. Two initial daily-only invocations under restricted executor permissions
returned a file-level exit 1 without individual test results; reruns with the
supported executor permissions passed. No test was removed or skipped to obtain
the passing results.

## Deterministic reports and preview

```sh
node tools/maze-analyzer/cli.js --batch 1000 --prefix sprint4 > sample.json
node --max-old-space-size=64 tools/maze-analyzer/benchmark.js 10000 > benchmark.json
node tools/maze-analyzer/validate-reports.js sample.json benchmark.json
node tools/daily-maze/cli.js --range 2028-01-01:2028-12-31 > preview.json
```

The generated files were temporary local artifacts, not committed raw reports.
The committed compact sample retains the same summary and every flagged seed:
572 solved, 428 generation/validation errors, 33 inaccessible-pickup flags,
13 short solutions, no proved-unsolvable valid grids and no search limits.
The 10,000-seed run retains 5,706 solved, 4,294 errors and maximum 281 discovered
states. `validate-reports.js` exited 0, matching every deterministic field,
rejection message and flagged-seed metric against the compact reports.
Provenance now identifies `legacy-analyzer-v1`, extracted source hash
`2a38fdb1782f47f9ca44ee8185c8f853808b26942266039c4ee926246aca4198`, and the original
seeder source hash `cf0c29029b3ea8c17a6247a7aec46ab589246d48ec5afadbcc2b4646348dafe1`.
The refreshed benchmark measured 1904.048584 ms, peak RSS 55,936 KiB and final
heap 9,836,672 bytes. Timing/memory are measurements, not reproducibility claims.

The year preview exited 0: **366 dates accepted, 262 rejected attempts, zero
exhausted dates**. The in-test full-year generation/replay pins aggregate hash
`691e6bf5bf7b21be93c9d6b8feaab2f4c42976f4060c0f230a3e1685f3be376b` over ordered
`[date, gridHash, attemptTrace]` tuples. The observed largest accepted zero-based
attempt was 6. This is evidence for that year/config, not guaranteed success for
every possible date/seed/config.

Other automated evidence:

- Seven accepted snapshots include historical release-era date labels, leap
  day, both requested dimensions, explicit seed overrides and required fire
  clearing; every one has a grid hash, identity hash and exact retry trace.
- Independent CLI processes in UTC, America/Los_Angeles and Pacific/Kiritimati
  produce byte-identical output for all seven inputs, matching library hashes.
- Seed/config/date changes produce different pinned outputs; unsupported daily
  versions fail closed, and the distinct legacy version remains reproducible.
- Both stored grid fixtures validate against the unchanged Maze model without a
  database connection. Every 2028 solution and all snapshots replay through the
  unchanged canonical client movement fixture; fire clearing consumes inventory
  without movement and completion occurs at E.
- Legacy `sprint4-42` still reproduces the unreachable rejection. With identical
  RNG streams, `sprint4-128`, `sprint4-136` and `sprint4-235` preserve their legacy
  null-marker failure while daily endpoint protection produces valid candidates.
- Exhausted distance, reachability and solver-budget traces are fixed and
  repeatable. Invalid dimensions/dates/ranges/config fail closed. A range whose
  first date succeeds and second exhausts returns exit 2 with empty stdout.
- An import guard refuses mongoose, dotenv, network and child-process imports,
  global fetch and WebSocket. The CLI succeeds under that guard with synthetic
  ambient Mongo selectors; refusal canaries verify the guard is active.
- Calendar tests cover Gregorian century leap rules, UTC midnight ±1 ms,
  explicit positive/negative offsets, DST spring/fall transitions, complete
  common/leap years, old season boundaries and future admission.

## Static checks and scope

```sh
git ls-files -z '*.js' '*.mjs' | xargs -0 -n1 node --check
git diff --check
git diff --exit-code 8e3eac84f7081f3b1a51df317b35f782d64561db -- \
  index.js routes models services scripts .github package-lock.json
```

All checks exited 0. Syntax checking never runs the server or seeders. No
production build command exists for this interpreted JavaScript repository.
The pinned canonical client movement fixture is unchanged. No dependency,
deployment, production write path, route, model, or v2 activation changed.

## Limits and handoff

No live/published maze grid was fetched or reconstructed. Date fixtures use
release-era labels with synthetic generated grids; stored production grids
remain authoritative. Difficulty is the analyzer's experimental full-map metric,
not human/fog calibration. The 32-bit PRNG is noncryptographic and can collide.
The recursive candidate algorithm is structurally bounded but synchronous and
has no wall-clock watchdog. The full supported input space was not benchmarked.
Deterministic exhaustion remains possible; no fallback grid is silently emitted.

The proposed insert-only writer, duplicate-key race handling, provenance schema,
scheduler/backfill monitoring and archive/calendar contract need separate
implementation and approval. This PR contains no executable publisher or DB
immutability/idempotency claim; the document specifies the required later tests.
Independent QA must review the final pinned PR head and owner approval is
required before merge. No GitHub CI wait/poll, live rollout or automatic merge
forms part of this handoff.
