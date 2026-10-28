# Sprint 1.7G engineering validation and independent QA handoff

The original head below failed independent QA for its weekly/all-time historical
ranking exception. The [same-PR remediation report](leaderboard-remediation.md)
supersedes that exception and records the correction/re-QA target. Prior counts
remain historical evidence, not acceptance of the failed head.

Scope: server issue #22, parent #6, fresh-only cutover. Required starting SHA
`5a6c9ea5fbd90195df0e08d55e552d2d9359d7fb` exactly matched fetched main before
branch creation. Read the complete issue and parent discussion, existing generator,
worker, publication predicates/writer/catalog, real router composition, Maze model,
prior release evidence and accepted client contract/source. No production data or
platform configuration was accessed. See [cutover/runbook](fresh-archive-cutover.md).

**Result: source ready for independent QA; release HOLD.** This is engineering
validation, not an independent verdict. QA must pin the final draft-PR head SHA;
the PR body and handoff supply that exact commit. No live launch artifact, launch
date, operator authorization, real publication, deployed API or scheduler exists
as a result of this work.

## Final evidence

Environment: Node **24.19.0**, MongoDB **8.0.16**, Chromium **154.0.8037.57**.
All server/database/browser smoke invocations unset MONGO_URI, MONGODB_URI,
MONGO_URL, DATABASE_URL; MONGOD_BINARY selects the local disposable binary only.
Every MongoDB fixture uses newly created loopback state and removes its own state.
No legacy seeder, migration, historical reconstruction or external database runs.

| Check | Result |
| --- | --- |
| Full server automatic test discovery (`npm test`) | 527 passed, zero failed/cancelled/skipped/todo; 71247.259685ms |
| Focused `npm run test:fresh` | 22 passed, zero failed/cancelled/skipped/todo; 8232.972824ms |
| All tracked/new JS/MJS syntax (`node --check`) | 103 files passed |
| Frozen v2 contract verifier | FROZEN_CONTRACT_MATCH |
| Diff whitespace check | Passed |
| Optimized combined client unit suite | 229 passed / 17 suites, zero failures/skips; 11.648s |
| Optimized combined client build, CI=true REACT_APP_API_URL=/api | Compiled successfully |
| Combined client Chromium regression configuration | 131 passed, 28 intentionally skipped, 159 discovered; 5.1min |
| Optimized client → actual default index/app → disposable MongoDB | Passed nine checks below |

Fresh tests include:

- Real entrypoint rejects pending, absent, malformed, wrong-scope/status/identity,
  stale hash, future approval, inconsistent dates and conflicting approved legacy
  sources before connect/listen. Missing archive index refuses listen after one
  fixture connection, with zero DDL or writes.
- Synthetic approved fresh artifact boots with no admitted dates. Anonymous and
  owner archive reads reveal no old records/edges/Today. All **99** old-client
  selectable dates (2025-05-26 through 2025-09-01) reject start and daily ranking,
  with unchanged User and Maze documents. Saved original UUID receipts recover
  three times without another attempt, reward or write.
- Valid stored release-bound first grid becomes available at the exact cutover
  instant. Pre-cutover/pre-approval publishedAt, older dates, missing/wrong release
  identity/digest and altered grid hash remain excluded. Over 32 earlier modern
  prototypes cannot poison catalog edges. File replacement does not hot-unlock;
  pending on restart refuses connect/listen.
- Actual default start returns original stored grid and existing response keys;
  complete and three UUID retries return one result; daily ranking and owner
  completion work, foreign/unauthenticated projection refuses. UTC midnight makes
  the next day unavailable until actually stored; a skipped day remains a hole.
- Preview repeats identical grid/plan hashes and solver result with zero DB access.
  Omitted explicit config/version/seed, future date and invalid limits refuse.
  Separate plan approval checks scope/hash/window/expiry before DB commands.
  Regeneration detects a forged grid hash even if its plan digest was recomputed.
