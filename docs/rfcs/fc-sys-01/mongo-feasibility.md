# Sprint 1.3D — isolated MongoDB transaction feasibility

Design baseline: `904bc79d81fa8b67a7973ff18ef1f1bb70908835`.
Scope: [issue #5 handoff 6416631314](https://github.com/MZKZxyz/fort-custer-server/issues/5#issuecomment-6416631314),
[implementation-plan.md T1–T4](implementation-plan.md#minimum-isolated-mongodb-feasibility-matrix-before-runtime-promotionrollout).
This is executable storage evidence, not a production v2 implementation or rollout approval.

## Reproduce

Use Node 24, the repository's locked dependencies, and MongoDB **8.0.16**.
The existing CI configuration pins the same MongoDB version. Supply an executable
binary; this harness never downloads MongoDB, launches the application entrypoint,
reads `.env`, seeds data, or uses `MONGO_URI`.

```sh
npm ci
export MONGOD_BINARY=/path/to/mongod

# Dedicated experiment, with ordinary failure diagnostics.
node --test test/mongo-feasibility.test.js

# Full automatic discovery, including all existing tests and offline RFC models.
npm test

# Regenerate the shareable, deliberately restricted evidence.
node --test \
  --test-reporter=./tools/transaction-feasibility/evidence-reporter.mjs \
  --test-reporter-destination=docs/rfcs/fc-sys-01/mongo-feasibility-results.json \
  test/mongo-feasibility.test.js
npm test -- \
  --test-reporter=./tools/transaction-feasibility/evidence-reporter.mjs \
  --test-reporter-destination=docs/rfcs/fc-sys-01/mongo-regression-results.json

git ls-files -z '*.js' '*.mjs' | xargs -0 -n1 node --check
git diff --check
node docs/rfcs/fc-sys-01/replay.mjs > /tmp/fc-replay.json
cmp /tmp/fc-replay.json docs/rfcs/fc-sys-01/replay-output.json
```

Loopback listeners and child processes must be allowed by the execution sandbox.
Missing binaries, failed setup, failpoint rejection or test failures **fail** the
suite; none are silently skipped. There are no new dependencies, package scripts,
manifest changes, CI changes, production route imports or application changes.

Each suite creates its own `mkdtemp` directory and OS-assigned loopback port,
then spawns one `mongod --replSet fcSynthetic --setParameter enableTestCommands=1`.
The `fc_synthetic` database exists only in that directory. The replica set's URI
is constructed internally; worker IPC rejects other URI shapes. No existing
MongoDB service, database, configuration or data directory is consumed or modified.
Teardown kills only owned child processes and removes the owned temporary directory.
DB restarts deliberately retain that directory within a test, kill the owned
mongod with SIGKILL, then start a new process on the same isolated data.

## Execution evidence

Validated with Node **24.19.0**, Mongoose **8.14.1**, its existing MongoDB driver
**6.16.0**, MongoDB **8.0.16**, WiredTiger, one voting/data-bearing member with
journaling. No new package installation was needed for execution.

The committed [dedicated results](mongo-feasibility-results.json) and
[full regression results](mongo-regression-results.json) record each test name and
outcome. The reporter only emits an allowlist of names, outcomes and counts; it
omits stack traces, filesystem paths, hosts, ports, process IDs, account IDs,
environment values and raw database logs. Fixtures contain synthetic identities.
The final runs supplied an intentionally unusable loopback `MONGO_URI` to confirm
that the suites continue to own their database connections.

| Check | Outcome |
| --- | --- |
| Dedicated MongoDB feasibility | 61 passed, 0 failed/skipped/todo |
| Full `npm test`, automatic discovery | 220 passed, 0 failed/skipped/todo |
| Existing tests within that full run | 159 passed, including 124 offline RFC fixtures |
| All tracked and new JS/MJS syntax | Passed |
| RFC replay reproduction | Byte-identical to pinned replay output |
| Existing CI CLI smoke and deterministic report checks | Seed, 1,000-seed batch, 10,000-seed benchmark and report validator passed locally |
| Whitespace and unchanged application/manifests | Passed |

The application, existing test files, manifests and lockfile are byte-unchanged
from the design baseline. No CI run was polled. No PR, merge or deployment was made.

## What the experiment exercises

`tools/transaction-feasibility/store.mjs` is a small synthetic storage candidate;
it is intentionally outside production services. Transactions use **primary**
reads, **snapshot** read concern and **majority, journaled** writes with a 5-second
write-concern timeout / maximum commit time. The experiment bounds transaction-body
attempts at eight and explicit commit attempts at three. The driver may also retry
commit internally. Unknown commit exhaustion returns `COMMIT_UNKNOWN`, never
starts a fresh transaction body as a substitute for recovery. These limits are
test defaults, not measured production retry/latency recommendations.

An account/operation/key unique index uses a nonempty attempt scope only for
ready/abandon. Slots are unique on account/profile; results are unique on attempt;
intents on attempt/generation; receipt events on result/type. Bodies have
content-addressed private IDs. Create writes session/slot/key atomically. Intake
writes body/intent/session fence/key atomically. Matching alternate keys join one
generation and preserve its receipt; keys from a proved-aborted generation can
join the next generation without keeping stale pending mappings.

The final transaction writes result, intent, session, slot release, key mappings
and receipt outbox together. A resolver reads the result first, otherwise writes
the **same session and intent** fences plus key state. Its committed revision
advance proves abort by invalidating an older transaction. A missing result read,
expiration, or clock reversal cannot authorize a new receipt. Expiry and abandon
block on pending intents; cleanup before intake wins through the same session
write conflict. Slot deletion always includes the old attempt selector.

| Matrix row | Real database schedules and assertions |
| --- | --- |
| T1 | Two independent processes pause on snapshots before competing writes. Same-profile creates serialize; same account/create or complete key across subprofiles conflicts. Another account has its own namespace. Ready/abandon reuse keys across attempts, reject changed nonce/grid/rules/reason within an attempt, enforce ownership before replay, and race at one fixed revision in both orders. Alternate completion keys retain one body/generation/time; changed transcript hashes and foreign ownership fail. SIGKILL before intake writes and after every intake/create/ready/abandon statement leaves no partial effects after DB restart. Lost create/ready/intake ACKs retain original IDs/start/receipt. |
| T2 | Guard at receipt −1/0/+1ms; prepare, intake and final guard at deadline −1/0/+1ms. Reversal aborts final effects, persists anomaly evidence, and recovery of that receipt stays review-required. Negative elapsed is retained as irreparable. Guard before deadline allows a later commit/ACK; retry at the deadline fails. Backward post-commit observations and failed diagnostic writes cannot discard a saved winner. Abandon/expiry can beat paused intake; neither can bypass a pending uncertain generation. |
| T3 | Both completion/resolver snapshot orderings, two competing resolvers, stale completion fencing, new later receipt only after durable abort proof, and atomic resolver crash recovery. Real `failCommand` write conflicts retry the body and recheck the guard; injected unknown commit errors retry commit without replacing the receipt. Closed commit connections produce an unknown/no-winner recovery schedule. Post-execution write-concern errors produce an unknown/durable-winner schedule after majority visibility is established. Actual single-member forced primary stepdown invalidates the old transaction; worker restart recovers intent or winner. |
| T4 | SIGKILL before first final write and after **each** result/intent/session/slot/key/outbox statement, followed by actual MongoDB SIGKILL/restart, compares the complete pre/post collection snapshots. Recovery completes exactly once. SIGKILL after acknowledged majority commit preserves exact structured receipt/digest/elapsed and one event. Concurrent finalizers return the same winner. A stale cleanup snapshot cannot delete a successor slot. |

Every final invariant check reads the aggregate in a snapshot transaction, verifies
body references, terminal session, intent, key mappings, exact receipt, slot and
one outbox event, and asserts **zero ledger/inventory writes**. Full collection
snapshots include the untouched ledger/inventory during crash rollback checks.
No date eligibility or inventory grant is implemented in this receipt experiment.

## Findings and limits

The candidate shared-fence design is feasible on the tested topology. Snapshot
reads alone would not prove an absent result was aborted: the resolver's writes
make a stale finalizer conflict/retry and then observe the winning state. Multiple
operation keys cannot open a second pending generation; neither clock catch-up
nor an empty lookup replaces the captured receipt. Durably completed receipts
remain authoritative through retries, post-commit clock failures and restarts.

The expanded experiment caught a **fault-injection evidence error**, corrected in
the final tests: `failCommand.writeConcernError` can bypass the normal durability
wait. A default local read briefly saw a result that an immediate SIGKILL then
rolled back. The durable-winner schedule now waits for an actual **majority**
result read before crashing the database. That evidence barrier is part of the
test setup; it does not turn an arbitrary empty result lookup into abort proof.
The separate acknowledged-majority-commit crash test verifies the ordinary path.

The following remain **UNVERIFIED**, not implicitly covered by these passes:

* Multi-member replication, election onto a different host, partitions, majority
  loss, secondary lag, sharded transactions and cross-host/network behavior. A
  one-member forced stepdown and journal recovery cannot certify those guarantees.
* Physical disk/power failure, filesystem/storage durability and crashes inside
  every MongoDB instruction. The controlled crashes occur at logical statement
  boundaries; failpoints are test-only and were available in this environment.
* Real clock monitors, drift/uncertainty bounds, clock epochs across machines,
  authorized repair/adjudication and service health. All timestamps and health
  disposition inputs here are trusted fixtures. Guard/receipt and expiration
  ordering is demonstrated; actual time quality is not.
* Authentication/HTTP envelopes, authorization against real accounts, canonical
  ingress parsing, quotas, transcript validation/admission/storage limits,
  browser reload/accessibility behavior and exact HTTP-byte serialization.
  Structured stored receipt equality is tested; the body is a bounded synthetic
  fixture, not a production validator. Offline transcript regression passes are
  independent of this storage experiment.
* T5–T8: worker admission/route failures; all-writer v1/v2 date ledger and SYS-03
  grants; projection/public privacy/cursors; compatibility, drain and rollback.
  Ledger and inventory staying untouched does not prove their eventual atomicity.
* Production topology, indexes, duplicates, data provenance, backup/restore,
  capacity, latency/load, document/transaction limits and retention. No deployment
  or persistent development data was inspected. The small test WiredTiger cache
  is not production configuration advice; transaction lifetime uses MongoDB's default.

## Recommended next implementation step

Keep issue #5 in design/review. Resolve D2's disclosed no-pause/server-receipt
metric and D5/D6 timing-only/untimed core-completion credit and legacy reward UX.
Then authorize the planned cohesive, OFF/shadow session/replay/outcome-recovery
package with compatible all-writer date ledger/SYS-03 boundary and necessary
client recording/recovery. Carry these transaction/fence fixtures into that
implementation, add T5–T8 and actual API/browser/privacy/clock tests, and obtain
independent QA plus multi-member staging failure evidence before rollout. This
experiment does not authorize production database inspection or migration.

Source-only inventory for that next step: registration/profile add/edit/delete
in `routes/userRoutes.js`, v1 start in `routes/mazeRoutes.js`, UUID and ID-less
completion/reward selection in `services/completions.js`, and User save/OCC hooks
in `models/User.js` are existing User writers. The legacy progress route is
read-only. `scripts/generateMazes.js` writes Maze; start serves that stored grid.
`scripts/rewardSeeder.js` replaces the reward catalog. No v2/SYS-03 worker exists
yet. All these application paths and scripts were inspected as source only and
were left unchanged; external maintenance writers and deployment/cache paths
still require authorized inventory before cutover.
