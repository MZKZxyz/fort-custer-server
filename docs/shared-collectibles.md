# Compatible v1/v2 collectible settlement (Sprints 1.4C and 1.4F)

Continuation of draft PR #8 at independently reviewed
`d59738d587f82c27a3028bb98930fef6c59d9544`. Authority: issue #7 handoff
6427656955 and PR #8 independent QA report 6427591341; D2/D5/D6 remain approved.
The new-profile condition from QA is addressed by trusted lifecycle provenance.
The production startup interlock is unchanged: this code is not activation,
migration, deployment or release approval.

Sprint 1.4F corrects the two P2 stored-data validation defects independently
reported at `8f6f9a5c80a1422bcea3c72c8dfa938037e88163` in PR #8 comment
6428507575, following issue #7 handoff 6428582042. The earlier 51/51 and 378/378
results did not demonstrate malformed catalog/inventory rejection. That QA gate
remains FAIL until independent targeted revalidation of this correction; author
results below do not change the independent verdict.

## One integrated source path, no separate grant switch

`services/collectibles/bundle.js` assembles the real compatible registration/profile
lifecycle, v1 maze router, v2 playable router, legacy completion adapter and shared
reward service against the same repository and writer epoch. It is explicit review/
test assembly. The production entrypoint still uses disabled/default routes and
rejects attempted v2 activation before database connection. There is no environment
flag enabling an independent payout worker beside an unchanged v1 writer.

Default router exports keep their prior behavior for never-adopted profiles: no
new lifecycle provenance or date-ledger writes, no changed per-attempt selection,
no automatic collections/provisioning and no migration. The User schema adds one
optional writer sentinel with **no default**. Compatible creation/acceptance sets
it transactionally. Once a profile adopts the shared writer, the default legacy
writer refuses new starts/unsaved completions rather than silently falling back
to per-attempt awards. Saved snapshots remain readable, including without a valid
User version. This is intentional rollback protection, not a legacy backfill.

## Acceptance and atomic settlement

Both `legacy-compat-v1` and accepted `route-replay-v1` call the same `SharedRewards`
service inside their completion transaction. Timing/leaderboard position has no
effect on eligibility. A legal accepted untimed v2 result receives the same date
opportunity. Pending, malformed, rejected, too-fast legacy or unowned submissions
do not grant. Each profile/maze-date has one ledger and one immutable grant ID.

The transaction includes:

1. Active certified writer-epoch fence and User/profile version/ownership fence.
2. Trusted date eligibility, accepted-date progress and first accepted claim.
3. Uniform selection from the current **unowned** catalog, bounded inventory update
   and adopted-writer sentinel; existing quantities/retired IDs are preserved.
4. Immutable `awarded` or `exhausted` grant with frozen catalog snapshot and selection
   policy `uniform-unowned-v1`; ledger becomes consumed/exhausted permanently.
5. Original claim event marked settled and one delivery event recorded.
6. Source receipt, v1 embedded attempt/progress or v2 session/intent/key/slot/result
   completion, plus the source receipt outbox event.

Any failure before commit rolls these final effects back together. Earlier durable
completion intake/clock admission can remain and is recovered, not silently erased.
Unknown commit retries only commit before returning COMMIT_UNKNOWN. Majority reads
precede survival claims in failure tests; an empty/local read is never abort proof.
The writer-epoch revision participates in every shared grant/lifecycle transaction,
so pausing the epoch fences older transactions. User OCC also prevents stale profile
saves/deletes from discarding inventory or committing after ownership disappears.
The existing eight-attempt transaction budget now uses a 5–100ms bounded backoff
between transient/unique-conflict retries; sibling contention must not burn the
whole budget while the winner is still releasing its locks.

No rarity weighting has been introduced. Production selection uses crypto.randomInt
uniformly among unowned item IDs, preserving the existing equal-probability policy.
Sorting only stabilizes candidate order; it does not change probabilities. Tests
inject deterministic index selection to force collisions. Max catalog/inventory
keys are 4096; each catalog snapshot is capped at 64KiB. Invalid/oversized data fails
closed for review, without normalizing inventory or consuming an opportunity.

## Stored-data validation before a new settlement