- Insert-only native commands bind the exact existing collection UUID, primary
  majority reads, exact date, command/write concern limits, and existing unique
  date/archive indexes. ACK loss and competing duplicate reconcile one exact
  winner; a differing markerless/prototype/seed collision stops unchanged.
  Pre-insert failure returns UNCERTAIN without write retry. Concurrent drop or
  replacement of the namespace refuses without implicitly recreating it.
- One active publication slot, missing index, wrong disposable scope and mutated
  caller inputs fail safely. The existing full suite continues resource monitor,
  timeout, RSS, concurrency, hostile input and solver/rejection regression coverage.

The optional `tools/test-support/fresh-browser.mjs` accepts an explicit local
optimized client checkout, uses its existing Playwright dependency, and creates
its own loopback MongoDB and copied synthetic approved app snapshot. It launches
**real index.js and the default production routers**, with the existing fixture
clock harness, not injected router factories. Its local proxy serves the build;
external page requests are aborted. It passed:

1. Empty fresh Today cannot start.
2. A late stored first publication becomes playable after reload.
3. Generated stored grid is traversed using canonical solver input actions.
4. Server commits completion while its HTTP response is deliberately lost.
5. Reload + explicit Retry saving recovers original UUID with one attempt.
6. Owner archive projection shows completed.
7. Published-date daily ranking returns the result.
8. Existing old test date cannot receive a new start.
9. Actual app startup and flow issue zero collection/index DDL.

Artifact byte hashes (SHA-256):

- Pending `config/fresh-release.json`:
  `b296a0a06dca2b574044ffc1ab27ba6c876580c78489c27dccc05134d9bcde02`.
- Unchanged empty `config/legacy-publications.json`:
  `897edf233259db9ff337b39e25ec9356b6b1d7e2955c7c099668e442f74264da`.
- Combined optimized `build/asset-manifest.json`:
  `8f23e25d6f07fdaa71e53a101706646bdc43f73e19dc016a8abb03d1c8726bd3`.
- Combined optimized `main.fa89226e.js`:
  `5dd8acc7238f80d96e1138bd69e7553420c38fa0d0a7f5e799f0ef0c19b5475f`.

This smoke has two synthetic Maze documents (one excluded legacy, one fresh).
It does not claim production insertion, browser certification on every platform,
OS worker isolation or live cache/header behavior. The existing client actual-API
integration harness pins an older server SHA; it was not relabeled or run against
this PR. The new fresh smoke supplies the actual-default-app cross-layer evidence.

## Exact combined client tree

Accepted archive commit: `2c6dc171e6c7786ef5469009f593f9fa48a952e5`.
Fetched art-main: `afece64170a46d01c0c4123f4ffd9084d4f671db`.
Common ancestor: `ea952aa6b1eafed45143607753210abf23f60867`.

`git merge-tree --write-tree <art-main> <archive-head>` produced a conflict-free
local combined tree **`1c62eb58eb775c5fa72c4292ea11cddd277a408d`**. Exported that
exact tree to a disposable directory and reused the client's locked dependencies.
No client branch/commit/PR was modified, pushed or merged. Client main drift was
only docs/art/batch-01 and batch-02. Full units, optimized build and the archive
browser regression configuration ran on that combined tree. The 28 existing
skips are intentional responsive/input applicability cases, not server skips.
The current tree does not imply those art reference packages are runtime assets.

The optimized build used the existing supported `REACT_APP_API_URL=/api`, aimed
only at the local test host. A production API target, deployment image and final
client tree require independent review again if either branch moves. Browser
coverage uses Chromium only; native/browser/platform release QA still applies.

## Corrections during validation

- The first publisher test assertion included its own unbounded fixture lookup;
  added that fixture's maxTimeMS. A later assertion also applied publisher-only
  majority/UUID requirements to that external fixture read; narrowed it to the
  three actual UUID-bound publication reads. The implementation limits were intact.
