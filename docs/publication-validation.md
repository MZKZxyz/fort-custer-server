# Sprint 1.7C validation and QA handoff

Required and actual starting main: `6ff49d10d7fa6679b9f3e1f88ba032df0b0c45c4`.
The initial checkout was the reviewed generator head; main was fetched and a new
branch created at the required squash-merge SHA before edits. No base drift.
Issue #17, parent #6, PR #16 including independent QA, and the accepted archive
contract/review in client #50 were read before implementation.

Environment: Node v24.19.0, Linux x64, Mongoose 8.14.1, MongoDB driver 6.16.0,
MongoDB 8.0.16. All MongoDB writes and fault injection were against disposable
synthetic loopback fixtures. No live URI, player data, legacy seeder, production
publish/deploy, migration, scheduler, merge, or v2 activation was used.

## Commands and outcomes

Commands run from the repository root. `MONGOD_BINARY` was set by the invocation
environment to the provisioned local binary; its machine-specific location is
intentionally omitted. All four external database selectors were unset, not
assigned empty strings.

```sh
env -u MONGO_URI -u MONGODB_URI -u MONGO_URL -u DATABASE_URL npm test
env -u MONGO_URI -u MONGODB_URI -u MONGO_URL -u DATABASE_URL npm run test:publication
env -u MONGO_URI -u MONGODB_URI -u MONGO_URL -u DATABASE_URL npm run test:daily-maze
env -u MONGO_URI -u MONGODB_URI -u MONGO_URL -u DATABASE_URL npm run test:analyzer
node tools/maze-analyzer/cli.js --batch 1000 --prefix sprint4 > sample.json
node --max-old-space-size=64 tools/maze-analyzer/benchmark.js 10000 > benchmark.json
node tools/maze-analyzer/validate-reports.js sample.json benchmark.json
node tools/maze-publisher/cli.js --date 2028-02-29 --at 2028-03-01T00:00:00Z > preview.json
node tools/integration/freeze-contract.mjs --check
git ls-files -z '*.js' '*.mjs' | xargs -0 -n1 node --check
git diff --check
```

| Check | Result |
| --- | --- |
| Full automatic discovery | **493 passed; zero failed/cancelled/skipped/todo** |
| Publication/API suites | **20 passed**, including actual MongoDB connection faults |
| Existing daily generator suite | **12 passed** |
| Existing analyzer suite | **14 passed**, including 5,000-seed/64 MiB subprocess |
| Frozen session contract | FROZEN_CONTRACT_MATCH; only two source hashes changed |
| Legacy sample/benchmark validator | Exit 0, all deterministic fields unchanged |
| Constrained operator preview | Exit 0; proposed document only; no DB import/connect |
| Syntax/whitespace/scope checks | Exit 0 |

The 1,000-seed legacy report remains 572 solved / 428 errors; the 10,000-seed
benchmark remains 5,706 solved / 4,294 errors with maximum 281 discovered states.
The unchanged daily suite replays all 366 dates in 2028 through canonical client
movement and pins aggregate hash
`691e6bf5bf7b21be93c9d6b8feaab2f4c42976f4060c0f230a3e1685f3be376b`.
Guarded preview document/provenance matches the approved pure engine's grid hash.
Elapsed time/RSS in preview and benchmark are measurements, not deterministic bytes.

Intermediate validation was retained rather than counted as a final pass: the
first input-only run passed 5/6 and exposed the Linux zombie RSS-monitor edge;
the first combined run passed 16/18 (one test expected a forbidden model save to
succeed, another fixture used unsupported reward enums). The watchdog race and
fixtures/assertions were corrected. The next combined run passed 18/18; the final
two independent regressions expanded this to 20/20. Initial compatibility-only
tests passed 96/96, and the first full run passed 491/491 before adding the last
two regressions. All final tests are present and pass; none was skipped or removed.

## New behavioral evidence

- Strict config ingress rejects QA's Date/custom-prototype/symbol/non-enumerable
  cases, accessors without evaluating them, unknown keys and bad scalar bounds.
  Trusted library instants reject strings; CLI civil parsing rejects exotic
  offsets and supports explicit DST and date-domain endpoints.
- Actual strict Mongoose persistence retains all provenance fields and the unique
  date/compound archive indexes. Incorrect hashes and unknown manifest fields
  fail. Save/query/bulk mutation attempts cannot rewrite content. Markerless
  rows remain unchanged and loadable without mandatory new fields.
- Archive tests use sparse/holey months, all 31 January dates, leap day,
  years 0001/9999, old approved fixture dates, unknown legacy rows, future
  publishedAt values, future-stored dates and corrupt manifests. Reads leave
  stored documents byte-equivalent and never append attempts.
- Owned progress is projected as at most 32 month/today completion booleans in
  MongoDB. Sibling-profile differences are preserved; foreign and missing
  profiles have identical 404 responses. No private fields appear in metadata.
