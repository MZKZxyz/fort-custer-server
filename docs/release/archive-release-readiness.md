# Sprint 1.7E release readiness — HOLD

Historical report: issue #22's owner START FRESH decision supersedes the legacy
inventory prerequisite below. See [fresh-era cutover](fresh-archive-cutover.md)
for current startup/admission and release gates. No historical inventory is now
requested or authorized; this report remains prior engineering evidence.

Issue #19; parent #6. Exact starting server main:
`1f668d23477aa62557bd531e501ce5f6771bdd0c`, the independently accepted server
archive implementation. Client archive source accepted for review is
`2c6dc171e6c7786ef5469009f593f9fa48a952e5`; the reviewed archive contract is client
issue #50. Source readiness and production activation are separate decisions.

**No real legacy inventory was supplied or verified.** The committed artifact is
empty/unapproved and the new entrypoint deliberately refuses startup with it.
Keep the current live image until owner-approved positive evidence and a separate
release GO. This PR prepares the mechanism and synthetic evidence, not an unlock.

## What changes

- Versioned bounded manifest schema, exact stored date/grid hash, independent
  publication/observation evidence references and reviewed approval digest.
- Fixed-path, once-per-process loading into the actual default archive/start/daily
  routers. Invalid/missing approval never silently grants a date. No live loader,
  runtime environment bypass, mutation, database migration or admin endpoint.
- `app.js` holds the existing production Express composition and v2-off gate;
  `index.js` remains the connection/listen entrypoint. CORS, auth routes, original
  start/complete response shapes, UUID receipts and legacy daily arrays remain.
- Production connection disables autoCreate/autoIndex. Before listen, bounded
  read-only listIndexes checks require the exact date, archive, user-email and
  reward-id indexes. Failure closes the connection and exits without HTTP listen.
- Existing generator, worker containment fix, dormant writer, completion/reward
  service, model publication fields and v2 activation blocker are unchanged.

The old server main image reported by issue #19 is
`8e3eac84f7081f3b1a51df317b35f782d64561db`, with auto-update OFF and no archive API.
The reported client main is `afece64170a46d01c0c4123f4ffd9084d4f671db`, with main
auto-deployment ON. Those are issue/source observations, **not newly verified
deployment state**. No platform settings, images or production endpoints were
queried or changed here.

## Readiness matrix

| Gate | Current disposition |
| --- | --- |
| Manifest schema/default-router wiring | Implemented; positive cases synthetic only |
| Positive real publication evidence + exact stored hashes | **Absent; HOLD** |
| Owner approval of real inventory digest/source | **Absent; HOLD** |
| Actual production schema/index metadata and capacity | **Unknown; not read; HOLD** |
| Nonproduction old-client/new-server HTTP compatibility | Verified against real default entrypoint |
| Accepted client missing-catalog/recovery behavior | Pinned fixture + fresh client unit checks; see validation report |
| Client art/archive final combined tree/build | **Not certified; HOLD before client merge/promotion** |
| Actual API image/health, old-player smoke and rollback | **Not executed; separate owner GO** |
| Initial live current-day maze | **Not authorized or implemented** |
| Live adapter/scheduler/backfill/monitoring and v2 | **Not enabled** |

## Schema/index preflight — read-only proposal, not executed on production

Existing Maze fields remain additive and optional for markerless rows. Legacy
grids and saved histories are not rewritten to add publication metadata. The
new-era provenance schema was already accepted in server #18; strict persistence
and old receipt compatibility remain covered by the disposable suite.

`services/publication/readiness.js` takes an explicitly supplied native Db; import
does not connect or perform I/O. It emits only fixed boolean checks, never index
names, namespaces, record data, credentials or raw driver errors. Three sequential
listIndexes commands use maxTimeMS 2000 and batchSize 16. An open cursor, oversized
batch, missing namespace or privilege/transport failure aborts. There are no find,
aggregate, create, syncIndexes, repair, update, migration or index-drop operations.

Required simple, visible, completed, nonpartial/nonsparse/non-TTL indexes:

| Collection | Exact key order | Unique |
| --- | --- | --- |
| mazes | date:1 | yes |
| mazes | publicationEra:1,date:1,publishedAt:1 | no |
| users | email:1 | yes |
| rewarditems | id:1 | yes |

Index names may differ; key/options are authoritative. Extra unrelated indexes
are not removed or certified. Production no longer relies on implicit Mongoose
index creation after import/connection. Existing connection reuse, URI binding
and pool behavior are retained; this work does not guess new production timeouts
or pool sizes. Fixture connections use short local budgets and are not a live
tuning recommendation. Monitor connection totals/checkouts, command latency and
available memory during an authorized release before tuning any pool.

Before live inspection, owner must separately approve target identity, exact
collections/date scope, read-only credentials, reviewed code SHA and a low-load
window. Reuse the established read-only-principal discipline in
`docs/release/schema-assessment.md`; do not run the broader player-history audit
as a substitute for this narrow release question. Do not obtain/print a production
URI in this task. Given an already authorized connection, the read-only call is:

```js
const { readIndexReadiness } = await import('./services/publication/readiness.js');
const report = await readIndexReadiness(approvedDb); // separately authorized Db
// Retain only the fixed-schema boolean report for private release review.
```

This is **index readiness only**, not approval, topology certification, a full
schema audit or proof that grids were published. Also inspect authorized collection
metadata/validators/default collation and compatibility of optional new fields.
Review index build cost, existing duplicate/invalid values and resource headroom
without auto-repair. Any DDL/data repair needs a separate explicit write approval
and rollback plan. Startup blocks rather than creating missing indexes. No such
inspection or provisioning was done against Atlas here.

## Coordinated deployment decision sequence

1. Independently QA this exact server PR head and accepted API contracts. No merge
   or deployment follows automatically from passing tests.
2. Obtain owner-authorized positive legacy release evidence and narrow read-only
   grid observations. Populate/review the artifact as described in `config/README.md`.
   Never infer publication from row existence, 2025 season bounds, seed labels,
   progress or test-player rewards. With no evidence, retain the old live server
   until the owner explicitly approves an alternative.
3. Separately authorize schema/index metadata review. Complete any independently
   approved index provisioning before deploying; preserve the prior image and
   approved artifact/digest for rollback. Rehearse on disposable fixtures.
4. Owner authorizes a pinned server image deployment with auto-update still OFF.
   Revalidate actual target identity, running image, health and configuration at
   that time. Code/main SHA alone is not an activation signal. No publisher or v2
   switch accompanies the release.
5. Verify the API before any client merge: archive metadata, approved legacy grid
   hashes, ordinary login/profile/start, one completion and original UUID recovery,
   daily legacy scores, missing/future rejection with zero extra attempts, private
   progress/cache headers. Owner separately approves any production smoke writes
   and their exact scope; synthetic smoke is the default rehearsal. Confirm no
   historical grid changed and no new publisher ran.
6. Keep client #54 draft/unmerged while API readiness is unproven. Recheck the
   current client main and construct/test the final archive+art combined tree in
   a separately approved nonproduction workflow. Current main-only changes were
   observed under docs/art/batch-01 and batch-02; runtime blob equivalence does not
   certify an untested combined build. Re-run build, privacy/recovery, old-backend
   fallback, accessibility and integration checks on that exact tree.
7. Only after API readiness and combined-tree independent QA, owner explicitly
   approves client merge/promotion, knowing main auto-deploys. Verify actual client
   artifact/API target and game smoke. No setting is changed by this runbook.

### Rollback and stop conditions

Missing evidence/indexes, unexpected catalog denial, altered grid digest, auth or
receipt regression, leaked private status, unexpected index creation, unhealthy
image, database pressure or wrong API target -> stop the release and keep/restore
the last independently approved compatible image/artifact pair through owner GO.
Never compensate with an all-dates flag, debug unlock, reseed or row rewrite.

Prefer client presentation rollback while retaining a working compatible server
and future-date guards. If server rollback is needed after the archive client
ships, the accepted client must show unavailable/retry while preserving original
owner-bound receipt/UUID recovery; it must not fabricate dates. Pause/promote the
client as explicitly approved. The older server lacks publication guards, so its
exposure needs review rather than an unconditional rollback promise.

No database rollback is needed for this source change: it neither migrates nor
modifies existing grids, users, attempts or rewards. Do not drop additive fields
or indexes, rebuild histories, or delete publications during rollback. In-flight
attempts use their original stored UUID/start time; restarts do not reset them.

## Initial live day and future scheduling — proposal only

An approved historical inventory does not create today's puzzle. The existing
writer remains dormant and disposable-loopback-only; there is no live apply mode.
Today stays unavailable until an actual date is positively released under the
server predicate. A missing day/hole is never generated by GET/start or inferred
from the calendar. Offer a separately dated older published maze where available.

A future small operator adapter needs separate scope/code review, independent QA
and owner authorization for one exact current UTC date/algorithm/config/seed.
Use a constrained computation process, verified content/provenance and insert-only
unique-date behavior; duplicate races return the stored winner unchanged. Limit
credentials to approved read/insert authority, separate generation from DB network
access, contain whole-process memory/network egress and coordinate worker count
across instances. Sampled RSS and Node permission flags alone are not hard OS or
network isolation. Inspect/approve the exact result before any live insert; verify
the actual published record afterward without broad player-data access.

Scheduling, monitoring, alerts, late-day retry/backfill ownership and outages are
a later separate design: approved date window only, deterministic same-identity
retry, no silent alternate seed, no overwrites, no all-history backfill. Plan for
limited shared Mongo/hosting memory and connections from measured capacity; do
not assume a free-tier guarantee. Neither this proposal nor this PR activates it.

See `archive-release-validation.md` for exact local evidence and limitations.
