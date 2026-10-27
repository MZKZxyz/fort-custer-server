# Count-only legacy schema assessment — preparation only

Issue [#12](https://github.com/MZKZxyz/fort-custer-server/issues/12) prepares this procedure;
it does **not** authorize executing it against production, obtaining a production URI,
or creating/changing any production principal. No production data informed its tests.

The reviewed implementation is `tools/release/schema-assessment.mjs`. It exports
`assessSchema(db, approval)` and pure aggregation plans. It has no executable CLI,
connection-string handling, environment-variable lookup, connection creation, Mongoose
models, file output, logger, repair path, index provisioning or seeding. Importing it
performs no I/O. The production entrypoint never imports it.

## Owner approval and operator prerequisites

Before any live execution, obtain a **separate explicit authorization** identifying:

1. The approved infrastructure/database identity, a dedicated Fort Custer application
   database, the audit code's full reviewed SHA, operator and short low-load window.
   Inspect the connection target privately through the normal owner-controlled channel.
   A matching database name alone does not prove server identity or tenant isolation.
   Issue #12's metadata-only note identifies an application-shaped database named
   `test`; this is allowed **only if explicitly approved as the dedicated application
   database**, never selected implicitly. That note does not prove the Railway target
   or authorize data reads. `admin`, `local` and `config` remain refused.
2. An existing, reviewed, authenticated **read-only** principal scoped only to that
   database. Do not reuse `MONGO_URI`, the app's write-capable credentials, a root/admin
   role or an unauthenticated connection. The owner must verify that authorization is
   enforced by the server and that no role changes occur during the window. This task
   does not provision roles or fetch credentials.
3. An exact reviewed inventory of collections, obtained through authorized metadata
   inspection. It must include `users`, `mazes`, `rewarditems` and only the known
   `fc_v2_*` collections listed by `SHARED_COLLECTIONS` if present. Missing collections,
   extra tenant/system/unknown collections, views and time-series collections abort the
   assessment. Do not drop, create, rename or omit collections to satisfy this guard.
4. Privately verify an existing backup/recovery owner and usable recovery point through
   the approved process. Do not export or copy user records for this assessment.

Use the pinned native MongoDB driver already supplied by the repository (available via
`mongoose.mongo.MongoClient`, without using any Mongoose models). This implementation
was exercised on authenticated MongoDB **8.0.16**, including a genuine `read` principal
on a disposable replica set. It permits MongoDB 8.0.x, primary replica-set members and
standalone servers; sharded/load-balanced/non-primary/other-version deployments stop
for separate review. A known supported standalone metadata response is covered by a
unit test; the live authenticated integration fixture uses a replica set.

The operator supplies a privately established native `Db` and its owning client. Set
`serverSelectionTimeoutMS:5000`, `connectTimeoutMS:5000`, `socketTimeoutMS:15000`,
`retryReads:false`, primary read preference and normal verified TLS for a remote
connection. Never put the URI/password in shell arguments, committed files, output,
process tracing or this issue. Do not enable driver command monitoring, verbose errors,
REPL history or credential/query logging. Do not run a generic `find`, preview records,
or dump `connectionStatus`, `hello`, `buildInfo` or collection metadata to public logs.

`connectionStatus` must disclose exactly one authenticated user and the effective
privileges, including inherited grants. The guard accepts only reviewed read actions
on this exact database, with no cluster/any-resource/other-database/write/admin grants.
MongoDB 8's built-in `read` also grants read-only `system.js` privileges; that permission
is accepted, but **an actual `system.js` collection is still outside the allowed
inventory**. Unsupported custom privileges or unavailable introspection abort; do not
weaken the guard to make an existing write-capable app credential work.

## Authorized invocation shape — not a connection recipe

Only after the preceding approval, an operator can invoke the reviewed library from
the approved private session. `approvedDb`, `approvedClient`, `approvedDatabaseName`
and `reviewedCollectionNames` below are already established in memory through the
owner's normal connection procedure. They are not environment variables or defaults.
There is deliberately no executable production connection example in this repository.

```js
const { assessSchema } = await import('./tools/release/schema-assessment.mjs');
try {
  const report = await assessSchema(approvedDb, {
    databaseName: approvedDatabaseName,
    collectionNames: reviewedCollectionNames,
    dedicatedDatabaseConfirmed: true,
  });
  // Only this fixed-schema count/metadata object may be retained for private review.
  // Do not print the Db, client, approval, driver errors or any raw server responses.
  console.log(JSON.stringify(report));
} catch {
  console.error('AUDIT_INCOMPLETE');
  process.exitCode = 1;
} finally {
  await approvedClient.close();
}
```

The library checks effective privileges and exact collection inventory before reading
application data, and rechecks both before returning. Every command has `maxTimeMS:10000`.
Every aggregation uses primary/majority reads, `allowDiskUse:false` and a bounded cursor
batch containing at most one final count row. It never falls back to local reads,
sampling, a broader namespace or an unsupported topology. Metadata batches are bounded;
unexpected cursor continuation is refused rather than fetching arbitrary rows. The
operator closes the client even on failure, disposing any refused cursor.

Eight fixed aggregation plans plus up to eighteen shared-collection counts run
**sequentially**, not concurrently with another audit. These are separate majority
reads, **not one atomic cross-collection snapshot**. Schedule a stable window, with no
writer cutover, catalog maintenance or schema changes. Data races can still change
counts during/after the audit; do not treat the final metadata rechecks as a write
fence. A separate just-in-time adoption/shared-state recheck under the same authorized
procedure is required before any eventual release. If load, scope or timing makes the
evidence ambiguous, stop, retain HOLD and seek review rather than increasing limits.

## Interpretation and privacy contract

Successful output contains only fixed labels, nonnegative safe-integer counts,
`complete:true`, a fixed disposition, Mongo version numbers, one topology enum and
read-consistency metadata. No database/host/set/principal names, identities, user or
profile IDs, hashes, inventory keys/items/contents, saved response bodies, catalog rows,
timestamps from players or credentials leave MongoDB. Count aggregation group keys
stay server-side; even duplicate catalog IDs are reduced to counts before returning.

| Group | Assessment / interpretation |
| --- | --- |
| `users` | Raw BSON `__v` missing/null/int/long/double/decimal/string/other distribution, invalid nonnegative safe integers, missing/malformed profile arrays, sentinel in a non-array profile container. No Mongoose casting or initialization. Missing/non-numeric/negative/fractional/non-finite/unsafe versions require review; numeric strings are never silently repaired. |
| `profiles` | Malformed profile elements, any sentinel (including null or unknown values), missing versus malformed attempts/progress/rewards maps. Missing maps are legitimate defaults, not automatically corruption. |
| `inventory` | Entry count, unsafe map keys, invalid raw quantities, zero/multiple quantities, numeric-string variants. Nonnegative integer zero and multiples are legitimate. Retired items are not compared with the catalog or classified as corrupt. Numeric strings are reported, not coerced. |
| `attemptDates`, `attempts` | Invalid calendar keys, non-array date buckets, malformed elements, UUID versus absent/invalid IDs, active ID-less attempts, historical completed attempts without snapshots, saved object snapshots, malformed snapshot/start/completed types, future starts. ID-less and completed-without-snapshot are valid historical categories. Stored snapshot contents, official timing/provenance and historical reward attribution are not reconstructed or certified. |
| `progress` | Entry count, invalid calendar keys and non-object entries; legacy time strings remain untouched. This is not a best-time migration or ranking audit. |
| `catalog`, `catalogDuplicates` | Raw ID types, unsafe string IDs, missing/null IDs, legacy display-field variants and duplicate string/cast-equivalent IDs (numeric `42` versus string `"42"`, for example). V1 historically accepts numeric IDs and minimal catalog rows; these need disposition rather than silent normalization or v2 validation. No comparison with a hard-coded 112-item count or `data/rewards.js`. |
| `sharedWriter` | Number of known collections present, nonempty collections and total documents, without contents or individual collection names. Empty collections do not prove a prior activation is safe. |

Counters can overlap and are not all partitions. `users.total` counts users,
`profiles.total` counts raw array elements, date buckets and attempt rows have their
own totals. Malformed parents are counted explicitly before sanitized unwinds; a
malformed parent does not vanish merely because it has no traversable entries.

`HARD_NO_GO` means any adoption sentinel or shared-writer document was seen: stop this
legacy refresh **and rollback to old code**. Otherwise the output is always
`OWNER_REVIEW_REQUIRED`, never PASS/GO. Every malformed or ambiguous category needs
explicit disposition; an empty database/catalog or missing maps is not proof that
production players are compatible. The report must be complete and representative of
the approved dedicated database, with an operator-attested stable scan window.

Failures emit only fixed codes (`AUDIT_SCOPE_REFUSED`,
`AUDIT_READ_ONLY_PRIVILEGES_REQUIRED`, `AUDIT_TIMEOUT_CONFIGURATION_REQUIRED`,
`AUDIT_TOPOLOGY_UNREVIEWED`, `AUDIT_COUNT_SHAPE_REFUSED`, or `AUDIT_INCOMPLETE`). They
throw before any report is returned, so timeout/auth/privilege/scope/cursor/shape errors
cannot produce a partial successful audit. Do not publish raw exceptions to diagnose
them. The operator wrapper above intentionally reports only `AUDIT_INCOMPLETE`.

Counts may themselves disclose small populations. Keep the full count report private
for the owner; publish only approved, coarsened/suppressed summaries and release
disposition on the issue. Do not attach raw documents, per-user counts, count-derived
identifiers, intermediate aggregations or credentials. No changes to records,
`User.__v`, sentinel fields, inventory, saved results or grants are part of this work.

## Local synthetic verification

```sh
npm ci
env -u MONGO_URI -u MONGODB_URI -u MONGO_URL -u DATABASE_URL \
  MONGOD_BINARY=/absolute/path/to/mongod NODE_ENV=test \
  node --test test/ci-isolation.test.mjs test/schema-assessment.test.mjs
```

The tests own dynamic loopback ports, temporary MongoDB 8.0.16 dbpaths and synthetic
authentication only. They check actual read permissions/write denial, raw BSON and
legacy/malformed fixtures, unchanged stored data, count-only output, private error
redaction, scoped metadata, bounded aggregation, no export/write stages, and refusal of
write-capable principals, views, unknown scope, timeouts and schema ambiguity. Production
credentials or data must never be passed to these tests.
