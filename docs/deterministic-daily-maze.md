# Deterministic daily mazes: Sprint 1.7A

Issue #15 implements the offline engine for parent #6 (OD-06, OD-07, OD-08),
including the analyzer rejection evidence from #3. This work starts exactly at
main `8e3eac84f7081f3b1a51df317b35f782d64561db`. The initial workspace checkout
was `983f1b20f0dd20d9435c9faae7cf4524c71c6e6f`; main was fetched and the feature
branch created at the required SHA before any edits. No baseline drift remains.

## Audit and boundaries

- `scripts/generateMazes.js` labels seeds but uses `Math.random()`, loops only
  from 2025-05-26 through 2025-09-01, advances dates with local `setDate`, and
  performs overwrite-style `findOneAndUpdate({date}, {$set: ...}, {upsert:true})`.
  Its stale walkable list permits `X` to overwrite `S`/`E`. Its connectivity
  check does not model inventory consumption or immediate completion at `E`.
  **Do not execute this script as a publisher.** It is unchanged in this PR.
- The old analyzer sliced declarations out of that script and executed them in
  a shared VM with patched `Math.random`. It was deterministic synthetic testing,
  never a reconstruction of stored production grids. Source slicing and VM
  patching have been removed; historical single-invocation behavior remains
  available as `legacy-analyzer-v1`.
- The Maze model has unique `date`, required `seed/grid/width/height`, optional
  `collectibles`, and timestamps. It does not persist generator provenance and
  does not deeply validate tile topology. New results include a model-compatible
  `maze` object; tests validate it locally without connecting to MongoDB.
- The legacy route loads an exact published date using `Maze.findOne`. Stored
  grids remain authoritative. No route, model, server entry point, database
  writer, runtime flag, deployment configuration, or seeder is changed here.

## Modules and versions

`lib/maze/candidate-v1.js` extracts the existing DFS carving, endpoint selection,
and fire/pickup placement algorithm with caller-supplied randomness. The daily
caller protects endpoint markers. The legacy analyzer deliberately retains its
old candidate selection and errors. Both use `random-v1.js`. `solver.js` and
`analyzer.js` now live in the pure library; old tool paths re-export their APIs.
The daily engine has no dependency on filesystem, process, clock, network,
dotenv, mongoose, server initialization, or test fixtures.

The supported daily algorithm is `daily-dfs-v1`; configuration schema is
`daily-config-v1`; movement rules are `client-single-slot-fire-input-v1`.
Unknown algorithm versions, config fields or tile rules fail closed. The legacy analyzer
is a separately named retained version, not an option for daily publication.
There is deliberately no fabricated daily v2. Adding another daily algorithm
requires an explicit dispatch entry while retaining v1 and its fixtures; never
repurpose a version name or regenerate historical records.

| Canonical config key | Default | Accepted values |
| --- | ---: | --- |
| width, height | 13, 17 | Odd integers 5–101 |
| minDistance | 25 | Integer 1–10201; endpoint path **cells**, including S/E |
| endpointAttempts | 10 | Integer 1–32 per candidate |
| fireAttempts | 5 | Integer 1–32 per candidate |
| maxAttempts | 10 | Integer 1–32 candidates per date |
| maxStates | 100000 | Integer 1–100000 solver states per candidate |
| tileRules | client-single-slot-fire-input-v1 | Exact supported string |

Canonical keys appear in the table's order, with width preceding height.
Defaults are materialized; unknown keys, undefined overrides, arrays, noninteger
or out-of-bounds values are refused. The returned configuration is frozen.
Daily minimum dimensions ensure space for four distinct special tiles; the
legacy adapter retains its historical 3–101 validation.

## Exact identity, bytes and PRNG

All hashes below are lowercase SHA-256 of UTF-8 `JSON.stringify(value)`, without
whitespace or a trailing newline. Arrays preserve order; config has the fixed
key order above. Grid bytes are character arrays, not joined row strings.