- The initial browser run used a local optimized build without REACT_APP_API_URL;
  the first 12 tests failed to reach mocked `/api` routes, two were interrupted,
  two passed, two skipped and 141 did not run. Stopped it, rebuilt with the actual
  supported `/api` selector and reran the complete configuration: 131 passed /
  28 skipped. No source or deployment setting change was used to fix this.
- The new real-app browser harness initially expected automatic receipt recovery
  after reload. The client requires an explicit Retry saving action. Corrected
  the harness to exercise that existing UI; its final nine checks passed.
- Additional source review found namespace drop/replacement and local-read ACK
  uncertainty risks. Added collectionUUID-bound commands and primary majority
  reads, and a namespace race regression. Final focused/full evidence includes
  these changes; no production adapter was enabled.

## Reproduction (local fixtures only)

Supply a local MongoDB 8.x binary and an explicit exported combined client tree;
paths below are caller variables, not recorded machine-specific paths.

```sh
unset MONGO_URI MONGODB_URI MONGO_URL DATABASE_URL
export MONGOD_BINARY
npm run test:fresh
npm test
node tools/integration/freeze-contract.mjs
# In the exported combined client directory:
CI=true npm test -- --watchAll=false --runInBand
CI=true REACT_APP_API_URL=/api npm run build
CI=true npx playwright test --config=docs/archive-client/playwright.config.cjs
# Back in the server checkout:
node tools/test-support/fresh-browser.mjs --client "$CLIENT_CHECKOUT"
```

The existing browser configurations expect a local Chromium installation. No
new server dependency, lockfile, CI workflow or deployment configuration changed.
The deterministic engine/solver/worker, auth, attempt/completion/collectible/v2
services, source seeders and published record bytes remain untouched. Frozen v2
JSON changed only the maze-route source hash for the default policy import;
wire examples and protocol semantics are unchanged.

## Static environment and protected source

No new production environment variable is introduced. Existing `PORT` (fallback
5000), `MONGO_URI`, and `JWT_SECRET` usage remains. `FC_SESSION_V2_ENABLED=true`
still throws from the unchanged runtime interlock before any connection/listen;
leave it unset/OFF. Fresh approval is only the fixed committed JSON path; an
environment variable cannot select another artifact or bypass pending. `.env`
loading is unchanged; fixture children disable it and inject only their owned
loopback URI and synthetic JWT key. The offline fresh preview/module does not
read MONGO_URI or instantiate a client. Connection setup is caller-owned and
strictly disposable for the insert adapter.

No secret file or process environment dump was used. No credentials or personal
identity are in added source/docs or the generic engineering commit identity.
Protected-source diff checks show no changes under lib, playable/collectible/
completion services, executor/worker, middleware, CI, lockfile or deployment
configuration. The optional model provenance fields are additive; no index
migration is included. App readiness still performs only metadata reads.

## Independent review and release gates

Independent QA should reproduce the final server suite, focus on pending/forged
artifact refusal before connect, current default routing, zero legacy edges,
cutover/time/digest binding, stored-grid integrity, 99-day old-client denial,
owner projection, old UUID recovery and native insert/uncertainty/namespace races.
Check that synthetic approvals are imported only by fixture code. Review the
whole final SHA and issue a separate verdict; these author tests do not supply it.

Systems/security review must approve the source-approval trust root and mutable
release policy retention, live certificate audit retention, OS network/process/
memory containment, scoped credentials/target validation, absence of concurrent
admin index DDL, cross-host concurrency and whole-operation deadline before any
live adapter. The current disposable guard must stay intact.

Owner must approve real release identity/date/UTC start and decision artifact,
first-date collision disposition, exact live publication scope and containment,
pinned server deploy and smoke, final combined client QA/merge/promotion,
old-bundle transition, monitoring and fresh-compatible rollback. Production index
readiness was reported by owner in #21; this task did not re-read it. No production
Atlas reads/writes, merge, deploy, live publication/schedule, platform setting
change, history deletion/reconstruction, v2 activation or GitHub CI polling occurred.
