# FC-SYS-01 v0.2 — phased implementation prerequisites

This is a plan, not execution authorization. Scope now ends with offline design artifacts, local fixtures, a design-branch commit and issue #5 summary. No application changes, live database access, migration, deployment, implementation PR or CI polling. [SYS-03 #7](https://github.com/MZKZxyz/fort-custer-server/issues/7) owns reward/catalog work; client release UX #45 remains separate.

## Phase 0 — design delta and owner choices

Deliver this RFC/model revision from `effc3f47584ff6d315302a9c05569cbd31c4a0f4`; acceptance checklist is issue #5 comment 6414142018. Ask for focused delta review, not another full theoretical audit. Integrator records the decision matrix outcomes and pins target server/client SHAs, responsible reviewers and release rollback artifacts before any implementation PR. Author tests and previous conditional reviews do not close gates. Integrity, TTL, clock threshold, privacy and successful-date interpretation remain owner decisions.

## Phase 1 — separately authorized storage and transaction feasibility

Use an **isolated synthetic replica set**, never live player data. Establish supported MongoDB/driver versions, replica-set/sharded topology as applicable, transaction limits, primary read preference, snapshot read concern, majority journaled write concern, retry budgets and unknown-commit handling. Do not assume a current deployment is a replica set, supports these concerns, or has the required indexes/capacity.

Inventory all write paths from source first, including v1 UUID and ID-less completion, v2, admin/maintenance, profile saves and future SYS-03 workers. Inventory all maze publication/grid/cache delivery paths. Under separate DB-read approval, inspect versions/legacy provenance/duplicates/index suitability and backups; source audit establishes no live contents.

Unique constraints: account/create key, account/operation/completion key, profile active slot, result/attempt, profile/date entitlement, grant ID, event ID and result/adjudication revision. Validate index build cost, duplicate handling and namespace limits in staging. Use explicit session/date/inventory/source-epoch fence writes for invariants; snapshot isolation does not serialize all predicates. Avoid unbounded embedded growth; preserve invalid/missing User `__v` fail-closed behavior and existing read-only replay.

Transaction boundaries:

| Transaction | Atomic writes / fence | Unknown-outcome resolution |
| --- | --- | --- |
| Create | Account/key hash + new session + profile slot; unique conflicts recover original or return explicit conflict | Same create key and hash; never allocate successor on uncertain commit |
| Ready | Session revision/state/start/deadline/clock/ready hash | Owned session + exact hash, effective state; no new start |
| Receipt | Guarded session terminal state + unique immutable result + slot release + key mapping + receipt outbox | Stable attempt/result ID; retain request receipt through internal retries; commit retries resolve original transaction before new transaction/HTTP receipt |
| Adjudicate | Expected result revision + append audit + current decision + date claim/fallback + source epoch + decision/entitlement outbox | Stable adjudication operation ID and expected revision; no duplicate acceptance sequence |
| Grant (SYS-03) | Date claim/revision + current accepted decision + profile inventory/version + immutable grant snapshot + terminal consumed/exhausted + outbox ACK | Stable grant ID; repeat returns same grant/null snapshot, never rerolls |
| Project | Current consistent eligibility snapshot + source epoch fence + best fallback/delete + board revision + dedup marker | Recompute current state if source epoch changed; never publish old snapshot with merely newer projection revision |

Production adjudication commands need their own operation-key/audit envelope; this is deliberately not a player route. Clock repair must verify independent monitor evidence with authorization and audit, not accept arbitrary player/reviewer JSON assertions.

Failpoints must pause/crash before and after **each** logical write in each boundary, then verify no partial cross-collection effects. Test write conflicts, duplicate-key errors, primary stepdown, restart, transaction retry and unknown commit. A valid clock receipt held through retry does not reserve a terminal win; guard must still precede deadline and cleanup must not already have committed.

## Phase 2 — compatibility cutover (SYS-03 dependency)

Select one explicit path from D7. Both exclude simultaneous unchanged per-attempt reward writers once the date-unique guarantee starts.

**A. Compatible all-writer ledger upgrade (recommended for old-client continuity).** Preserve v1 request/response shapes and every saved UUID snapshot. Newly completed v1 attempts participate in the same date-ledger/inventory transaction; new reward semantics deliberately change from per-attempt to date-unique. Old clients keep legacy timing/boards and receive the correct new reward/null response snapshot on first commit. A successful valid v1 completion enters the shared ledger under a versioned legacy validator, never falsely labeled v2 traversal-verified. Preserve legacy three-second behavior only within its legacy scoring policy; do not import that floor into v2.

Deploy the upgraded v1 capability with v2 admission OFF. Use an upstream write gate covering every affected writer, drain in-flight mutations, stop all unchanged workers/replicas and verify no reachable old deployment/background worker. Rolling health alone does not prove this. Protect profile writes that could discard new fields or bypass OCC. Establish legacy date statuses under separately authorized evidence/reconciliation policy; do not guess. Reopen only compatible writers, verify staging contracts, then permit v2 admission after all gates.

**B. Gated/drained transition.** Disable new legacy starts first, retain a safe resolver for completed snapshots, and announce supported negotiation/upgrade/recovery. Drain unfinished legacy attempts through the old handler **before** new-ledger admission. Legacy attempts without deadlines require an explicit approved bounded drain/upgrade or abandonment policy; do not invent expiry. Gate all writes, wait for in-flight request resolution, stop and verify all unsafe workers, reconcile authorized historical statuses and start v2/compatible services. Reopen new starts only after the old mutation path is unreachable. ID-less compatibility after cutover requires a compatible adapter or an explicit upgrade-required response, never v2-to-latest fallback.