```text
seed = supplied nonempty string of at most 256 UTF-16 code units,
       otherwise "fortcuster-" + date
configHash = hash(["daily-config-v1", canonicalConfig])
identityHash = hash(["fort-custer/daily", date, algorithmVersion, configHash, seed])
attemptSeed(k) = hash(["fort-custer/attempt", identityHash, k])   # zero-based k
gridHash = hash(grid)
```

Each attempt initializes a fresh `sha256-mulberry32-v1` stream: SHA-256 the
attemptSeed string, read its first four bytes as unsigned little-endian state,
then use Mulberry32 with increment `0x6D2B79F5`, unsigned 32-bit arithmetic and
`Math.imul`; divide each unsigned result by 2^32. See `random-v1.js` for the
exact shifts/multiplications. This is a noncryptographic 32-bit stream: different
identities are not a mathematical guarantee of different grids or RNG streams.
No global RNG is read or patched. Date, seed, config and algorithm version are
all part of identity; invocation order, timezone and earlier failures are not.
Changing a retry/search budget changes identity too, so operators must not
silently raise a budget for an already agreed identity.

## Acceptance and deterministic failure

One candidate retains the old DFS direction shuffle and path selection order.
Odd dimensions keep an outer wall border. One `S`, `E`, `X`, and `F` must exist;
`X` can only replace a blank cell. The engine retains the old connectivity
prefilter, then independently checks shape, border, tile counts, connected
geometry, complete solver success and pickup reachability **before** terminal
exit. A search limit is an inconclusive rejection, never a solvability claim.

The BFS state tracks position, a single inventory slot and consumed/cleared
tile bits. Picking up X removes it even with full inventory. Input toward F
consumes the extinguisher, clears F, and leaves the player stationary; another
input enters that cell. Entering E ends play. The pinned canonical movement
fixture is unchanged; generated solution actions are replayed against it,
including a fixture that requires extinguishing. Fire/pickup participation in
the shortest route is optional; this version does not force every maze to use F.

Attempts are independent, indexed 0 through maxAttempts-1; every rejection has
a stable reason code. A successful result contains the entire trace including
`ACCEPTED`. Exhaustion throws `GenerationError` with `GENERATION_EXHAUSTED`,
identity and trace, and **no partial grid**. Unexpected programming errors escape
immediately rather than being hidden as rejected candidates.

| Diagnostic code | Meaning |
| --- | --- |
| ENDPOINT_DISTANCE_REJECTED | Endpoint selection budget exhausted |
| FIRE_PLACEMENT_FAILED | Fire placement budget exhausted |
| EXTINGUISHER_PLACEMENT_FAILED | No eligible pickup tile |
| LEGACY_REACHABILITY_REJECTED | Existing candidate prefilter refused connectivity |
| GRID_SHAPE_REJECTED / TILE_COUNTS_REJECTED / BORDER_REJECTED | Invalid candidate structure |
| SOLVER_LIMIT / UNSOLVABLE | Inconclusive search / proved no winning state |
| EXTINGUISHER_UNREACHABLE_BEFORE_EXIT | No playable pickup before terminal E |
| DISCONNECTED_GEOMETRY | Non-wall cells have multiple components |

All loops have finite grid/attempt/search bounds. Removing the VM also removes
its old two-second execution timer; structural bounds now govern execution.
This is synchronous offline work, not a request-handler latency guarantee.
The recursive legacy DFS and path-copying BFS remain; an eventual publisher
should isolate generation in a bounded worker and assess worst-case latency.

`test/fixtures/daily-maze-v1.json` pins both 13×17 and 21×21 grids, grid/identity
hashes, retry traces, historical season boundary dates, a leap day, seeded daily
input `sprint4-42`, and deterministic exhausted runs. Legacy `sprint4-42` still
rejects with its original unreachable message: a valid daily retry policy does
not erase that evidence or resolve all analyzer backlog in #3.

## UTC and offline preview

