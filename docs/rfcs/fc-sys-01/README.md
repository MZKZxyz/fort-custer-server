# FC-SYS-01 — playable sessions and permanent per-maze bests

RFC **v0.2**, reconciled from `effc3f47584ff6d315302a9c05569cbd31c4a0f4` on `design/fc-sys-01-rfc`. **Design proposal; no implementation, migration or activation approval.** Only this RFC directory changes. Lead: Server Systems Architect / Integrator; reviewers: Gameplay/Security, Independent QA; Progression owns the SYS-03 interface.

Acceptance authority: [consolidated handoff, issue #5 comment 6414142018](https://github.com/MZKZxyz/fort-custer-server/issues/5#issuecomment-6414142018), incorporating [Gameplay/Security](https://github.com/MZKZxyz/fort-custer-server/issues/5#issuecomment-6413990629) and [Independent QA](https://github.com/MZKZxyz/fort-custer-server/issues/5#issuecomment-6414071389). Prior review was conditional design refinement; ranked security signoff remains withheld. The revised fixtures do not replace independent delta review.

Read with [owner decision matrix](decisions.md), [phased implementation and rollback prerequisites](implementation-plan.md), and [reproducible validation record](validation.md). OD-05/08/09/12/15 principles and EG-09 equal logical visibility are preserved. New policies below are recommendations pending the listed owners; EG-01/02/03/05 and EG-09 geometry/validation remain gates. Client release UX #45 remains a separate workstream.

## Reconciliation checklist

| Handoff | v0.2 disposition | Executable evidence |
| --- | --- | --- |
| 1. Expired idempotent replies | Effective state on create/ready/status; original ID/start retained; explicit receipt/guard/commit rule | Prepare/play replay at deadline−1/0/+1; cleanup and completion orderings |
| 2. Clock health | Immutable start/receipt evidence; irreparable vs review-required; audited independent repair | Positive unhealthy start/receipt, epoch/missing/negative evidence, uncertainty/authority/revision guards |
| 3. Successful-date entitlement | First accepted success, no pending reservation; revision-fenced reassignment; terminal consumption | Rejected/quarantined/pending first receipt; both accepted orderings; late reacceptance; exhausted/unknown history |
| 4. Writer coexistence | Every writer upgraded to shared ledger, or gated/drained transition; unchanged legacy writer excluded | Mandatory API/replica-set failpoints specified in implementation plan; not proven offline |
| 5. Ties and operation identity | `(elapsedMs, receivedAt, resultId)`; account key scope and normalized hash; If-Match | Reversed adjudication ties, exact ties, multi-profile key collision, stale revisions |
| 6. Visibility | Approved equal player-relative logical window retained; dimensions open | Immutable competition manifest modeled; device/accessibility validation remains required |
| 7. Integrity | Receipt timing separate from client-claimed traversal; explicit tier/policy and acceptance rule | A 2400ms claim with no movement evidence can be accepted only at receipt-only tier |
| 8. Interruptions/class/privacy | Continuous clock; explicit fresh ranked replay; grants locked at create; TTL/privacy choices | Recovery/expiry/reload and immutable grant fixtures; accessibility/privacy release evidence pending |

## Audit and pinned baseline

Carried forward from the v0.1 pinned source audit, not a live-system audit. This reconciliation re-read server start/completion source; it does not claim a new client audit:

| Repository / main SHA | Evidence | Observed behavior |
| --- | --- | --- |
| server `d82c272b47486161bf9f37508b69fe3240678655` | `routes/mazeRoutes.js` start/complete | Authenticated user/profile ownership, date validation; every start appends a UUID attempt before sending grid. No ready endpoint or create deduplication; start conflicts return409. No publication-date check beyond maze existence. |
| same | `services/completions.js` | Server receipt minus stored start, rounded seconds, blanket3-second floor. No path or goal proof. UUID-scoped immutable result replay; missing-ID legacy latest selector pinned only within one request. Eight OCC retries on User save. Optional expiry, no expiry assigned by start. |
| same | `models/User.js`, `docs/completion-reliability.md` | Embedded unbounded attempt arrays, mixed immutable result snapshots, User optimistic concurrency. Invalid/missing __v blocks writes. One User write atomically commits completion, reward, progress; replacing it with several collections loses atomicity unless explicitly restored. |
| same | `routes/leaderboardRoutes.js` | Public daily/weekly/alltime queries scan every User; latest progress time, not historical minimum. Summer2025 daily restriction; weekly sums and different completion counts are not equal-comparison race boards. Names/profile IDs currently exposed; v2 public identity/privacy needs review. |
| same | `routes/userRoutes.js` progress | Direct fabricated progress completion already rejected; completed progress can be read. |
| same | completion service reward branch | A distinct attempt can award another unowned item for the same date. Duplicate UUID protection is not date-level first-completion eligibility. OD-09 requires separate EG-03 resolution. Never infer live duplicated awards or alter old inventory. |
| client main `8664c4f2026e8ec4857b31f40e51e5a7e1ce3b97` | `src/pages/MazePage.js` loading/finish | Display uses performance.now after response state initialization, not a server ready ACK or confirmed art/layout readiness. Local storage Date.now is not server scoring input. Finish locks input, saves UUID in sessionStorage, posts profile/date/UUID with15s timeout, retries same intent. |
| same | `src/game/{inputController,inputCoordinator,movement}.js` | Single scheduler, canonical client transition;400ms first hold repeat/180ms repeat; manual fresh presses can move faster than held repeat. Stationary fire clear, terminal completion; no server movement stream. 48px trailing geometry, two-forward-step turn buffer/540ms nominal expiry. Renderer/input fallback is client-side. |

Client audited files match the merged main source (local pre-merge branch was not substituted for main). Server main matches local source. Current auth verifies JWT; it does not prove play. No live DB/catalog, deployment, credential or CI inspection was performed. Existing synthetic completion integration tests provide a future implementation baseline; this RFC's model does not run them or start mongod. `scripts/rewardSeeder.js` is outside scope and must not be run.

## Scoring and integrity contract

Wire protocol remains `session-v2`; this is document revision v0.2. Any implementation must negotiate capability before create; a started v2 UUID never falls back to v1 latest-attempt selection. All values here are proposed, with activation gates in the decision matrix.

`playable-receipt-v2` measures integer `receivedAt − startedAt` milliseconds. `startedAt` is captured immediately before the guarded PREPARED→STARTED write and becomes authoritative only when its transaction commits. `receivedAt` is captured once after authentication, ownership resolution and request/session binding at the trusted application boundary. Retain it through internal transaction retries. The first committed completion wins; this need not be the earliest packet. After a definitive no-commit, a new HTTP request has a later receipt. Unknown commit must be resolved by stable IDs before treating it as no-commit.

| Timestamp | Definition / use |
| --- | --- |
| `startedAt` | Trusted ready write timestamp; immutable origin of official elapsed |
| `receivedAt` | Winning completion request's trusted receipt; official finish and ranking tie timestamp |
| `guardAt` | Trusted completion session-CAS timestamp on the successful transaction execution; expiry eligibility only |
| `committedAt` | Commit observation/diagnostic metadata; not a scoring input or exact physical commit claim |
| `adjudicatedAt` | Validator/reviewer decision timestamp; audit only, never leaderboard tie order |
| `acceptedAt` | **Not a v2 field.** Removed because v0.1 confused receipt and adjudication |

For an honest ACK-gated client, official elapsed includes ready-write/ACK overhead, start downlink, local play, completion uplink, and charged processing/queueing. Ready upload and grid initialization are excluded. Five seconds of identical play with 20ms downlink/uplink yields approximately 5.040s; with 250ms each, 5.500s, before other overhead. This is illustrative, not measured. No RTT subtraction, client pause credit, clock clamping or movement rescaling. Server millisecond precision does not promise millisecond fairness. The client shows a provisional timer, announces saving/pending at finish, then displays the official receipt duration; accessible status must not announce every millisecond.

### Exact expiry and terminal races

The proposed preparation deadline is `preparedAt + 5min`; play deadline `startedAt + 2h`. These are **fixture/tuning proposals, not approved accessible bounds**. Play expiry is an absolute deadline, not inactivity. A session is usable only while trusted time is strictly less than its applicable deadline.

A fresh completion requires **both `receivedAt < playExpiresAt` and `guardAt < playExpiresAt`**, plus matching session state/revision. A guard before expiry may commit afterward. A receipt at deadline−1 with guard at deadline fails; ingress alone reserves nothing. Each retried transaction rechecks current deadline/state and takes a new guard timestamp; retain the same receipt. If cleanup/abandon has already committed, its terminal revision fences the completion, even with an earlier receipt/guard sample. If completion commits first, cleanup cannot expire it. Reads and lazy cleanup may therefore affect an unfinished pending request; disclose this server-contention limitation. MongoDB write conflicts must resolve against the same session document, not independent read predicates.

Create/ready **replay returns current effective state**, including EXPIRED, ABANDONED or COMPLETED, with original UUID/manifest/start/deadline. An old successful ACK never authorizes expired play. Client unlocks only on current STARTED recovery with a still-valid deadline; when an ACK is stale or delayed, recover status before unlocking. During connectivity loss, locally elapsed deadline estimates lock input pending status rather than extending time. Saved completion replay remains recoverable after expiry. Cleanup updates an unfinished session by CAS and deletes its slot only with `{profile, attemptId}` matching the old session; it must not delete a successor's slot. No TTL deletion of results, keys or evidence is implied by session expiry.

```mermaid
stateDiagram-v2
  [*] --> PREPARED: idempotent create
  PREPARED --> STARTED: ready CAS before prepare deadline
  PREPARED --> EXPIRED: effective expiry / cleanup CAS
  PREPARED --> ABANDONED: explicit abandon CAS
  STARTED --> COMPLETED: receipt and guard before deadline / commit wins
  STARTED --> EXPIRED: effective expiry / cleanup CAS
  STARTED --> ABANDONED: explicit abandon CAS
  COMPLETED --> COMPLETED: immutable receipt replay
  EXPIRED --> EXPIRED: no revival
```

Validation is orthogonal to session state: `pending → accepted | quarantined | rejected`, with subsequent decisions appended by revision. Completed/pending validation releases the playable slot; a validation hold never occupies a session indefinitely.

### What accepted means

The proposed immutable result declares independent provenance fields:

```json
{
  "scoringMethod": "playable-receipt-v2",
  "competitionVersion": "approved-manifest-id",
  "runClass": "standard",
  "integrityTier": "receipt-only-client-claimed-v1",
  "validationPolicyVersion": "receipt-policy-v1",
  "elapsedMs": 5000,
  "clockDisposition": "healthy",
  "entitlementStatus": "unresolved-at-receipt"
}
```

`receipt-policy-v1` may accept a successful **claim** after structural/state/ownership/manifest checks, trustworthy nonnegative clock evidence and resolution of documented risk flags. Its trusted validator records reason, policy version and adjudication revision. There is no traversal evidence in `{completionKey}`. An authenticated client can wait a plausible duration without moving and satisfy this limited policy. Acceptance is never proof of reaching E, honest rendering, human input or absence of hidden assistance. Ranked activation of this low-assurance policy requires an explicit owner choice. A stronger policy needs a different integrity tier and independently reviewed protocol; never silently relabel old receipts.

Public copy proposed for this tier: **“Client-claimed completion with server receipt timing. Official time includes connection and save delays; gameplay is not server-verified.”** Show standard/assisted and competition/scoring era. A nonce, auth token, grid hash, minimum wait or pre-ready barrier cannot justify “verified gameplay.”

A future bounded command log could verify legal transitions on the pinned grid and reaching E, but cannot prove when, interactively, or by whom commands were produced. Server-authoritative movement is a separate phase with its own network/input contract; it still cannot prove human input or prevent pre-solving archives. Published-maze replay remains eligible under OD-08/12. Quarantine signals are appealable risk indicators, not fraud labels; network instability and unusual accessible controls are not cheating.

### Clock evidence and adjudication

Persist immutable evidence for start and receipt: clock provider/epoch, monitor evidence reference, health, estimated uncertainty in milliseconds and applied bound/policy version. Cross-process UTC requires a monitored clock authority; process monotonic time alone cannot compare machines/restarts. Evidence references are private. No operational clock service is established by this RFC.

* **Irreparable for this receipt:** negative duration, missing indispensable evidence, or incompatible clock epochs without a trusted common origin. Never rank, including after a generic accepted decision. Do not repair by clamping or editing frozen elapsed; an explicit fresh attempt remains rank-eligible.
* **Review-required:** positive duration with unhealthy monitoring or uncertainty above the policy bound in a comparable epoch. Quarantine. An authorized reviewer may append independently corroborated clock evidence bounding the original interval within the approved uncertainty threshold, with evidence ID, epoch, reason, authority and expected adjudication revision. Merely asserting `accepted` or “healthy now” is insufficient. Keep original evidence and elapsed unchanged.
* **Healthy:** nonnegative duration and comparable, healthy, sufficiently bounded start/receipt evidence. Initially pending; a trusted validator applies the declared limited policy. Other gameplay risk signals may still hold it.

Review operations are private privileged services, not player API fields. The model's authority and repair objects are synthetic trusted inputs, not authentication or independent evidence verification. Public status uses neutral reasons such as “timing review required.” Health thresholds, appeal windows and operational reconciliation must be approved and tested.

### Security assumptions and evidence limits

| Threat / failure | Proposed control | Remaining limit / proof required |
| --- | --- | --- |
| Caller clocks, fabricated finish | Server-owned start/receipt; reject elapsed fields | Authenticated claim can omit all gameplay; tier disclosure/owner choice required |
| Pre-solving, archive reuse, ignoring ACK | Honest-client readiness/input lock, immutable published grid manifest | No secrecy or proof of interactive play; archives/replays remain eligible |
| Ownership/key replay or collisions | Auth on every operation, account-scoped keys, canonical hash, nonce/session binding | Actual HTTP/auth/TLS/nonce entropy and key storage unverified offline |
| ACK loss, asymmetric connection, contention | Stable committed receipt and status recovery, no RTT deductions | Delays remain charged; no network-neutral score claim |
| Declared/hidden assistance or wider view | Server-selected locked grants/class/competition manifest | Client can hide local help/read whole grid; compliant-client geometry/semantic tests required |
| Fast manual or assistive input | Documented appealable risk review; no blanket hold-cadence floor | 400/180ms defaults are not minimum legal action timing. Stateful action feasibility needs rules proof; solver exhaustion means unknown |
| Clock outage/jump/drift | Immutable health/epoch/uncertainty; acceptance guards and auditable repair | Real multi-node monitor, threshold and evidence verification required |
| Duplicate rewards/transaction crash | Unique date ledger, shared writer fences, atomic receipt/adjudication/grant boundaries | Replica-set isolation/failpoints/unknown-commit proof and all-writer cutover required |
| Resource abuse / evidence exposure | Bounded allocations/payloads, recoverable status, alias/private evidence | Quotas, capacity, retention and accessible shared-network behavior need review |

## Versioned request, response and idempotency contract

All v2 writes require authenticated account/profile ownership, including every replay. IDs are selectors, not credentials. Unknown/foreign resources return non-enumerating 404. Reject unknown fields, caller elapsed/owner/rank/grant assertions, malformed UUIDs and invalid dates before hashing or effects. Enforce bounded JSON, exact enums, `Cache-Control: no-store`, and account/profile/infrastructure quotas; shared-IP limits must preserve family access and owned status/result recovery.

Canonical hash: normalize schema defaults and dates, sort/deduplicate declared ability IDs according to the schema (duplicate IDs rejected), recursively sort object keys, preserve meaningful array order, encode UTF-8 JSON, SHA-256. Include operation, profile ID, target attempt and normalized body as applicable. Hash excludes If-Match, network headers and server-selected response metadata. Store request hash and original server manifest; changes to current server defaults do not change old replay. No keys reclaimed absent a separately versioned retention/creation-window contract.

| Operation | Body / precondition | Outcome and replay |
| --- | --- | --- |
| POST `/api/v2/sessions` | `{subProfileId,date,createKey,requestedAbilityIds:[]}` | 201 PREPARED, immutable published grid/hash/rules/competition/grants/class and ready nonce. Unique `(accountId,createKey)` with profile in payload hash. Same normalized request: 200 same ID and current effective state; changed profile/body: 409 IDEMPOTENCY_CONFLICT. Different key with active profile slot: 409 ACTIVE_SESSION; never implicit takeover. |
| POST `/sessions/:id/ready` under v2 prefix | `{readyKey,nonce,gridHash,rulesVersion}`, `If-Match: revision` | CAS PREPARED→STARTED, 200 start/deadline/revision. Exact hash replay returns original start plus effective state despite stale revision. Changed request after transition: 409; bad binding: 409. Server resolves grants and supported manifest, never caller dimensions. |
| GET `/api/v2/sessions/:id` | Auth only | 200 effective state, current revision/serverNow, original manifest/start/deadlines, result link if committed. Recovery never creates another attempt. |
| POST `/api/v2/sessions/:id/complete` | `{completionKey}`, `If-Match: revision` | 201 first immutable receipt; 200 existing receipt after authorized replay, regardless of stale revision/expiry. Account-scoped `(accountId,completionKey)` binds profile/attempt and canonical payload. Different unused keys for same completed attempt bind aliases to its single result. Reusing a key for another attempt/profile: 409, including replay. No second receipt/award. |
| POST `/api/v2/sessions/:id/abandon` | `{abandonKey}`, `If-Match: revision` | CAS PREPARED/STARTED→ABANDONED. Exact key replay returns effective terminal state despite stale revision. New stale operation: 409. Cannot rewrite COMPLETED/EXPIRED. Explicit user action required. |
| GET `/api/v2/results/:id` | Owned/authenticated | Frozen receipt plus separately versioned current adjudication, completion credit and date entitlement status. Original completion response never mutates to report a later reward. |
| GET `/api/v2/leaderboards/:mazeId` | Explicit segment, opaque cursor, limit ≤100 | Accepted current result references only, alias/opaque public identity, boardRevision/asOf; no silent legacy fallback. |

Private session envelope includes `protocol`, attemptId, state, revision, mazeId/date, gridHash, rulesVersion, scoringMethod, competitionVersion, runClass, grant/config versions, integrityTier, validationPolicyVersion, serverNow and applicable deadlines. Completion envelope stores immutable result ID, attempt ID, start/receipt, elapsed, clock evidence/disposition, manifest reference and unresolved-at-receipt entitlement status. Later grant/status has its own revision/URL, never a rerolled original receipt.

Errors: 400 schema; 401 auth; 404 foreign/unknown; 409 state/revision/key conflict; 410 unfinished expiry; 422 ineligible policy; 429 plus Retry-After; 503 transient/unknown commit plus `retrySameOperation:true`. Missing If-Match on a fresh mutation is 428; exact recognized replay bypasses revision requirements. A completed receipt replays only after authorization, valid shape and key-binding checks. Stable result IDs resolve uncertain commits. Across separate requests following definitive no-commit, the client obtains a new receipt timestamp; it cannot submit an old timestamp.

| Identity/race case | Required outcome |
| --- | --- |
| Same create key, account, body; lost ACK | Same attempt, effective state; no slot allocation |
| Same account/create key, different subprofile/date/grants | Conflict, no second attempt |
| Separate accounts reuse key | Independent scopes |
| Same ready hash, stale revision | Original start, effective state; no extension |
| Fresh ready vs abandon with same revision | One winner; losing CAS must not follow through on new state |
| Same completion key or different keys, same UUID | One result; stale revisions do not obstruct committed replay |
| Same account/completion key, different UUID | Conflict before effects |
| Complete vs abandon/cleanup | Shared session fence, one committed terminal state |
| Failure/unknown outcome | No independent writes; resolve same IDs before later receipt or entitlement |

### Client readiness, interruptions and session class

Persist create/ready/complete intent keys before sending, scoped by authenticated profile/date. Initialize canonical state at S, assets/layout, supported renderer or working fallback, focus/controls and recovery before ready. Mount/HTTP success alone is insufficient. Start input/timer only once after usable ACK/status; duplicate ACK never starts another scheduler. A frame boundary is an honest-client readiness check, not proof of display or anti-cheat. Finish uses a synchronous terminal latch and accessible saving/pending/retry feedback.

Lost ready ACK: recover same STARTED session and original start; delay remains charged. Connectivity loss with intact local state: same run, clock continues. Blur, modal, tab throttling and offline time do not pause/refund; cancel unsafe held input. Lost local state/reload: no trusted position can be reconstructed here. Offer explicit abandon and a **fresh ranked attempt from S** after readiness, or clearly labeled practice continuation. Reload never permanently excludes that date from personal-best improvement. Do not silently reset a STARTED clock or create a replacement. After expiry, retain owned status/result recovery and offer an explicit new attempt; no keepalive revival.

Server-selected competitive grants, config versions and class lock **at creation**. Competitive ability ownership, cosmetic display, grant and observed use are different. Mere ownership/art selection does not grant an ability. If use cannot be independently observed, any granted competitive capability conservatively makes the session assisted, disclosed before ready. Changing grants requires explicit abandon/new attempt; no in-run upgrade/downgrade. Screen readers, zoom, reduced motion, equivalent input adapters and approved hold/turn access controls remain standard; classify by added route knowledge/solving capability, not disability/device or gesture automation alone. Unknown historical class stays unknown.

Proposed one active session **per profile**, not account/IP, is a resource/UX rule, not anti-cheat. Publish absolute deadlines before ready, accessible advance warnings and status/retry paths. Validate slow initialization, assistive input and background recovery before selecting TTLs; no claim that 5min/2h are fair. New allocations can be bounded without denying recovery.

## Approved logical visibility and competition provenance

[OWNER EG-09](https://github.com/MZKZxyz/fort-custer-client/issues/32#issuecomment-6391379952) already requires an **equal player-relative logical tactical window for every standard ranked daily run**, independent of screen/orientation/zoom/resize. Every cell in the crop is visible. No mechanical fog, device handicap, zoom restriction or collectible larger-viewport substitute. **7×3 is an experiment, not an approved dimension.** Only dimensions, projected geometry/edges, short-screen handling and validation remain open.

Pin an immutable server-selected competition manifest containing approved logical window specification, edge behavior, renderer/semantic information contract, input/rule versions and competitive grant policy. At equivalent state/position, validate logical cells under the 58° projection, visual clipping/overhang, alternate renderer, pan/rotation, resize/orientation and DOM/focus/screen-reader semantics. Offscreen map coordinates/route announcements must not provide map peeks; retain usable essential navigation, goal identity and “Reach the tipi” instruction. Equivalent access is required, not removal of essential cues.

Manifest binding controls compliant-client consistency; a modified client holding the grid can ignore crop or hide assistance. Inventory every v1/v2 grid delivery, archive, cache and publication path before release: v2 publication checks alone do not close legacy delivery. Preserve old fog/camera provenance as separate known/unknown eras; no guessed equivalence or new device splits. Public legacy/current board presentation and any segmentation transition require an owner-approved era contract without reopening permanent-fastest or equal-window principles.

## First accepted successful date: entitlement and completion credit

This is the proposed SYS-01/SYS-03 interface to [server issue #7](https://github.com/MZKZxyz/fort-custer-server/issues/7). Date key is the immutable **maze date per profile**, independent of receipt UTC day, class, scoring method or competition era. Midnight, archive catch-up and assisted/standard replays cannot open a second opportunity. Permanent best may improve on every eligible replay.

The first **accepted successful** result claims eventual entitlement, ordered by the date-ledger transaction's acceptance sequence, not first receipt or earliest historical start. Pending/quarantined receipts do not reserve the date. First means first committed accepted decision while entitlement is available; a later adjudication of an older receipt cannot preempt a consumed opportunity. This interpretation is a recommendation requiring Progression/owner confirmation, not a claim that old inventory already follows it.

| Result / history | Completion credit and rank | Date ledger |
| --- | --- | --- |
| Pending/quarantined | Private saved claim; no accepted completion credit or rank | No reservation; later accepted replay can claim |
| Rejected | No accepted credit/rank; receipt retained | No reservation; release/reassign any unconsumed claim |
| Accepted receipt-policy result | Accepted completion distinction and segment best eligibility, clearly limited integrity | First current accepted success gets eligible claim; other accepted results can be fallbacks |
| Historic awarded or exhausted | Preserve recorded distinctions/inventory/snapshots | Already consumed; never reopen |
| Unknown/missing historical attribution | Preserve unknown, do not guess success/grant | Hold new reward; ranking new accepted attempts remains independent |

Recommended ledger states: `available → eligible(resultId,revision) → consumed | exhausted`; `legacy-held` blocks new opportunities for awarded/exhausted/unknown prior history. A consumed ledger also stores its outcome provenance; history known clear requires authorized evidence, not merely absent latest progress. A rejection/quarantine before consumption atomically selects the earliest still-accepted fallback, or returns to available. Every claim change increments ledger revision; delayed outbox tokens containing old result/revision fail. Acceptance/rejection races and grant processing touch the same date-ledger fence. Reacceptance appends a new decision/acceptance sequence and cannot undo terminal consumption. If invalidation occurs after consumption, retain original inventory/opportunity and flag audit/appeal; no reversal or second grant. Current accepted credit can be recomputed independently; frozen receipts remain unchanged.

Inventory is **not** granted in the receipt transaction or this model. In a separately authorized SYS-03 worker transaction, recheck current accepted adjudication + ledger revision, serialize on profile inventory/version, select from current unowned catalog under an approved versioned rarity policy, write inventory delta + immutable grant snapshot + terminal ledger + outbox acknowledgement together. Retry/unknown commit resolves stable grant ID; never reroll a committed decision. Empty catalog consumes `exhausted` permanently, even after later catalog expansion; no substitute item. Concurrent different dates must also serialize inventory to avoid granting the same previously unowned item twice. Historical quantities, retired IDs and v1 UUID reward snapshots remain untouched. This package specifies no rarity weights or catalog operation.

The model's `consumeOpportunity` is only a revision-fenced **opportunity state transition**. It has no inventory, catalog selection, grant or exactly-once delivery implementation. Frozen receipts contain `unresolved-at-receipt`; current entitlement/grant is a separate versioned status. This fixes the v0.1 permanent reservation/“held” ambiguity without manufacturing an inventory guarantee.

## Persistence, projections and privacy

Proposed additive collections; no live deployment shape assumed:

| Collection | Identity / invariant |
| --- | --- |
| SessionsV2 | UUID; owner/profile/immutable manifest, hashed request/nonce, state/revision, start/deadlines/evidence; unique `(accountId,createKey)` tombstone |
| ActiveSession | Unique profile identity, current attemptId; guarded successor-safe delete |
| ResultsV2 | Unique attemptId + stable resultId; immutable receipt/start/elapsed/clock/manifest/snapshot |
| OperationKeys | Unique account/operation/key; canonical request hash and target/result alias; no unversioned reclamation |
| Adjudications | Unique result/revision; append decision/authority/reason/evidence/adjudicatedAt/policy; current state fenced |
| DateEntitlements / GrantRecords | Unique profile/date; history/claim/revision/terminal outcome; unique stable grant ID, immutable snapshot |
| Outbox | Unique event ID; result/adjudication/ledger revision, stable aggregate sequence; atomic insertion with source mutation |
| BestV2 / BoardEpoch | Unique profile/maze/scoring/competition/class best; monotone source eligibility epoch + published board revision |
| LegacySidecar | Source reference/hash, known/unknown units/method/class/eligibility; never rewrites old arrays |

Receipt, terminal session, active-slot release, operation-key mapping and receipt outbox commit atomically. Accepted decision, date-claim/fallback, board eligibility epoch and decision/entitlement outbox commit atomically. Grant transaction is separate as above. Snapshot isolation alone does not serialize read predicates: use unique constraints and explicit aggregate fence writes, not check-then-insert logic. See implementation plan for concerns/failpoints and rollback requirements.

Personal best and board ordering use exactly **`(elapsedMs ASC, receivedAt ASC, resultId ASC)`** with a fixed binary comparison for canonical opaque IDs. Receipt time breaks equal elapsed regardless of adjudication order; commit/validator timestamps do not. No coarse displayed tie rule is implicitly introduced. Index prefix is `(mazeId,scoringMethod,competitionVersion,runClass)`, followed by sort tuple. Never compare latest v1 progress as historical fastest; retain seasonal daily and weekly/all-time totals with their existing labels.

An invalidated minimum requires full eligible fallback recomputation, including empty-board deletion. Worker reads current adjudications and a source eligibility epoch in one consistent snapshot, then writes projection only if that same epoch is still current; it must write/lock the source fence in its publication transaction so invalidation conflicts. Reading a newer projection revision after an older eligibility snapshot is insufficient. Deduplicate outbox event IDs and fence per-source revisions. Duplicate/reversed events trigger current-state recomputation; no stale resurrection. The offline oracle models a global source-revision fence for clarity, not scalable MongoDB worker/event mechanics.

Public reads validate candidate result/current decision revision so an already-rejected entry is suppressed even if projection repair lags. A lagging board may temporarily omit an improvement/fallback; expose boardRevision/asOf and measured lag. Cursor includes full tuple + segment + board/source revision; changed revision returns explicit restart-pagination response, not silently mixed snapshots. Required read-consistency implementation remains unverified.

Recommend opt-in public alias/participation controls and opaque board identity. Never publish account/subprofile DB IDs, personal account names, IP/device evidence, precise session timestamps, raw logs or private evidence references. Public tie order is supplied by rank/cursor, not raw receipt time. Aliases need moderation and must not copy personal account names by default. Private evidence has least-privilege access, audited review/export and an owner-approved appeal/retention/deletion period. Separate short-lived detailed telemetry from minimal identity/key/result/entitlement tombstones required to prevent replay/re-award; pseudonymize deleted-profile references under an approved deletion contract. Session TTL is not an evidence-retention rule. No numerical retention period is silently approved here.

## Compatibility and next review

A **behaviorally unchanged v1 per-attempt reward writer cannot coexist with date-unique entitlement**. Preserving request shapes/snapshots does not preserve that old reward rule for new results. Choose the all-writer ledger upgrade or a gated/drained cutover in the implementation plan. Preserve committed v1 UUID response bytes, missing-ID ambiguity only for v1, User OCC/invalid-version policy, historical quantities and labels. Do not infer old successful dates/reward attribution from latest progress or current inventory alone.

Local fixtures are executable design evidence only. They import no app, database, credentials or external packages, and model serial schedules; HTTP/auth/crypto, independent clock reconciliation, MongoDB transactions, throughput, migration and delivery are **UNVERIFIED**. Exact model API arguments such as trusted grants, repair objects and guard timestamps are oracle inputs, not public fields. See validation record for coverage and limits.

Request a focused delta review on handoff items 1–8 after this revision: Gameplay/Security for integrity/class/visibility/recovery language; Independent QA for expiry, clocks, rewards, keys/ties and source-fenced projection counterexamples; Integrator/Progression for SYS-03 all-writer cutover and owner matrix. This request confers no signoff. Keep issue #5 in design/review; do not mark Ready-to-activate or open an implementation PR from this package.
