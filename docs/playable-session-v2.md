# Sprint 1.4A: OFF-by-default playable-session runtime

Owner authorization/policies: issue #5 comment 6426752068. Freshly fetched main
baseline: `d82c272b47486161bf9f37508b69fe3240678655`. Technical reference:
independently accepted feasibility `fd797b607a833bc6bc1029e4c159d1474ef9ec31`,
incorporated on this implementation branch without changing its fixtures.
SYS-03 responsibility is recorded on issue #7, comment 6426758639.

## Activation is blocked

The production entrypoint calls `installPlayableRuntime` **before connecting to
MongoDB**. With absent/false `FC_SESSION_V2_ENABLED`, it mounts nothing and performs
no v2 reads, provisioning or writes. No v1 route, request, saved snapshot, inventory,
reward algorithm, progress representation or leaderboard changes. Setting the flag
to literal `true` deliberately fails startup with `PLAYABLE_V2_ACTIVATION_BLOCKED`.
This is a code-level safety interlock. There is **no environment-only path to live
v2 success** while unchanged v1 reward writers exist.

`createPlayableRouter` and the real services can be assembled explicitly for
isolated integration tests/staging review; its router defaults OFF, and the service
defaults new admission OFF. This is not a production enablement recipe. A future
reviewed change must integrate the shared writers/grant worker and release gates
before the installer can mount anything. Provisioning is an explicit repository
method, not an automatic startup migration. No deployment configuration changed.

## Runtime structure

| Module | Responsibility |
| --- | --- |
| `routes/playableRoutes.js` | JWT authentication, protocol negotiation, strict envelopes/IDs/dates/If-Match, bounded ingress, no-store owned serialization, safe errors |
| `services/playable/service.js` | Owned create/ready/status/abandon/complete/result/recover, immutable manifest, expiration, completion and clock fences |
| `repository.js` | Actual MongoDB collections/indexes, snapshot/primary transactions, majority journaled writes, bounded body/commit retries, User ownership/version fence |
| `transcript.js`, `validator.js`, `validation-worker.js` | Independent runtime port of cardinal/fire replay; bounded worker threads with admission and wall timeout |
| `date-ledger.js` | Versioned accepted-date/progression and once-per-date opportunity interface for v2/future compatible v1 callers |
| `policy.js` | Server clock adapter, timing disposition and bounded engineering defaults |
| `runtime.js` | Startup-default OFF and code-level release interlock |

Production modules import neither design oracles nor synthetic Store/helpers.
Tests reuse only the disposable replica-set infrastructure and pinned pure movement
fixtures. The existing dependencies suffice; manifests and lockfile are unchanged.

## Private authenticated contract

Mount point for isolated assembly: `/api/v2`. All routes require the existing
HS256 JWT account identity and resolve the requested profile against stored User
ownership. IDs select resources; they do not grant access. Unknown/foreign sessions
return 404. New mutations fail closed for missing/invalid User versions, while
read-only saved receipt recovery remains available. No public board is exposed.

| Method/path | Strict request | Result |
| --- | --- | --- |
| GET `/capabilities` | Bearer auth | `session-v2`, `route-transcript-v1`, admission status; no public ranking |
| POST `/sessions` | `{subProfileId,date,createKey}` plus `X-Fort-Custer-Protocol: session-v2` and `X-Fort-Custer-Capabilities: route-transcript-v1` | Original owned attempt, immutable manifest/grid and current effective state |
| POST `/sessions/:id/ready` | `{subProfileId,key,nonce,gridHash,rulesVersion}`, fresh mutation requires `If-Match` revision | Durable STARTED state/start/deadline; repeat preserves start |
| GET `/sessions/:id/status?subProfileId=...` | Exact single query field | Effective state/revision, pinned grid/manifest for coherent client prefix recovery |
| POST `/sessions/:id/abandon` | `{subProfileId,key,reason}`, `If-Match`; reason user-choice/restart/change-grants | Terminal abandonment and old slot release |
| POST `/sessions/:id/complete` | `{subProfileId,completionKey,transcript}`, fresh intake requires `If-Match` | Immutable accepted receipt, or explicit invalid/pending/retry error |
| GET `/sessions/:id/result?subProfileId=...` | Owned selector | Saved receipt before new clock/expiry checks |
| POST `/sessions/:id/recover` | `{subProfileId}`; no caller proof/time flag | Winner, no-pending status, or transactionally proved abort/revision |

Keys contain 8–128 ASCII letters/digits/underscore/hyphen. Attempt IDs/nonces are
UUIDs, profile/account selectors are canonical ObjectId strings, dates are real
UTC `YYYY-MM-DD` values. Future dates and missing mazes are not admitted. Exact
recognized replay bypasses stale/missing If-Match; changed scoped payload conflicts.
Create/complete keys are account/operation scoped, ready/abandon include attempt.