Every stored catalog candidate is checked before selection or exhaustion,
including already-owned and unselected rows. Raw string/number types are checked
before hydration so casting cannot conceal malformed imports. The actual
`RewardItem` schema then validates required fields and category/rarity enums.
Present numeric schema fields must be finite numbers; missing optional
`marketValue` still defaults to zero in the frozen snapshot. Finite fractional
market values remain supported by the existing Number schema. The ID grammar,
uniqueness, 4096-item bound and 64KiB record bound remain unchanged. An invalid
record returns `CATALOG_REVIEW_REQUIRED` / 503, never a partial reward snapshot.
This path neither saves defaults back to the catalog nor edits historical grants.

Inventory is inspected from the native stored User record, not a hydrated map.
Missing inventory retains the model's empty-map default; explicit null, arrays,
strings and other non-map containers are rejected. Each quantity must be a native
number representing a nonnegative safe integer (0 through Number.MAX_SAFE_INTEGER).
Numeric strings, objects/arrays, booleans, null, nonfinite, negative, fractional
and unsafe values return `INVENTORY_REVIEW_REQUIRED` / 503 without normalization.
Valid multiples and retired entries remain byte-for-value unchanged. Zero-valued
entries remain owned by key presence, preserving the original selection rule.
Historical safe map keys, including spaces/Unicode, are retained; they need not
match today's narrower catalog-ID grammar. Empty keys, dollar-prefixed keys,
dots, NUL and reserved prototype properties are refused as unsafe update/map keys.

Validation runs inside the existing completion/claim/grant transaction and before
new inventory, award or exhaustion effects. A rejection rolls back date history
created for this attempt, accepted-date progress, claim, grant, embedded source
completion or v2 result and all final outbox effects. Pending durable intake is
allowed to remain. Once the synthetic stored data is corrected, retrying the same
attempt/key uses its original intake receipt/generation and settles once. Saved
terminal receipts/grants bypass new selection/validation and remain immutable,
even if the current catalog later becomes malformed. This correction does not
retroactively repair invalid awards committed by the earlier implementation.

## Receipt and exhaustion semantics

V1 keeps its existing fields, timing formula, three-second floor, date/UUID selector,
ID-less latest-attempt compatibility and latest-progress/leaderboard behavior.
Every saved response is immutable. The compatible adapter persists an initial
server receipt in `legacyIntents`, then commits embedded result, shared award and
`legacyReceipts` together. UUID and ID-less requests selecting the **same** attempt
use one canonical intent. Truly ID-less records use their pinned index/start.
The inherent ambiguity of a new ID-less HTTP request after a later start remains;
it cannot create a second date opportunity.

All accepted attempts for the same date recover the same frozen reward-or-null
outcome; later attempts may have their own timing but never increment inventory
again. In v1 the reward field can therefore display the original item again; it
does **not** mean another inventory credit. V2 returns a versioned opportunity ID,
terminal status and allowlisted reward fields without catalog database metadata.
Inventory and immutable grant records are authoritative. Historical v1 responses
from before adoption replay untouched and are never used to guess date history.

Exhaustion stores null reward, terminal exhausted ledger and `collectionComplete:
true`. No substitute is generated. Later catalog expansion cannot reopen that
date or remove its permanent exhaustion/completion distinction. Another eligible
date can still use a genuinely new unowned item. Reviewed historical awarded/
exhausted dates remain used without re-awarding; unknown dates remain under review.

The legacy resolver checks saved receipts/embedded snapshots first; otherwise it
CAS-writes the intent and User fence to prove abort. Only then can a new generation
capture a fresh receipt. No raw player timestamp, proof flag or grant assertion is
accepted. Clock anomalies and recovery for v2 retain the independently verified
admitted-check design.

## Positive provenance for new players and genuinely new dates

A missing date-history row is still **not** known-clear evidence. Eligibility can
be established only by explicit reviewed date history or positive compatible proof:

* Compatible account/profile creation uses the actual server lifecycle. A fresh
  server-generated profile ID, writer sentinel, User save and `profileOrigins` row
  commit together. Caller IDs, inventory and provenance fields are ignored. Birth
  proof binds the certified epoch and its transaction revision, not guessed wall
  time, empty inventory or ObjectId timestamps. This makes a genuine new profile
  eligible for its first collectible, including published archives.
