# Sprint 1.7H nonproduction validation

Required baseline: `daf455a61aed7d83eb3f0bfc115044db1e46d992`, verified identical
to fetched main before creating `sprint-1.7h-controlled-publishing`. Read issue #24
in full (no comments), fresh release/worker/controlled publisher/model/index code
and prior accepted security/release reports. The accepted disposable publisher
and guard are unchanged; the new protocol is a separate guarded rehearsal.

**Engineering result:** source and nonproduction workflow prepared for independent
security QA. **Production result: BLOCKED**, with no claim of a trustworthy live
adapter, real release approval, live grid or isolated production runner. See
[operator/security runbook](RUNBOOK.md) for exact missing provisions and gates.

## Evidence

Node 24.19.0, disposable MongoDB 8.0.16. All Mongo invocations unset MONGO_URI,
MONGODB_URI, MONGO_URL, DATABASE_URL and provide only a local MONGOD_BINARY.
Database ports/directories are allocated by owned fixtures; no external URI,
secret, target or Atlas record was fetched. Process/crash children accept only
that fixture's reserved loopback URI and scrub their environment.

Baseline full suite: **542 passed**, zero failures/cancellations/skips/todo,
77753.511388ms. Final corrected-source results:

| Check | Observed result |
| --- | --- |
| Dedicated `npm run test:operator` | **26 passed**, zero failed/cancelled/skipped/todo; 8407.098058ms |
| Complete `npm test` discovery | **568 passed**, zero failed/cancelled/skipped/todo; 82902.608725ms |
| Syntax | **112 JS/MJS files** passed `node --check` |
| Frozen v2 contract | **FROZEN_CONTRACT_MATCH**, file unchanged |
| Whitespace | `git diff --check` passed |
| Production CLI boundary | status reports LIVE_APPLY_BLOCKED; apply reports same and exits 2, no connect |

Two earlier complete corrected-source runs also passed 568/568 (82526.020469ms
and 79745.728818ms). The final run includes actual CLI byte-read bounds and
locale-independent metadata ordering. No intermittent failure occurred in the
passing corrected-source runs. Early development failures and corrections are
listed below; no test was skipped or weakened to claim production readiness.

Artifact SHA-256 values:

- Blocked `config/operator-publication.json`:
  `b817ff9fa3ce2f1adc145628fdb03bc5cd73bc5c914f79bdfb81bb35af855607`.
- Unchanged pending `config/fresh-release.json`:
  `b296a0a06dca2b574044ffc1ab27ba6c876580c78489c27dccc05134d9bcde02`.

The final full PR head is pinned in its description and engineering handoff;
source/fixture approval labels are not an approved production release SHA.

Dedicated operator regressions cover:

- Unconditional blocked live entrypoint even with hostile arguments/ambient
  selectors; no DB commands, file/secret access or network connection in that path.
- DB-free repeated byte-equivalent preview, source/release/solver/content/limits/
  namespace fingerprints, no self-generated approval, exclusive private CLI output.
- Ed25519 release/publish roles, malformed/forged/stale/wrong-scope/source/date/
  time/window signatures, pending release, explicit config requirements and no
  insert/intent on invalid authority. Fixture keys are ephemeral/in-memory only.
- One approved immutable winner, spent approval/date state across a new ledger
  object, read-only recovery after expiry, no private/raw document in reports.
- Old stored row/candidate mismatch, changed standalone grid/content hash, missing
  unique index, changed options/validator/index fingerprints, unsafe model handles,
  UUID drop/replacement and competing duplicate/old-row races.
- Real Mongo failCommand insert timeout, find failure, not-primary verification,
  closed insert connection, write-concern ambiguity, election/stepdown, one submit
  and no automatic write retry. Explicit post-insert ACK/wtimeout fault simulations
  also prove exact majority-winner reconciliation.
- Real SIGKILL before insert after durable intent, SIGKILL after actual insert ACK,
  killed generator, read-only process-restart reconciliation and healthy reuse.
- Caller mutation during awaits, concurrent local approval reuse, unsafe ledger
  permissions, expiry during filesystem waits, backwards clock and audit-report
  failure. The report preserves uncertainty instead of claiming no write.

Source isolation review: cgroup is not writable/delegated, effective capabilities
are zero, no-new-privs and seccomp are enabled. No privileged/container/namespace
escape or infrastructure change was attempted. These local facts do not establish
production network/process-tree/credential/nonce isolation; live apply stays blocked.

## Corrections during engineering validation

The first preview implementation expected solver actions, but the accepted worker
intentionally strips actions/path/interactions from IPC. Bound the returned
analysis summary instead, preserving the worker untouched. An early DB-free test
helper accidentally re-ran target inspection; corrected the helper to use its
provided snapshot. The killed-worker fixture initially imported executor before
installing its fault hook; delayed the fixture-only import so SIGKILL is genuine.

A write-concern-fault test incorrectly assumed local row visibility implied an
immediate majority winner after election. Corrected that assertion to allow
NO_WINNER_UNCERTAIN until a majority winner is verified. The protocol never
replaced its majority read with local visibility or retried an uncertain insert.
Initial failing runs are development evidence, not intermittent suite failures.

## Scope, reproduction and handoff

```sh
unset MONGO_URI MONGODB_URI MONGO_URL DATABASE_URL
export MONGOD_BINARY
npm run test:operator
npm test
node tools/integration/freeze-contract.mjs
npm run maze:operator -- status
npm run maze:operator -- apply  # expected blocked, exit 2
```

No app/startup/route/contract, existing services/models/generator/executor/publishers,
legacy/fresh manifests, CI, dependency lockfile, schema/index or infrastructure
change. Package changes add explicit test/offline operator scripts only, with no
start/postinstall/prepublish hook. Current server/client runtime/old UUID recovery
and fresh-only admission/ranking remain under the complete regression suite.
No new full client build/browser campaign is claimed for this standalone tooling.

Independent security QA should pin the PR's exact final SHA, reproduce full and
adversarial tests, scrutinize signature trust/clock/target snapshotting, durable
intent and crash/uncertain state transitions, ensure every new apply is disposable,
and independently verify that no artifact/config/environment can activate live
apply. Review raw-map/metadata size limits, soft vs OS deadlines and local ledger
trust assumptions. Author tests are not independent acceptance.

Remaining gates are dedicated OS containment/immutable-source measurement,
approved live trust roots and scoped credentials/TLS/topology/privilege checks,
cross-host nonce/concurrency/audit durability, owner fresh release/date approval,
separate exact-date insert and deployment permissions, client label/cached-bundle
coordination and eventual scheduling authorization. No production data access,
real publication, deploy, merge, secret/infrastructure change, schedule/v2 activation
or GitHub CI polling occurred. Stop for independent security QA.