`dates.js` accepts actual four-digit Gregorian dates from 0001 through 9999,
rejecting normalization such as February 30 and unsupported year 0000.
`utcDate(instant)` requires an explicit Date, integer epoch milliseconds, or
ISO timestamp with Z/numeric offset, seconds, and optional 1–3 millisecond
digits. Local/unzoned timestamp strings, leap seconds and 24:00 are refused.
The UTC day is computed after applying the offset. Date inputs never consult
the runtime timezone or current clock. DST ambiguity is resolved by the supplied
offset; callers must provide a trusted instant.

`inclusiveDates(start,end)` adds exactly 86400000 milliseconds, includes both
endpoints, and caps one invocation at 366 days. Entire common/leap years and
older release-era dates are supported without a season cutoff. Reversed,
invalid or overlong ranges fail before generation. `isDateAdmitted(date,instant)`
is a pure proposed publisher boundary: today/earlier admitted, future refused.
At 00:00:00.000Z the UTC date becomes eligible. This helper does not establish
that a maze exists, expose an API, or change existing route behavior.

```sh
npm run maze:preview -- --date 2026-01-01
node tools/daily-maze/cli.js --date 2026-01-01 --width 21 --height 21
node tools/daily-maze/cli.js --range 2028-01-01:2028-12-31 > preview.json
```

Direct Node invocation produces machine-readable JSON without npm banners.
The CLI permits future previews, never publishes, and never reads DB variables.
It reports identity, grids, difficulty heuristics, solver summary and retry
reasons. A range buffers at most 366 compact records and emits stdout only if
every date succeeds. Exit 0 means success, 1 invalid input, 2 exhaustion with
JSON diagnostics on stderr and empty stdout. A test import hook denies network,
child-process, dotenv and mongoose imports, plus global fetch/WebSocket; the
preview succeeds with fake ambient Mongo selectors under that guard.

## Later publisher and permanent archive proposal — not implemented

The current Maze schema lacks provenance fields. Before any publisher approval,
review additive storage for algorithmVersion, configVersion, canonical config,
configHash, identityHash, RNG version, gridHash, accepted attempt and diagnostic
trace. Do not attach extra properties to the existing model and assume Mongoose
will save them: strict schema behavior can discard them. Choose embedded
provenance versus a separate immutable generation manifest in that later PR.

A later independently approved writer should:

1. Use the trusted UTC boundary, read an existing exact date first, and return
   that stored document unchanged. Never regenerate a stored date to repair it.
2. For an absent eligible date, generate one agreed version/config identity,
   then perform **insert-only** creation under the existing unique date index.
   Never use `$set` or overwrite-style upsert. Persist provenance atomically with
   the maze, after schema/index review; no migration of historical grids.
3. On duplicate-key error, fetch the winning date and return it unchanged. The
   stored winner is authoritative even if a competing candidate differs; record
   an identity mismatch for operator review, never overwrite or auto-repair.
4. Treat bounded generation failure as a missing release; retain diagnostics,
   alert, and retry the same identity deterministically. Budget/version changes
   need explicit review. Backfill only absent, admitted dates.
5. Test concurrent insert races, different-version winners, exact duplicate
   idempotency, outage/restart/backfill and historical document immutability
   against disposable MongoDB before enabling any schedule.

Archive listing must enumerate actual published dates, exclude unpublished future
dates, preserve catch-up indefinitely and handle missing releases distinctly.
No reconstruction from historical seed labels, expiration, reseed, or deletion
is appropriate. The archive API/client calendar contract remains separate work.

Open architecture decisions: provenance storage/schema and index rollout; next
algorithm dispatch/retention policy; pinned publisher config and worker timeout;
leader election/concurrency, outage monitoring/backfill ownership; publication
status API/calendar cache semantics; and human difficulty acceptance thresholds.
Independent QA and explicit owner approval are required before merge; publisher,
scheduler, archive integration and v2 activation require separate authorization.

Rollback: production paths are unchanged. Reverting this PR removes the offline
library/tooling only; no stored record or deployed runtime requires rollback.
See [local validation evidence](daily-maze-validation.md) for exact commands and
results. GitHub CI is not polled as part of this handoff.