* Older profiles can qualify for a genuinely new date through `publishNewMaze`.
  The date must exceed an explicitly certified **legacyDateCeiling**, which must
  include old attempts/progress and prepublished future mazes, not just the current
  calendar date. The method inserts a previously absent supported grid/date and its
  `mazeOrigins` proof atomically. It refuses existing or pre-ceiling dates. A date
  being later than cutover, or an unmarked maze being present, is insufficient.
* Existing explicit unknown/awarded/exhausted review evidence takes precedence.
  Missing/untrusted birth/epoch proof stays held. Safe retired epochs preserve
  earlier certified birth/publication proof through compatible transitions.
* Siblings have separate profile identities and date/inventory opportunities.
  Deletion/recreation generates a new server ID; old origins/grants/ledger
  tombstones are retained. No history or inventory is rewritten or compensated.

`writerEpochs` requires an active `shared-date-v1` certificate with reviewed evidence,
cutover timestamp, audited legacy date ceiling and revision. Tests seed synthetic
certificates only. No certificate provisioning command, migration or production
audit was run. **A database row cannot prove that all deployed writers were drained.**
Actual writer inventory, evidence certification and external access controls remain
operator/release prerequisites. Never mint proof for imported existing profiles or
retroactively mark old dates clear by absence; review/compensation needs authorization.

## Delivery and recovery

Payout is synchronous with acceptance, not an eventually rerolling grant worker.
`date-grant-requested` is marked settled in that same transaction. A separate
`date-grant-settled` outbox notification is acknowledged through a transactionally
deduplicated `deliveries` receipt for the supported consumer. Acknowledgment checks
the terminal grant and ledger revision. It performs no selection/inventory write
and sends no external messages. Duplicate or post-crash acknowledgments return the
same receipt; a stale unacknowledged event fails closed. Actual client notification/
transport integration remains separate.

The additional explicit `fc_v2_*` collections are writerEpochs, profileOrigins,
mazeOrigins, grants, deliveries, legacyIntents and legacyReceipts. Unique indexes
cover profile provenance, date publication, profile/date grants and event/consumer
delivery. Provisioning remains explicit and is never invoked by disabled startup.

## All-writer inventory and cutover/rollback requirements

| Source | Implemented source behavior / remaining operation |
| --- | --- |
| v1 UUID and ID-less completion | Compatible router selects the new adapter and common atomic grant; default legacy writer is unchanged for unadopted profiles and refuses adopted ones |
| v2 completion | Compatible bundle injects the same grant service; standalone disabled slice remains an unpaid regression/reference assembly, not a release alternative |
| Registration/profile creation | Compatible lifecycle atomically mints new-profile proof; default creation mints no provenance |
| Profile edit/delete, legacy start | Existing version-checked User saves contend with inventory fences; deletion preserves private tombstones; no safe downgrade to old artifacts is implied |
| Legacy progress endpoint | Still read-only; cannot manufacture accepted completion/grant |
| Maze publication/generator | New positive publisher is provided; existing legacy upsert script never mints known-clear proof and must be replaced/gated at cutover |
| Catalog | Existing uniform policy and catalog schema retained; destructive reward seeder unchanged and never run. Separately reviewed non-destructive tooling required |
| Delivery | Deduplicated internal acknowledgment, no second inventory writer or external transport |
| Admin/maintenance/import/older deployed workers | Not inventoried from live systems; require authorized enumeration, drain, provenance evidence and compatible version/OCC enforcement before release |

Before any activation: gate starts/affected writes upstream; drain in-flight
mutations; stop and verify all unchanged per-attempt writers/replicas/jobs; approve
backups/evidence and certificate coverage; provision/reconcile only under separate
authorization; deploy only compatible bundle/artifact; verify staging and rollback
before reopening. A rolling health check is not proof of no old writers.

Rollback after compatible writes retains shared completion/result/grant recovery,
keys, origins and tombstones. Keep unsafe writes closed if only an old artifact is
available. Do not reset versions, unmark adoption, restore a stale whole database,
remove inventory, erase snapshots or rerun seeders to undo code. The sentinel helps
the current default writer fail closed; it cannot stop an older deployed binary
or raw external database writer. This is why the startup interlock remains intact.