Receipt response is `{protocol,attemptId,date,status,routeValidated,progress,timing,
collectible,integrity}`. It contains no transcript/hash, clock provider/evidence,
internal result ID, check map, account ID or private receipt/guard sample. Owned
session responses include the original start/deadline, pinned grid and manifest.
Errors use fixed codes and never serialize exceptions, raw request bodies or stack
traces. 503 responses are conservative `outcome: unresolved, retrySameOperation:
true`; an empty read is never advertised as abort proof. Owned recovery resolves it.

Fresh auth/schema errors use 400/401/404; missing revision 428; changed binding/state
409; expiry 410; size 413; compressed encoding 415; invalid route 422; missing
capability 426; bounded operation limits 429; operational/unknown outcome 503.
Retry errors supply Retry-After. Responses use Cache-Control no-store.

## Approved timing and progression policy

The start is the server sample at the guarded ready write, authoritative only when
that transaction commits. Completion receipt is sampled once after authentication,
ownership, bounded normalization and operation binding, before route validation.
Internal retries keep that receipt and recheck a new pre-deadline guard. A new
receipt is admitted only after a shared-fence resolver proves the old generation
aborted. Ready-commit/ACK overhead, downlink, play, upload and work before the
trusted timestamps are charged; later commit/response retries do not rewrite it.
There is no pause, RTT subtraction, client duration authority or three-second v2
floor. Client elapsed remains provisional. Millisecond units promise no equal
network fairness. Fabricated legal routes remain possible; replay does not prove
live/human input or when actions occurred.

D5 is explicit: a genuinely accepted legal route writes completed date progress
and the date opportunity even if timing is untimed. Only healthy, comparable,
bounded server evidence can produce `timing.status: official`; held/negative/
incomparable/unhealthy timing returns untimed with null elapsed, never a ranked
number or an official-time label. Pending, rejected, unvalidated or expired requests
write no accepted-date state. The default clock adapter is **unmonitored** and can
never certify official timing. Real monitor/uncertainty approval is a release gap.

D6 is explicit: history missing/unknown becomes legacy-held and returns a review
message while still saving accepted exploration. Known-clear history must have a
trusted private evidence reference before creating a claim. Explicit reviewed
awarded/exhausted history never creates another grant request. Existing inventory
and saved results are never read as proof of date attribution and never rewritten.
Compensation and authorized reconciliation remain separate approvals.

## MongoDB boundaries and recovery

All new collections are `fc_v2_*`: sessions, slots, operation keys, intents, private
transcripts, results, outbox, observations, date history, date ledger and progress.
Explicit provisioning verifies replica-set topology. Unique indexes enforce
account/operation/key/attempt scope; account/profile slot; one result per attempt;
attempt/generation; event result/type; and account/profile/date history/ledger/
progress. No automatic TTL deletes receipts, keys, pending proof or transcripts.

Transactions use primary/snapshot reads and majority journaled writes, a five-second
commit/write-concern timeout, eight transaction attempts and three explicit commit
attempts (the driver can also retry commit). Unknown commit never reruns the body
as a substitute for resolving the original operation. Majority winner reads precede
new timestamps; resolver transactions read winner first and write the same
session/intent fences if absent. Missing/local reads and clock ordering do not prove
abort. Effective expiry and slot deletion match the old attempt, preserving a
successor slot. Pending uncertainty takes precedence over expiry/abandonment.

Before any finalizer guard sample, a separate majority transaction admits a bounded
unresolved clock check on the same session/intent fences. Failed evidence writes,
unknown commits or process death leave the check unresolved/reversed, preventing a
competing healthy guard from certifying that same receipt official. Exact local
reversal samples persist only when their evidence transaction commits; the durable
hold survives without them. Late evidence stays private and never rewrites a frozen
winner. Conservative false holds require a future authorized review/repair path.

Finalization atomically writes: a version-checked User fence (protecting against
profile deletion/stale saves), accepted date progress/opportunity, immutable result,
intent completion, terminal session, old slot release, key mapping and outbox.
Any failure rolls these effects back; the earlier intake/clock admission remains
recoverable. Finalization after a good pre-deadline guard may commit after deadline.

## SYS-03 boundary and writer inventory

`recordAcceptedDate` requires accepted validity, supported validator version and
matching account/profile/date/result identity. It runs inside the caller's receipt
transaction. One profile/date ledger chooses the first accepted opportunity;
replays and subsequent attempts retain its original result/grant ID. It emits
`sys03-grant-v1` request metadata for known-clear dates. It does **not** select an
item, pay inventory, retune rarity, mark consumed/exhausted after payment or ACK
delivery. Tests exercise its v2/future-legacy interface, not upgraded v1 endpoints.

