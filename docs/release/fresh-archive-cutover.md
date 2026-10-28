# Fresh permanent archive: implementation and release HOLD

Issue [#22](https://github.com/MZKZxyz/fort-custer-server/issues/22), parent
[#6](https://github.com/MZKZxyz/fort-custer-server/issues/6). Starting server SHA:
`5a6c9ea5fbd90195df0e08d55e552d2d9359d7fb`, verified equal to fetched main before
branch creation. This implements the owner's START FRESH product decision. It
supersedes the historical-inventory prerequisite in the Sprint 1.7E report.

**No launch date or live release identity is approved by this PR.** The committed
`config/fresh-release.json` is pending, and `config/legacy-publications.json` stays
unapproved/empty. The checked-in server refuses startup before connecting or
listening. No real published maze, deployed fresh API, or working live scheduler
is claimed. Keep the existing live game until a coordinated owner GO.

## Admission and startup contract

`release-runtime.js` loads one fixed, source-controlled artifact once per process.
There is no environment selector, admin route, network lookup, or hot reload.
The real `index.js` and all three default archive/start/daily router compositions
use it. Dependency-injected legacy policies remain available for isolated
regression fixtures; they are never the production defaults.

| Artifact field | Validation |
| --- | --- |
| schemaVersion | Exactly 1 |
| status | `pending` or `approved-fresh` |
| scope | Exactly `fresh-only-no-legacy` |
| releaseId | Pending: null; approved: distinct 1–64 lowercase letters/digits/hyphens |
| startDate | Pending: null; approved: real UTC YYYY-MM-DD, supplied by owner |
| startsAt | Pending: null; approved: exact UTC instant, same civil date as startDate |
| approval | Pending: null; approved: exact decisionRef, approvedAt, decisionHash |

UTC instants must round-trip as `YYYY-MM-DDTHH:mm:ss.sssZ`. Approval must precede
or equal startsAt and must not be in the future when the process loads. The
cutover may be later than process startup: the API then starts empty. There is
no fallback to today's clock date. Every object has exactly its own enumerable
data keys; unknown keys, accessors, symbols and custom prototypes fail closed.
Missing/oversized (>8 KiB)/malformed artifacts fail before DB connect/listen.
An approved or nonempty legacy artifact conflicts with fresh startup and rejects.

`releaseDecisionHash` is SHA-256 over canonical JSON of:

```text
["fort-custer/fresh-release-v1", schemaVersion, scope, releaseId,
 startDate, startsAt, approval.decisionRef, approval.approvedAt]
```

**Trust boundary:** the digest detects stale/tampered content; it is not an owner
signature. Source review, branch controls and an owner-approved immutable release
commit establish authority. An actor who can replace code or recompute an entire
forged approval is outside this runtime validator's protection. No function here
creates a live approval or independently authenticates an audit reference. Owner
review must verify the actual decision reference and full release commit.

Fresh admission always denies markerless legacy records, even if they have
attempts, rewards or a matching historical hash. Modern documents must pass the
existing grid shape/tile/hash/config/version/provenance checks **and** have:

- date >= approved startDate and <= server UTC today;
- publishedAt >= approved startsAt (therefore >= approvedAt), and <= sampled now;
- exact provenance.releaseId and provenance.releaseDecisionHash from the decision.

An old valid-looking `year-round-v1` prototype without these bindings is denied.
Both exact reads and bounded archive queries enforce this. Indexed edge scans
prefilter on the cutover, timestamp and release binding before the existing
32-candidate integrity cap; over 32 excluded older prototypes cannot poison the
first/last date. Corrupt matching candidates can still produce a bounded 503,
which is safer than pretending a complete catalog exists.

The optional schema provenance fields are additive. Existing rows are neither
stamped nor rewritten. All four existing index prerequisites remain; startup
still sets autoCreate/autoIndex false and only issues bounded listIndexes. The
owner reported all four definitions verified in issue #21. That report is not
a new inspection here or proof of a deployed application's readiness.

The first actual valid stored row determines catalog edges; an approved artifact
alone never publishes a date. Today remains unavailable until a genuine stored
publication is visible. Missing days stay holes. The original persisted completion
receipt/UUID recovery is unchanged, including when its maze is now excluded.
Excluded dates cannot receive new starts; saved data and rewards are not rebuilt.
Current v1 timing/reward/ranking semantics and the v2 activation interlock remain.

## One-date operator workflow: disposable implementation, live design gate

`controlled-publication.js` exports `previewFreshPublication` and
`publishApprovedDisposable`. It is not imported by the app, startup, HTTP routes,
or either preview CLI. There is no apply command, live URI selector or production
switch. The previous `publishMaze` remains disposable-only and unchanged except
for exporting its scope guard. The new workflow uses that same loopback/no-auth/
`fc_publication_synthetic_*` guard; **do not relax it to publish live**.

1. Supply the separately approved fresh decision and all four explicit inputs:
   date, seed, algorithm version, and every canonical config field. Defaults for
   omitted fields are refused by this interface. No seed search or fallback.
2. Preview with the bounded generator. It returns the exact grid, solver analysis,
   generation hashes, finite notBefore/expiresAt (at most 24 hours), and planHash.
   Preview returns no approval and performs no database operation. A delayed day
   may be approved explicitly; the date must not be future and must fit the era.
3. Independently review the grid/solver/difficulty, release binding, versions,
   config, exact seed/date, planHash and execution window. A separate certificate
   has schemaVersion 1, scope `one-date-disposable-insert`, decisionRef, approvedAt,
   planHash. Only fixture code fabricates synthetic approvals. A certificate can
   be used only after approval and during its finite window (expiry exclusive).
4. Supply an explicitly connected owned disposable model. The adapter requires
   finite discovery/connect/socket budgets <=5 seconds, retryWrites/retryReads
   false, one pool connection and a positive waitQueueTimeoutMS <=2 seconds.
   These caps match one sequential fixture workflow, not a production pool tuning
   recommendation. It verifies the existing unique date and archive indexes using
   two bounded metadata commands (one exact-name collection/UUID lookup and
   <=16 index entries), never DDL or collection creation.
5. One exact-date read: a different grid, identity, era, release or excluded old
   row is `PUBLICATION_DATE_COLLISION` — STOP for owner decision. Do not delete,
   replace, stamp, reseed or automatically choose another date. An exact valid
   stored winner is returned unchanged as idempotent recovery.
6. If absent, regenerate the identical approved candidate in the bounded worker,
   verify its hashes and provenance, then issue exactly one native insert command (one document) with
   majority write concern and 2s command/write-concern limits. Mongo's existing
   unique date index is the cross-process collision guard. Exact-date reads and
   the insert bind the observed collection UUID, so concurrent drop/recreate cannot
   cause implicit collection creation or redirect publication to a replacement. One publication slot
   per process bounds local concurrency; a second call fails immediately.
7. After ACK or uncertainty, do one primary majority exact-date read. Verify stored bytes and all
   bindings before reporting success. A matching winner reconciles a duplicate or
   lost ACK. A differing winner is STOP; no winner/read failure is UNCERTAIN.
   Never retry a write within this call. An authorized later operator may reconcile
   the same identity; unresolved uncertainty stops further publication.

The plan hash binds domain/version, release digest, explicit date/version/seed,
canonical configHash, identityHash, gridHash and time window. Validated immutable
bindings are captured before awaits. Audit packages must retain the reviewed plan,
certificate, exact source/worker artifact digest, metrics and verified stored hash.
The production document retains generator and release provenance, not the whole
operator certificate; later live audit storage/retention is a review decision.

Worker safeguards are unchanged: Linux, one worker, 1.5s watchdog, 48 MiB old heap,
4 MiB semispace, 128 MiB sampled RSS plus final high-water check, 256 KiB IPC cap,
10ms sampling and fail-closed monitor errors. Existing tests exercise deadline,
RSS failure, concurrency, malformed IPC and bounded solver/rejection cases.
**These are not OS network or whole-process memory isolation.** Node permissions
do not disable sockets; RSS sampling has gaps, and operation budgets do not prove
an OS deadline for the entire process tree. The disposable adapter has no live
credential capability. This is deliberately not a production-capable publisher.

Before a live adapter is implemented/approved, security/infra must provide:

- Generation in a separate OS network namespace/container with no egress, no DB
  credential/environment mounts, read-only versioned code, PID/process-tree/CPU/
  memory cgroup limits, bounded input/output and independently enforced wall time.
- A separate operator-owned DB writer with scoped short-lived credentials and
  network allowlist, exact reviewed cluster/database/collection identity, no
  implicit ambient URI, read/find and insert only (no update/delete/DDL), and
  verified existing schema/indexes. Replica-set discovery/TLS and writer egress
  must be reviewed; a single hostname check is insufficient containment.
- A reviewed live approval verifier (source-pinned certificate or external signed
  authorization), execution expiry/one-date scope, cross-host single-flight/lease,
  hard whole-operation/process deadline, sanitized private audit and metrics,
  bounded post-ACK majority visibility/reconciliation and an explicit operator STOP.

No credentials, network policies, infrastructure settings or publisher deployment
are prepared here. Scoping privileges, durable audit certificates and the actual
live adapter are outstanding security/release gates, not tasks silently delegated
to an unisolated Node worker.

## Coordinated cutover and rollback

Accepted client archive head: `2c6dc171e6c7786ef5469009f593f9fa48a952e5` (#54,
still draft/unmerged). Client main observed at
`afece64170a46d01c0c4123f4ffd9084d4f671db`. Changes since their common ancestor
are docs/art/batch-01 and batch-02 only. Last approved live server reported in
#22: `8e3eac84f7081f3b1a51df317b35f782d64561db`, auto-update OFF, v2 OFF.
These are source/issue observations, not fresh production inspection.

**Older-client gameplay breaks intentionally at cutover.** Current old-client
MazeCollectionPage clamps months May–September 2025 and selectable dates May 26
through September 1 inclusive (99 days), with DEBUG_UNLOCK_ALL true. Post-2025
progress defaults selection to September 1. All 99 dates are denied by the fresh
server. MazePage displays the server's unavailable message with Back to mazes,
which returns to the obsolete calendar; it cannot discover the new archive.
Existing persisted UUID results can still be retried; do not clear localStorage
or sessionStorage, reconstruct old histories or promise old-client playability.
Weekly/alltime historical aggregates remain under their existing contract; this
change gates daily publication and does not reset historical player statistics.

Recommended sequence, each live step separately owner approved:

1. Independent systems/security/QA review of the exact server PR head. Review the
   pending artifact and all disposable evidence. No production operations yet.
2. Owner selects the real launch date, UTC time, unique release identity, scope,
   decision reference and approval time. Commit/review the exact artifact and
   immutable resulting release SHA; leave legacy inventory empty/unapproved.
   Changing the launch identity/digest later would hide its bound published rows:
   retain it permanently and use a separately designed policy if an era changes.
3. Complete live writer containment/security review and approve the exact one-date
   plan. Reconfirm no date collision via an independently approved exact read.
   Collision means STOP; no historical inventory scans or destructive remediation.
4. Prepare the final combined client tree/build and independent browser/ownership/
   UUID-recovery QA against the intended server release, before the transition.
   Do not merge #54 or modify platform configuration to obtain a preview.
5. Within a short announced/approved transition, prefer **fresh server deploy
   first**, empty archive smoke, then separately approved exact-date insert and
   verification, then immediate approved client promotion. Fresh API before the
   first insert enforces release bindings and keeps old test dates unavailable.
   While empty or waiting for insert, old clients cannot play; communicate this
   interruption outside this engineering PR. The new client shows unavailable
   Today and offers no phantom fallback. Current server has no maintenance banner
   that can fix already-loaded old bundles; a banner/refresh bridge needs its own
   reviewed client scope if the owner requires one.
6. **Do not insert first into the old live server by assumption.** Source audit
   of `8e3eac84` shows start performs raw findOne(date) without fresh admission,
   archive is absent and daily ranking refuses dates outside summer 2025. An
   early genuine insert could become directly startable before fresh enforcement
   while ranking fails. Any insert-first alternate needs explicit owner/security
   acceptance or independently verified traffic isolation; neither exists here.
7. Authorize pinned Railway deploy/health/auth smoke separately: correct SHA,
   artifact digest, UTC clock, index checks, root, empty/real archive, old date
   refusal, one owned start/complete/exact UUID retry, owner isolation, stored-grid
   hash, daily availability, missing-day and v2-off checks. Inspect no broad private
   content. Root is startup health, not continuing DB readiness.
8. Only after genuine first publication and authenticated preview pass, owner may
   approve the final client merge/promotion (Vercel main auto-deploys). Verify the
   final combined tree and actual optimized API target again. Test fresh navigation,
   hard reload, retained old open tab, cached HTML/bundle and result-retry tab.
   Preserve receipt storage; ask stale users to reload after result recovery.
   Hashed assets do not update an already-running SPA. Cache/header/platform
   behavior needs preview inspection, not assumed invalidation or settings changes.

Rollback is code/traffic only; never undo grids, receipts, attempts, rewards or
indexes. A pending artifact can stop a fresh process on restart but is not a
traffic rollback and does not hot-revoke an existing process. Keep a known-good
fresh release/image with the **same approved identity** for rollback after launch.
Before first publication, abort the transition and retain the current game when
safe. After publication, reverting to `8e3eac84` re-enables old test starts, lacks
fresh policy and cannot rank new dates: **not a safe routine fresh-era rollback**.
Use an independently approved fresh-compatible image or explicit owner-approved
maintenance/traffic hold. Never silently roll an archive client onto an old API;
it will show unavailable. Owner must approve any temporary return to old product
behavior. Verify retained images/settings and v2 OFF privately before rollback.

Stop acceptance for wrong SHA/artifact/clock/target, date collision, failed proof
of a genuine stored grid, repeated 503 or admission leak, duplicate award/result,
owner privacy failure or unavailable fallback. Monitor immediately, +5/+15min,
then UTC rollover under separately approved read/smoke scope. These are runbook
proposals, not actions performed by this PR.

## Daily continuation design (disabled; no scheduling code)

A future separately reviewed scheduler samples UTC once per job, uses the fixed
approved release binding, deterministic date seed and pinned algorithm/config,
and requests a single bounded job for that date. One active job across hosts;
unique-date insertion is the final arbiter. It must never select tomorrow, use an
alternate seed, scan/reseed history or infer success from clock advancement.

Monitor candidate/solver failure, deadline/RSS/IPC/OS containment failure, job
busy, target/credential/index failure, collisions, uncertainty, missing current
day and first/last publication lag. A bounded same-identity retry requires a
resolved exact-date read and a valid execution window; cap attempts, add finite
backoff and alert rather than looping. Rejection exhaustion is operator STOP.
Missing day stays unavailable across midnight; a later separately approved
one-date late publication becomes visible when stored and cached catalog expires
(public TTL <=60s, private responses no-store). Backfill requires its own exact
scope/approval. Preserve algorithm versions for audit; serve stored grids forever
without regenerating them. No scheduler/cron/service is created or activated here.