## Evidence and remaining QA

Dedicated suite: `test/shared-collectibles.test.js`. Full automatic `npm test`
retains the 327 previously accepted regressions, including the 82 feasibility cases
and 84 runtime/replay cases. All DB execution uses disposable MongoDB 8.0.16
single-member replica sets, owned loopback ports and fresh temporary directories,
ignoring an unusable environment MONGO_URI. No persistent/production service is used.
Privacy-filtered evidence is in `collectibles-runtime-results.json` and
`collectibles-regression-results.json`; test identifiers use schema 2 digests.

Final 1.4F author results: **77/77 shared collectible tests PASS**, **404/404 complete
repository tests PASS**, zero failures/skips/todo. All JS/MJS syntax and whitespace
checks pass; the RFC replay remains byte-identical. All original 378 tests are
retained; 26 validation/recovery tests are added. The bounded contention retry
budget and backoff from 1.4C remain unchanged.
The startup interlock/entrypoint, manifests, CI, middleware and seed/generator
scripts remain byte-unchanged from the starting runtime SHA. These results are
implementation evidence, not independent QA or release certification.

The suite exercises real authenticated compatible v1/v2 routes, both controlled
winner orders, two independent application processes, same/different dates and
sibling contention, trusted/unknown legacy provenance, lifecycle rollback,
deletion/recreation, retired epoch transition and pause fencing, original UUID/
ID-less snapshots, exhaustion/catalog expansion, uniform unowned selection,
quantity/retired-ID preservation, transient version conflicts, commit uncertainty,
stepdown, rollback at logical grant writes, application SIGKILL/MongoDB restart,
and delivery loss/duplicate/stale acknowledgments. Syntax, whitespace and byte-exact
RFC replay checks are also required.

The new tests first reproduced four HTTP 200 counterexamples before the fix:
QA's incomplete catalog record on both v1/v2 and nested invalid inventory on both
v1/v2 (including QA's original three cases). The corrected real authenticated
paths return the named 503 errors and assert raw inventory/profile/version/catalog
preservation, no accepted source result/final outbox/date claim, and pending intake.
Tests cover each required field, enums, types, nonfinite prices, unsafe IDs, owned/
unselected invalid candidates, quantity ranges, unsafe keys/containers and valid
defaults. Corrected data permits same-operation retry with original receipt and
generation. The four exact counterexamples then verify MongoDB SIGKILL/restart,
a fresh application process, immutable replay and later cross-version same-date
completion without duplication. Empty-catalog rejection/repair also verifies
permanent exhaustion through restart and expansion. These are synthetic repair
fixtures, not operator repair tooling or live data reconciliation.

Reproduce with Node 24 and MongoDB 8.0.16 (set MONGOD_BINARY to the executable):

```sh
MONGO_URI=mongodb://127.0.0.1:1/do-not-use node --test test/shared-collectibles.test.js
MONGO_URI=mongodb://127.0.0.1:1/do-not-use npm test
git ls-files -z '*.js' '*.mjs' | xargs -0 -n1 node --check
node docs/rfcs/fc-sys-01/replay.mjs | cmp - docs/rfcs/fc-sys-01/replay-output.json
git diff --check
```

Request narrowly scoped independent QA at the published correction SHA: revalidate
these two P2s, raw rollback, repair/same-operation retry, restart/immutable receipt,
legacy default/retired-quantity compatibility and exhaustion. Re-run dedicated and
full regressions and verify the unchanged activation safeguards. Existing RFC,
movement and provenance design are not reopened by this correction.

Still **UNVERIFIED / not release-approved**: multi-member failures/partitions and
physical durability; production capacity/catalog sizes and external writer/drain
inventory; approved historical reconciliation/certificate issuance; full
adjudication/invalidation/appeal audit and compensation; actual notification
transport; monitored clock/authorized hold repair; client recorder/help/recovery/
accessibility; public projection/cursor/privacy; retention/deletion/backups and
operator cutover/rollback rehearsal. Later invalidation must use an auditable
resolution; no silent removal or duplicate opportunity is implemented here.
Issue #7 remains open, PR #8 remains draft, all activation safeguards remain intact.
