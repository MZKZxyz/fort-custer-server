# Sprint 1.7E nonproduction validation

Starting server SHA: `1f668d23477aa62557bd531e501ce5f6771bdd0c`.
The initial workspace had the previous engineering head; fetched main matched
the required squash merge and the new branch started there before editing.
Read issue #19 in full, parent #6 and accepted server/client archive contracts,
including the server RSS-monitor re-QA and client owner-bound recovery re-QA.

**Engineering result:** the compatibility implementation is ready for independent
source QA. **Release result: HOLD**, with no real legacy evidence/approval,
production metadata inspection, deployed API smoke, final combined client build
or owner deployment decision. Synthetic approval is never copied to live config.

## Observed test results

Node v24.19.0; Mongoose 8.14.1 / MongoDB driver 6.16.0; disposable MongoDB 8.0.16.
All server tests unset MONGO_URI, MONGODB_URI, MONGO_URL and DATABASE_URL. The
provisioned local MONGOD_BINARY was supplied to the invocation, without recording
its machine-specific location. Only the test child receives its owned loopback URI
over IPC; it refuses any other connection target.

| Check | Observed result |
| --- | --- |
| Final full server discovery | **516 passed**, zero failed/cancelled/skipped/todo; **66839.746621 ms** |
| Focused release suite | **11 passed**, zero failed/skipped; **5473.910614 ms** |
| Accepted client Jest at pinned archive head | **229 passed / 17 suites**, zero failures/skips; **10.573 s** |
| Frozen server session contract | FROZEN_CONTRACT_MATCH; only the default maze-router import hash changed |
| JS/MJS syntax, whitespace and protected-source comparisons | Exit 0 |
| Real production evidence/data/deployment checks | **Not performed or authorized** |

An earlier full server run also passed 516/516 before adding the future-approval
and post-smoke DDL assertions; the final results above include both assertions.
The first focused run passed 11/11. Client dependency installation initially
failed because the default npm cache was unavailable; rerunning npm ci with an
owned temporary cache succeeded. No test was removed, skipped or weakened.

Reproduce from server repository root, with the local test binary selected in the
invoking environment:

```sh
env -u MONGO_URI -u MONGODB_URI -u MONGO_URL -u DATABASE_URL npm run test:release
env -u MONGO_URI -u MONGODB_URI -u MONGO_URL -u DATABASE_URL npm test
node tools/integration/freeze-contract.mjs --check
git ls-files -z '*.js' '*.mjs' | xargs -0 -n1 node --check
git diff --check
```

The fixed manifest is empty/unapproved; a standalone `npm start` is intentionally
blocked. Tests use isolated app copies with **synthetic** manifests and the real
index.js/default production routers, not injected router factories. The test
bootstrap adds only loopback driver budgets/command observation and captures the
actual listener; it verifies startup passed autoIndex:false/autoCreate:false.
Existing fixture provisioning is explicit and separate from application startup.

## Focused evidence

- Default empty, absent, invalid JSON, unapproved populated and future-approved
  artifacts refuse actual entrypoint startup with **zero database connections**.
  Pure validation additionally covers unknown versions/keys, stale digests,
  duplicate/invalid dates, missing evidence, malformed timestamps, prototypes,
  symbols, non-enumerable keys and overlong inventories.
- Approval is tied to a versioned canonical content hash. Object property order
  does not change that digest; mutating parsed input cannot change the loaded
  policy. Replacing the file in a running app does not hot-reload access, and a
  restart with the replaced unapproved file refuses before connection.
- The same default runtime policy authorizes archive/start/daily for one positive
  synthetic legacy date, hides an existing unknown date, and hides a matching
  date whose stored grid hash differs. No season-range or existence inference.
- Registration/login/profile/start uses the original v1 request shape. Start
  returns the original grid/seed and exact response keys; completing and three
  repeated UUID retries return the same receipt with one attempt and one award.
  Daily returns the original legacy array shape and owner archive progress is true.