Cutover tests for both paths: old completion immediately before gate; after gate but already in flight; lost ACK after old commit; new v1/v2 request on same date; different dates contending inventory; queued old worker surviving restart; invalid-version profile; unknown history; replay after catalog rename/delete; catalog exhaustion/expansion. Fail the cutover if any writer can award outside the ledger. “v1 wire compatible” does not mean unchanged reward behavior. This plan does not claim a mixed-writer fixture has run.

## Phase 3 — API/client contracts and adversarial concurrency

Implement only after separate code-phase authorization. Use two or more workers, deterministic barriers and isolated replica-set failpoints. Require actual HTTP status/envelope/hash/auth tests in addition to the serial oracle:

* Account-level create-key collision across two subprofiles, key/body canonicalization, active-slot uniqueness, bound grants, supported manifests, unknown fields, missing/stale If-Match and non-enumerating ownership on every replay.
* Lost create/ready ACK; prepare/play expiry at deadline−1/0/+1; fixed-revision ready/abandon in both orders; delayed old ACK after status/expiry; replacement slot protected against stale cleanup.
* Receipt at deadline−1 with guard before or at deadline and commit after deadline; cleanup/abandon committing first and last; write conflict forcing re-guard after deadline; no result when cleanup wins; saved result always recoverable.
* Duplicate/alternative completion keys, same account/key on other UUID, internal retry with same receipt, fresh HTTP retry after proven no-commit, unknown commit after receipt/slot/key/outbox writes; exactly one immutable winner.
* Positive unhealthy start/receipt, negative duration, missing evidence, epoch change, uncertainty boundary, unauthorized repair, stale adjudication revision, corroborated repair preserving original receipt/tier. Multi-node drift/monitor outage/restarts need real clock-service tests.
* First rejected/pending/quarantined receipt then accepted replay; both concurrent acceptance orders; rejection before grant with fallback; stale grant event; late older acceptance; rejection after grant; duplicate delivery; worker crash after grant before ACK; profile inventory contention across dates; exhausted/changed catalog; unknown historical attribution.
* Winner invalidation and fallback/empty deletion, duplicate/reversed events, simultaneous improvements, equal duration/receipt/ID ties, reversed adjudication. Pause worker A after old eligibility snapshot; worker B invalidates and repairs; A reads newer projection revision then tries publishing: source fence must reject it. Verify public read suppression and cursor restart when revision changes.

Client fixtures must cover actual fully-ready/fallback boundary, one scheduler/terminal latch, status ownership, local key persistence, lost local state vs connectivity, explicit abandon/new ranked replay from S, no pause/refund, slow initialization, assistive controls, deadline warnings, tab throttling and recovery after expiry. Geometry/semantic tests must use logical cells under projection and resizing/zoom/orientation, not CSS area. Full-map semantic announcements or alternate-renderer map peeks fail EG-09 consistency. Server manifest checks do not prove hostile client rendering.

## Phase 4 — legacy preservation, staging migration and shadow boards

Separate authorization required for data inspection/migration. Prepare reviewed backup/restore and non-destructive additive scripts; no seeder. Synthetic fixtures: known awarded/exhausted/unknown dates, completed attempts without snapshots, invalid/missing versions, quantities >1, retired IDs, seconds strings vs milliseconds, missing history, duplicate index keys, immutable grid references, archive publication and UTC midnight. Legacy provenance remains sidecar; no invented historical minimum/start/class or guessed attribution. Missing history is held unless authorized evidence establishes clear status.

Preserve legacy endpoint snapshots, latest-progress seasonal/totals behavior and current inventory. Validate byte-stable saved UUID responses. Build current competition/scoring/class bests in shadow collections from immutable eligible results; compare rebuilds, reverse events and invalidation repairs. Rehearse index rollout, source-epoch fencing, backup recovery and feature rollback with synthetic accounts. Production player data is never a fixture. Pin exact migration/compatibility/recovery artifacts and reviewers before release approval.

## Phase 5 — separately approved activation and rollback

Activate only after owner choices, independent Gameplay/Security/QA delta and implementation signoffs, measured clock bounds, replica-set failure proof, accessible client/EG-09 geometry validation, all-writer compatibility, privacy/retention rules, load/capacity and operator rollback rehearsal. No gate is closed by this document. Flags should separately control new admission, public visibility and projection version while retaining recovery.

Rollback sequence: disable new v2 creation and new board visibility; preserve owned status, ready recovery, in-flight complete, saved result replay, adjudication/ledger and outbox/grant recovery until explicit drain/expiry. No v2 UUID ever routes into v1 latest selection. Gate affected writes, drain and stop unsafe workers before any server downgrade. Revert only to a **ledger/idempotency/OCC-compatible** artifact; if unavailable, keep unsafe writes closed and forward-fix. Never reactivate unchanged v1 per-attempt rewards.

Keep additive collections/indexes, key tombstones, receipts, adjudications, inventory and entitlement/grant records. No reward reversal, historical overwrite, version reset or blanket database restore to undo application code. A restore would lose later legitimate activity; any restoration requires separate reconciliation approval. A projection rollback swaps/rebuilds a shadow version while current-decision read filtering still suppresses invalidated entries. Catalog/rarity changes and collection removal are independent reviewed operations.