| Existing writer/source | Current behavior and required compatibility work |
| --- | --- |
| `services/completions.js`, UUID and ID-less v1 completion | Per-attempt reward selection and User OCC; unchanged. Must join shared accepted-date/inventory transaction before date-unique activation |
| `routes/mazeRoutes.js` v1 start | Appends embedded attempt and saves User; unchanged; gate/drain its in-flight writers at cutover |
| `routes/userRoutes.js` registration/profile add/edit/delete | User saves protected by existing version hook; unchanged. Profile deletion/retention and all external writers require audited lifecycle policy |
| Legacy progress endpoint | Existing read-only compatibility behavior; unchanged |
| `scripts/generateMazes.js` | Maze publication writes; unchanged. Runtime pins the selected stored grid/seed version and never reinterprets an existing attempt |
| `scripts/rewardSeeder.js` | Destructive catalog replacement; never run by this package. Future updater/catalog changes remain SYS-03 responsibility |
| New v2 finalizer | New sidecars and User version fence, no inventory mutation; cannot be mounted by production installer |
| External admin/maintenance/SYS-03 workers | Not enumerated from deployment/data; authoritative inventory/drain and compatible grant worker still required |

## Bounds, privacy and release blockers

The independent replay port validates contiguous `{seq,dir}` commands from S to E,
walls/bounds, one non-stacking X equipment, stationary F clearing/consumption, extra
entry action and terminal arrival. Max 65,536 commands / 2MiB normalized transcript;
decoded HTTP body including envelope/whitespace is capped at 2MiB+4KiB before parsing.
Compression is rejected. Ingress has eight requests/process and an absolute ten-second
body deadline. Actual worker threads admit two jobs/process, at most one/account,
with 64MiB worker heap and five-second wall timeout, no unbounded queue. Saved result
recovery bypasses replay workers. None of these values is a measured production SLA.

Check maps cap at 16 per intent, generations at eight per attempt, complete key
aliases at 16 per attempt. Exhaustion fails closed with durable proof retained; it
does not silently discard evidence or grant. The initial runtime grant registry is
empty: standard-only admission, unknown client powers rejected, no production
fixture abilities. Process-local admission limits are not distributed quotas.

Activation blockers remain:

* Actual compatible v1/all-writer ledger and atomic SYS-03 inventory/grant worker,
  exhaustion/catalog changes, adjudication/invalidation/audit, duplicate delivery
  and drain/cutover/rollback proof (T6/T8). No migration or historical attribution.
* Independent runtime HTTP/storage QA; multi-member elections/partitions/majority
  loss, physical durability and staging capacity. Single-member tests certify none.
* Monitored clock epochs/uncertainty, independently authorized hold repair, bounded
  operational liveness and accessible handling of expiry/overflow/clock outage.
* Client canonical recorder, checkpoint integrity, start ACK latch, provisional
  timer/Help/results/recovery, accessibility/EG-09 and end-to-end resource limits.
* Public fastest-valid projection, opt-in serializer/confidential cursor/invalidated
  result suppression (T7). No public v2 ranking exists in this slice.
* Distributed rate quotas, retention/appeal/deletion periods, least-privilege storage,
  backup/restore and external writer enumeration. No retention period or cleanup job
  is silently approved. Private detailed evidence persists pending that policy.

Keep issue #5 open. Rollback of this disabled slice can remove unmounted code without
altering v1 data. After any later activation, disable new admission while preserving
owned ready/result/intent recovery; never downgrade to unsafe writers or delete
ledger/result/key tombstones. A compatible operator release/drain rehearsal remains
required; this PR supplies no production migration or enablement instructions.

## Local evidence and acceptance

Run with Node 24 and MongoDB 8.0.16 using an executable supplied through
`MONGOD_BINARY`; all DB suites allocate their own temporary data/loopback ports.
They ignore an intentionally unusable MONGO_URI and never load the app entrypoint.

```sh
node --test test/playable-runtime.test.js test/playable-transcript.test.js
npm test
git ls-files -z '*.js' '*.mjs' | xargs -0 -n1 node --check
node docs/rfcs/fc-sys-01/replay.mjs | cmp - docs/rfcs/fc-sys-01/replay-output.json
git diff --check
```

Privacy-filtered runtime and complete-regression evidence is committed in
`playable-v2-runtime-results.json` and `playable-v2-regression-results.json`, using
the verified schema-2 reporter. No raw logs, test titles, credentials or machine
identifiers are published. Test IDs map deterministically through `safeName`.

Final local results: **84/84 runtime tests** (37 HTTP/storage/process tests plus 47
ported deterministic replay fixtures) and **327/327 full repository tests**, zero
failures/skips/todo. The full run includes all 243 pre-runtime regressions, including
82 verified feasibility cases and the unchanged v1 suites. JS/MJS syntax, whitespace
and byte-identical RFC replay checks pass. These are author results; independent
runtime QA and release approval remain required. Child-process scaffolding lives
outside automatic test discovery.

Runtime coverage includes real JWT/profile ownership/date/schema/If-Match/size/
compression errors, negotiation/OFF proof, pinned manifests, effective replay,
route/fire semantics, worker failure/timeout, D5 untimed accepted progress, D6
legacy holds and preservation, once-per-date boundary, result/key recovery,
clock-error/delayed-evidence races, stale resolver and profile-deletion conflicts,
atomic rollback, admission OFF recovery and actual HTTP application SIGKILL/restart
at durable intake/clock admission and after final commit before response ACK.
The full suite retains all 82 verified feasibility cases and v1 regressions.