- Rejected unknown/future requests leave the user document byte-equivalent. Maze
  documents are byte-equivalent before/after old-client smoke. A saved receipt
  still recovers when catalog eligibility is lost, without a new award/write.
- Before a synthetic current-day publication, Today is unavailable; inserting
  one explicit valid fixture makes that actual date visible on read. No hole or
  automatic row is fabricated. This does not publish a real day.
- An actual dropped compound index causes read-only preflight and actual startup
  to fail. The database index set and stored grids remain unchanged. Command
  monitoring observes **zero create/createIndexes/drop/dropIndexes/collMod**
  commands at startup and after the full HTTP smoke.
- Index unit checks reject sparse, partial, hidden, building, TTL, wrong-order,
  nonunique or incompatible-collation metadata. Preflight emits only three bounded
  listIndexes commands and fixed booleans; open/oversized cursors and private
  driver errors fail with a sanitized code. No raw record or index-name leakage.
- A synthetic older Express server returns its actual HTML 404 for archive.
  The pinned new-client catalog logic classifies it unavailable, rejects it as
  catalog data and does not mark it fresh. It cannot fabricate a playable date.

## Client contract provenance and limits

The accepted client snapshot was fetched read-only and tested at
`2c6dc171e6c7786ef5469009f593f9fa48a952e5`. Fresh full Jest includes the actual
archive tests for HTML-404/503 unavailable states without Play, original-result
recovery without catalog, identity-bound receipts and selected-date score errors.
The snapshot's tracked source remains unchanged; no rebase/merge was performed.

```sh
# In an isolated checkout of that exact client head; use an owned npm cache.
npm ci --cache <temporary-cache-directory> --no-audit --no-fund
CI=true npm test -- --watchAll=false --runInBand
```

Server-side protocol tests also use two pinned pure client modules, with one
extension-only import adaptation and Git blob checks; provenance is documented in
`tools/test-support/archive-client/README.md`. This keeps server tests offline and
does not add client dependencies. Old-client HTTP shapes follow the last approved
MazePage/ResultsPage contract; a real old browser was not driven in this task.

Fetched client origin/main matched `afece64170a46d01c0c4123f4ffd9084d4f671db`.
Main-only changes from the archive merge base were confined to docs/art/batch-01
and batch-02. The old MazePage blob remains unchanged there. **No final combined
archive+art build or browser certification is claimed**. Previously accepted
browser QA is background evidence, not a new run by this task. Actual deployment
status, physical-device/screen-reader coverage and final client promotion remain
independent release gates.

## Scope verification and remaining owner decisions

Protected comparisons against the required base show no changes to models, approved
generator/fixtures, completion/collectible services, v2 services/activation blocker,
worker/monitor/writer, seeders, dependency lockfile or CI/deployment configuration.
The frozen integration JSON refresh changes one source hash, with no protocol
examples changed. No historical grid or player-history migration is added.

The entrypoint no longer implicitly creates collections/indexes. This is a
deliberate startup compatibility change: missing/unreviewed readiness blocks HTTP
listen, rather than relying on an implicit index build. Existing connection
bindings and pool behavior are retained. Metadata readiness is not a data/schema
audit or release authorization; collection validators/topology/capacity remain
unknown until separately approved inspection.

The [decision package](archive-release-readiness.md) specifies positive evidence
collection/approval, schema/index preflight, server-first rollout, old-client smoke,
final client combined-tree QA, owner merge/promotion and reversible rollback. With
no real legacy inventory, retain the live server until explicit owner approval of
an alternative. Today needs a separately approved actual publication; the dormant
disposable-only writer and scheduler status are unchanged.

No production Atlas read/write, live publishing, merge, deployment, settings change,
legacy seeder, player-history reconstruction, v2 activation or GitHub CI polling
occurred. Stop for independent QA and the owner's separate release decisions.
