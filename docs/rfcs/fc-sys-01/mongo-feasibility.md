# Sprint 1.3F — corrected isolated MongoDB transaction feasibility

Design baseline: `904bc79d81fa8b67a7973ff18ef1f1bb70908835`.
Scope: [issue #5 handoff 6416631314](https://github.com/MZKZxyz/fort-custer-server/issues/5#issuecomment-6416631314),
[implementation-plan.md T1–T4](implementation-plan.md#minimum-isolated-mongodb-feasibility-matrix-before-runtime-promotionrollout).
This is executable storage evidence, not a production v2 implementation or rollout approval.

Correction baseline: `c0ffad6a4adebc6c0c453eb299e1008105e05b83`, on the same
`feasibility/fc-sys-01-mongo-t1-t4` branch. This focused correction addresses
[independent QA 6417630513](https://github.com/MZKZxyz/fort-custer-server/issues/5#issuecomment-6417630513)
and [consolidated handoff 6418441510](https://github.com/MZKZxyz/fort-custer-server/issues/5#issuecomment-6418441510).
The former 61/220 green runs did **not** close T1–T4: QA reproduced missing
anomaly holds, stale expired replay and a reporter path leak. Claims below are
limited to the corrected schedules; targeted independent revalidation is still required.

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
node --test test/evidence-reporter.test.js

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
[full regression results](mongo-regression-results.json) record stable test
identifiers and outcomes. Reporter schema **2** treats even test names as untrusted:
ordinary titles become a fixed T1–T8/test category plus the first 20 hexadecimal
digits of their SHA-256 digest (`safeName(title)`); file-level failure names become
the fixed label `file-level failure`. No free-form title, exception, diagnostic,
file/host/process/account field, stdout or stderr is emitted. This sacrifices
file-level identity to avoid publishing paths. Identifiers can be matched to source
titles using the exported `safeName` helper without publishing those titles.
Regression coverage includes POSIX, Windows, UNC, relative and file-URL failure
names, arbitrary private strings, and a real child Node import-time exception
with private stderr. Fixtures contain synthetic identities.
The final runs supplied an intentionally unusable loopback `MONGO_URI` to confirm
that the suites continue to own their database connections.

| Check | Outcome |
| --- | --- |
| Dedicated MongoDB feasibility | 82 passed, 0 failed/skipped/todo |
| Full `npm test`, automatic discovery | 243 passed, 0 failed/skipped/todo |
| Existing tests plus reporter regressions within that full run | 159 unchanged tests (including 124 offline RFC fixtures), plus 2 reporter tests, passed |
| All tracked and new JS/MJS syntax | Passed |
| RFC replay reproduction | Byte-identical to pinned replay output |
| Existing CI CLI smoke and deterministic report checks | Passed in Sprint 1.3D; analyzer code/reports unchanged; not rerun for this correction |
| Whitespace and unchanged application/manifests | Passed |

Production application code, pre-feasibility regression test files, manifests
and lockfile are byte-unchanged from the design baseline. The synthetic feasibility
tests were extended and the reporter regression file was added. No CI run was
polled. No PR, merge or deployment was made. The correction commit is local;
publication requires explicit owner authorization.

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

### Corrected clock ordering and failure policy

Before sampling a local clock, each finalizer commits an **unresolved check token**
on the intent and advances both session revision and expected intent revision in
one majority/journaled transaction. No clock is sampled if this admission is
failed or commit-unknown. A matching durable result is checked first and returned
without a new token or clock observation.

The next transaction reads that admission and the shared fences. A backward sample
commits the token's reversed state, exact sample, and both revision updates
together; it returns `CLOCK_UNAVAILABLE` only **after** that evidence transaction
commits, with no final receipt effects. Matched updates are checked. Transaction
retries retain local reversal samples so a later healthy sample cannot erase them.
A non-unknown evidence-write failure returns `CLOCK_EVIDENCE_UNAVAILABLE`; an
unknown evidence commit returns `COMMIT_UNKNOWN`. In either case the pre-admitted
token remains unresolved or reversed. A later finalizer cannot remove another
worker's token: the immutable receipt is `review-required` whenever any admitted
check is unresolved/reversed, even if its own sample is healthy.

Local detection and durable evidence are distinct. A process may die before its
numeric sample is persisted; the guarantee is **a durable timing hold**. Recovery
of the numeric sample requires a successful evidence write. A crash after admission can conservatively hold
timing even if no reversal actually occurred. This extra admission transaction
and possible false-positive hold are deliberate costs, not production policy or
performance certification. The synthetic check map has no production growth cap
or authorized hold-release/repair worker; those remain implementation work.

If another finalizer wins during an evidence-write delay, its receipt already
contains the admitted unresolved check and stays timing-held. The delayed worker
retries under the same fences, records the exact late reversal on the completed
intent and private observation, and returns that unchanged winner. It never
rewrites its timestamps/disposition or emits another receipt event. If the late
evidence write fails, a majority lookup returns the durable winner with its
unresolved hold intact; the numeric sample is not claimed as persisted. A failed
winner lookup returns COMMIT_UNKNOWN, not abort proof. This extra failed-write
schedule is tested through restart. If a resolver
instead proves abort first, the old worker is fenced; the old generation retains
its check and only a new generation with a later receipt can proceed. Expiry or
an empty lookup alone cannot clear it. Unknown admission/evidence commits and both
write-boundary crash cases are exercised, not just sequential success.

The original final-write crash tests now capture their comparison snapshot
**after durable clock admission**: all final effects roll back, while the earlier
unresolved timing check intentionally survives. Recovery of that original receipt
therefore stays review-required. Separate crash tests show admission's two writes
are themselves atomic and cannot admit a clock sample before durable completion.

### Corrected effective replay

After ownership and payload/key checks, exact create/ready replay evaluates the
stored session's current prepare/play deadline. With no pending intent, equality
or later atomically changes the session to EXPIRED and releases only that attempt's
slot; the reply preserves attempt ID, trusted start and original deadline. Exact
replay tests cover deadline −1/0/+1 and actual DB restart. Create replay after
ready uses the play deadline, not the old preparation boundary. Replay after
expiry cannot restart time or delete a replacement slot.

A pending generation takes precedence: replay reports stored STARTED plus
`saveStatus: resolving` and retains the slot even after the deadline. A competing
intake/resolver/cleanup uses the same session fence. Tests pause expired replays
on old snapshots, then commit intake or cleanup/successor allocation; retries
observe the pending generation or terminal winner instead of deleting its slot.

| Matrix row | Real database schedules and assertions |
| --- | --- |
| T1 | Two independent processes pause on snapshots before competing writes. Same-profile creates serialize; same account/create or complete key across subprofiles conflicts. Another account has its own namespace. Ready/abandon reuse keys across attempts, reject changed nonce/grid/rules/reason within an attempt, enforce ownership before replay, and race at one fixed revision in both orders. Alternate completion keys retain one body/generation/time; changed transcript hashes and foreign ownership fail. SIGKILL before intake writes and after every intake/create/ready/abandon statement leaves no partial effects after DB restart. Lost create/ready/intake ACKs retain original IDs/start/receipt. |
| T2 | Guard at receipt −1/0/+1ms; prepare, intake and final guard at deadline −1/0/+1ms. QA's exact failed-update error-2 schedule retains an unresolved hold; its exact 1500ms delayed-update vs competing-finalizer schedule returns one timing-held immutable winner and retains late evidence. Admission/evidence SIGKILL and unknown commits preserve holds; resolver-first fences the old generation; an already durable winner is never re-sampled. Negative elapsed is irreparable. Guard before deadline allows a later commit/ACK; retry at the deadline fails. Post-commit diagnostic failures cannot discard a saved winner. |
| T3 | Both completion/resolver snapshot orderings, two competing resolvers, stale completion fencing, new later receipt only after durable abort proof, and atomic resolver crash recovery. Real `failCommand` write conflicts retry the body and recheck the guard; injected unknown commit errors retry commit without replacing the receipt. Closed commit connections produce an unknown/no-winner recovery schedule. Post-execution write-concern errors produce an unknown/durable-winner schedule after majority visibility is established. Actual single-member forced primary stepdown invalidates the old transaction; worker restart recovers intent or winner. |
| T4 | SIGKILL before first final write and after **each** result/intent/session/slot/key/outbox statement, followed by actual MongoDB SIGKILL/restart, compares the complete pre/post collection snapshots. Recovery completes exactly once. SIGKILL after acknowledged majority commit preserves exact structured receipt/digest/elapsed and one event. Concurrent finalizers return the same winner. A stale cleanup snapshot cannot delete a successor slot. |

Every final invariant check reads the aggregate in a snapshot transaction, verifies
body references, terminal session, intent, key mappings, exact receipt, slot and
one outbox event, and asserts **zero ledger/inventory writes**. Full collection
snapshots include the untouched ledger/inventory during crash rollback checks.
No date eligibility or inventory grant is implemented in this receipt experiment.

## Findings and limits

The corrected shared-fence schedules pass on the tested topology; these author
passes are not independent QA sign-off. In particular, original green counts did
not establish the three guarantees corrected here. Snapshot
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
  ordering and conservative admitted-check holds are demonstrated; actual time
  quality, bounded check retention, authorized hold release and liveness during
  indefinite storage failure are not. Numeric process-local samples cannot be
  recovered after death without a successful evidence commit; the prior hold survives.
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

Keep issue #5 OPEN/in design-review. Obtain targeted independent QA revalidation
of the pinned correction SHA for the two P2 findings and reporter P3; do not treat
these author passes as closing that gate. Resolve D2's disclosed no-pause/server-receipt
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