- Duplicate/bracketed/unknown query parameters and invalid real dates/months
  reject stably. Empty/future months remain successful empty pages; database or
  integrity-budget failures are private 503 responses, not fabricated emptiness.
- Public TTL is bounded to 60 seconds and UTC rollover; partial final seconds,
  profile projections, Authorization-bearing metadata and all errors are private
  no-store. Vary includes Authorization. Late publication appears on revalidation.
- Start/daily admission agree on published status; direct future/draft/unknown
  requests return MAZE_NOT_PUBLISHED before any attempt write. Daily no-score
  publications return []; old start/result payload keys and legacy score shape
  remain compatible. Weekly/alltime and saved completion logic remain unchanged.
- Every availability request samples one trusted clock across positive offsets,
  both DST transitions, year rollover and midnight. Saved attempts survive
  midnight/catalog loss/profile switches and replay exact receipts without a
  second award.
- Two separate writer processes deliberately wait at a pre-insert barrier, then
  race different identities against a real unique date index. Exactly one insert
  wins; the duplicate loser returns the exact stored winner and mismatch code.
  Unknown-version/hash conflicts on existing rows are retained unchanged.
- Exhaustion creates no partial record. Actual insert connections are closed by
  a disposable failpoint on both the original command and driver retry; no row
  remains, and the same identity later succeeds. A separate lost-ACK simulation
  persists first, returns uncertainty, then recovers the exact committed winner.
- CLI tests poison all four Mongo selectors, refuse --apply, and verify empty
  stdout for failures. Worker timeout/RSS/busy/exhaustion cases free the execution
  slot; a subsequent successful 101×101 run proves cleanup.

## Reproduced worker resource probes

[The committed probe report](publication-resource-probe.json) records every grid
hash and measurement for forty 101×101 seeds, plus adverse budget probes:

| Probe | Observed result |
| --- | --- |
| independent-large-0 through -39, default config except 101×101 | 40 accepted, maximum 197.717082 ms, peak 54,763,520 bytes RSS, maximum accepted attempt 5 |
| 101×101, minDistance 10201, endpoint/fire/outer attempts 32 | GENERATOR_TIMEOUT, 1503.716864 ms including termination, peak 60,342,272 bytes |
| Same adverse input, tightened 48 MiB RSS budget | GENERATOR_MEMORY_LIMIT, 136.586056 ms, sampled peak 50,868,224 bytes |
| Same input, 1 ms startup deadline | GENERATOR_TIMEOUT, 2.060573 ms; no RSS sample before termination |

The memory refusal demonstrates sampling overshoot: an RSS watchdog is not an OS
hard allocation cap. A zero sampled peak means the process ended before a sample,
not that it used zero memory. No refused result can reach the insert path.
Reproduce the workload with this script (measurements vary):

```js
import { generateInWorker } from './services/publication/executor.js';
const now = new Date('2028-01-01T00:00:00Z');
for (let i = 0; i < 40; i++) {
  const r = await generateInWorker({ date: '2028-01-01',
    seed: `independent-large-${i}`, config: { width: 101, height: 101 } }, now);
  console.log(r.result.gridHash, r.metrics);
}
const worst = { date: '2028-01-01', config: { width: 101, height: 101,
  minDistance: 10201, endpointAttempts: 32, fireAttempts: 32,
  maxAttempts: 32, maxStates: 100000 } };
for (const limits of [{}, { rssBytes: 48 * 1024 * 1024 }, { timeoutMs: 1 }]) {
  try { await generateInWorker(worst, now, limits); }
  catch (e) { console.log(e.code, e.metrics); }
}
```

## Scope and release decisions

The baseline diff confirms no changes to the approved `lib/maze` engine, its
tools/reports, canonical movement fixture, index.js, legacy scripts, dependency
lockfile, CI/deployment configuration or playable v2 service. The frozen contract
was refreshed using `freeze-contract.mjs --write` solely for the v1 router/bundle
source hashes; endpoint examples and response fixtures are unchanged. Existing
test harness edits inject explicit synthetic legacy approvals rather than
weakening runtime publication checks.

The [engineering/runbook document](published-maze-archive.md) records release
gates: positive legacy date/hash evidence, schema/index/deployment review,
separately approved live adapter and insert authorization, deployment-wide worker
ownership/memory containment, monitoring/backfill policy and client 1.7D integration.
No production inventory or release schedule is claimed. An empty legacy policy
intentionally denies markerless rows. Private raw DB edits can corrupt/forge
metadata and remain outside the application writer's authority.

Internal archive reads fetch bounded grids to verify hashes, a deliberate
tradeoff against the proposal's metadata-only database projection. Query results
are bounded, but MongoDB server index work and transport still depend on workload
and the existing deployment's driver configuration. No production load benchmark
was performed. RSS/concurrency enforcement is per supervisor on Linux, not a
deployment-wide hard cgroup guarantee. Human difficulty calibration is unchanged.

Independent QA must pin the final PR head before owner merge/rollout decisions.
No GitHub CI status was waited for or polled in this handoff.
