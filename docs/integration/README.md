# Disposable server integration harness — Sprint 1.5A

Server issue [#9](https://github.com/MZKZxyz/fort-custer-server/issues/9), paired
with client [#47](https://github.com/MZKZxyz/fort-custer-client/issues/47).
Based on merged server main `f33ce52a86ffccae5c28c661ce560ff783a9b836`.
The client baseline identified by that handoff is
`9467af75ce730811d2911e4d05a1707ce4c5cbc4`.

This package assembles **the existing real compatible bundle** in a separate
localhost process. It is test infrastructure. Production `index.js`, activation
installer, application services/routes/models, manifests, default v1 writers and
deployment configuration are unchanged. Literal production v2 enable still
throws before database connection. No configuration-only production activation
path is added. Issues #5 and #7 remain open release gates.

## Requirements and commands

Use Node 24 (verified 24.19.0), MongoDB **8.0.16** and the repository's installed
dependencies. Set `MONGOD_BINARY` to the MongoDB executable, or have `mongod` on
PATH. No container, local MongoDB service, manual database or seeder is needed.
The launcher checks the server version and refuses a different version.

Do not pass a database URI or data directory. The launcher refuses ambient
`MONGO_URI`, `MONGODB_URI`, `MONGO_URL` and `DATABASE_URL`, including localhost
development URIs. It also refuses unknown options such as `uri` or `dbPath`.
For a test shell with unrelated database configuration already set, explicitly
remove those variables for these commands:

```sh
# From fort-custer-server; MONGOD_BINARY selects an executable, never a database.
env -u MONGO_URI -u MONGODB_URI -u MONGO_URL -u DATABASE_URL \
  node tools/integration/smoke.mjs

env -u MONGO_URI -u MONGODB_URI -u MONGO_URL -u DATABASE_URL \
  node --test test/integration-harness.test.mjs

env -u MONGO_URI -u MONGODB_URI -u MONGO_URL -u DATABASE_URL npm test
node tools/integration/freeze-contract.mjs --check
```

The smoke command prints only a sanitized success object and closes everything.
The dedicated suite starts actual HTTP servers and owned temporary replica sets;
it does not mock successful v2 responses. The full suite also retains the 404
previous regressions, including compatible v1 and shared collectible validation.

For an interactive local client, start the server from an adjacent checkout:

```sh
# From fort-custer-client; the two repositories are sibling directories.
env -u MONGO_URI -u MONGODB_URI -u MONGO_URL -u DATABASE_URL \
  node ../fort-custer-server/tools/integration/launch.mjs \
  --client-origin http://127.0.0.1:5173 --workers 2
```

The single stdout JSON readiness line contains `baseURL`, `origins`, frozen
fixture dates/hashes and an explicit untimed/test-only marker. Point the client's
explicit experimental build at that **dynamic** base URL, preserving its `/api`
prefix. The launcher does not edit client flags/config. Use the real synthetic
registration/login/profile UI, or the private Node helper below. Never paste a
JWT or signing key into source. Ctrl-C/SIGTERM stops HTTP workers/MongoDB and
removes the private temporary data directory.

Only explicit HTTP localhost client origins are accepted. Repeat `--client-origin`
for another port; `localhost` and `127.0.0.1` are distinct browser origins. Both
application workers bind exclusively to 127.0.0.1. CORS permits Authorization,
Content-Type, If-Match and the two protocol headers for allowed origins; an
unlisted Origin is refused. Readiness is not an unauthenticated capabilities API:
`GET /api/v2/capabilities` still requires a real JWT.

## Node / external Playwright fixture

`tools/integration/client.mjs` exports `spawnIntegration({workers,clientOrigins})`.
It forks the supervisor, waits for readiness and exposes:

| Method/property | Purpose |
| --- | --- |
| `metadata` | Public readiness JSON; no credentials, JWT, DB URI, process ID or filesystem path |
| `bootstrap()` | Actual HTTP register/login/add-profile; verifies HS256 JWT and durable profile-origin evidence; returns ephemeral identity only through private IPC |
| `control(op,args)` | Private IPC fault/restart/inspection controls below; no HTTP admin endpoints |
| `close()` | Await worker exit, database termination and temporary-directory removal |

From a Node/Playwright module at the client repository root:

```js
import { spawnIntegration } from '../fort-custer-server/tools/integration/client.mjs';

const integration = await spawnIntegration({
  workers: 2,
  clientOrigins: ['http://127.0.0.1:5173'],
});
try {
  const identity = await integration.bootstrap();
  // Runtime-only: email, password, token, accountId, subProfileId.
  // Use the actual client login UI with email/password, or pass token/profile
  // through the client's test setup. Never print or commit this identity.
  const apiBase = integration.metadata.baseURL;
  // Launch the opted-in client against apiBase; run real browser assertions.
} finally {
  await integration.close();
}
```

Use one fixture per Playwright worker or create a fresh identity per scenario.
Always close it in `finally`/fixture teardown. Bootstrap creates genuine new
synthetic profiles through compatible lifecycle services; it does not manufacture
dateHistory rows or guess entitlement from empty inventory. Credentials/signing
keys are freshly random per launch/account, kept in memory and never included in
readiness, frozen fixtures or evidence. Do not publish auth headers, bootstrap
responses, raw IPC snapshots or credential-bearing browser traces.

The worker disables dotenv file loading before importing actual legacy routers
and injects only its own signing secret. Neither real local `.env` nor production
entrypoint installer is used. The supervisor alone creates the MongoDB URI using
the existing temporary-replica-set infrastructure. The private worker's startup
message is an internal ownership channel, not a caller-supported URI recipe.

## Frozen client contract

Machine-readable [session-v2.contract.json](session-v2.contract.json) has version
`fc-session-v2-integration-1`. It pins actual source-file SHA-256 digests and exact
fixture/normalized-transcript hashes. Tests compare both the file and live
normalized HTTP responses. Dynamic IDs/nonces/timestamps use `$...` placeholders;
actual requests must use the returned/persisted runtime values. No real token is
embedded. `freeze-contract.mjs --check` is read-only; `--write` is an explicit
authoring action, not permission to silently change the agreed server protocol.
Coordinate any future mismatch with client #47 before changing behavior.

All v2 paths mount at `/api/v2`; compatible v1 mounts at `/api/users` and
`/api/maze`. Every v2 call sends `Authorization: Bearer <runtime JWT>`. For JSON
mutations send Content-Type application/json. Create additionally requires:

```text
X-Fort-Custer-Protocol: session-v2
X-Fort-Custer-Capabilities: route-transcript-v1
```

| Operation | Exact body / read selector | Fresh revision |
| --- | --- | --- |
| GET capabilities | no body | none |
| POST sessions | `{subProfileId,date,createKey}` | none |
| POST sessions/:id/ready | `{subProfileId,key,nonce,gridHash,rulesVersion}` | `If-Match: "1"` from create |
| GET sessions/:id/status | sole query `subProfileId` | none |
| POST sessions/:id/complete | `{subProfileId,completionKey,transcript}` | current positive revision, normally `"2"` after ready |
| GET sessions/:id/result | sole query `subProfileId` | none |
| POST sessions/:id/recover | `{subProfileId}` | none |
| POST sessions/:id/abandon | `{subProfileId,key,reason}`; user-choice/restart/change-grants | current revision |

Envelopes are strict; extra client time/position/proof fields are rejected. Key
syntax is 8–128 ASCII letters/digits/underscore/hyphen. **Create and completion
keys are account/operation scoped**, with profile/date or profile/attempt/hash
bindings. Ready and abandon additionally scope by attempt. Do not reuse account
create/complete keys across profiles or distinct attempts. Persist keys, payload,
account/profile/date and transcript before transmission. Recognized exact replay
bypasses stale/missing If-Match; changed bindings conflict. Create/ready replay
returns the current effective session view, not always the original state/nonce.
Read status after revision changes or an explicit abort.

The primary date is 2025-05-26; 2025-05-27 supplies an independent date/exhaustion
case. Both mazes use rows `######`, `#SXFE#`, `#    #`, `######`. Frozen canonical
route: `up,down,right,right,up,left,up,right,right,right`, seq 1–10. It includes
blocked wall and unarmed fire, X pickup, stationary F clear, a **fresh** step into
the cleared cell and E arrival. Four consecutive right commands are another valid
route. Record actual dispatched commands, including blocked ones, exactly once;
do not record animation frames or fabricate a missing prefix on reload.

The fixture catalog contains one valid synthetic item. Existing crypto uniform
selection is unchanged; a one-item fixture makes the award deterministic. A
subsequent date exhausts that catalog without adding inventory. Certified epoch
evidence is explicitly synthetic and exists only in the owned temporary database.
It is **not a real writer-drain audit or production cutover certificate**.

## Timing, receipt and recovery

The server samples `startedAt` at the guarded ready write; it becomes trusted only
after that transaction commits. The ready ACK latches STARTED before movement;
client mount/render/animation timestamps are not authoritative. The original
receipt is sampled before validation. Ready ACK overhead and network travel are
not subtracted. A local timer is provisional.

The normal harness uses the actual unmonitored wall-clock policy. All successful
v2 receipts here are **accepted untimed**, with null elapsedMs, completed date
progress and a persisted reward opportunity. No official timing is certified.
The manifest's existing integrity-tier/public-label vocabulary is not timing
approval; render the receipt's actual `timing.status`/integrity label. Untimed
results must not be written into an official best/board by the client.

Claim, immutable grant/exhaustion, User inventory, accepted source result and
outbox commit atomically. The original grant request is marked settled and a
notification event is inserted in the same transaction as acceptance. There is
no background payout or external notification sender in this harness. An HTTP
winner or recovered immutable receipt reflects already saved inventory; the
client must not increment it again. Private raw-state tests inspect all these
records and use majority result visibility before restart survival assertions.

V2 date completion is persisted in the shared `fc_v2_progress` ledger and exposed
in the owned accepted receipt. It does not populate the legacy embedded profile
time/progress map or public leaderboard. The client must restore v2 completion
from its owned result/recover API, rather than expecting a legacy profile fetch to
project it or writing an untimed duration into the old map. A general cross-version
profile/progress projection remains an integration gap outside this harness.

| Interruption | Required client behavior |
| --- | --- |
| Capabilities unavailable/admission false before any create | Retain default legacy flow; do not start v2 |
| Create sent, ACK lost, attempt ID unknown | Retry the same persisted create payload/key to discover original attempt; no legacy fallback |
| Ready committed, ACK lost | Replay original stored ready payload/key or read owned status; preserve original startedAt/deadline |
| Intake durable, finalization unresolved | Status can be STARTED plus saveStatus resolving; result may be COMMIT_UNKNOWN. Retry original complete or call recover |
| Recover returns aborted | Shared transaction has fenced the prior generation; read status/fresh revision, then retry same logical operation; a new receipt/generation is allowed |
| Completion committed, ACK lost | Result/recover/repeated complete return the exact immutable receipt; never request a replacement v1 start or duplicate credit |
| Refresh / two tabs | Check stored account/profile/date/manifest/gridHash/prefix, recover owned session/result and replay actual prefix. Missing prefix requires explicit safe abandon/review, not invented movement |
| Expiry / abandonment | No grant without accepted receipt. Preserve identity/recovery evidence; release or replacement is explicit |

No ordinary empty read proves abort. The exact HTTP/error/status/recovery matrix
is frozen in the JSON contract, including 503 retrySameOperation/unresolved and
Retry-After, 428 missing revision, 409 binding/state conflicts, 410 expiry and 422
invalid route. Save errors keep the attempt's evidence. A date-ledger-v1 legacy
hold/already-used/exhausted response may omit reward/opportunity fields; do not
invent one. A date-grant-v1 exhausted receipt has null reward and collectionComplete
true, permanently distinct from a pending request.

## Deterministic failures through private IPC

There are no administrative/fault endpoints in Express. Controls work only on the
supervisor's private process channel and only against its owned synthetic data:

| Control | Args / behavior |
| --- | --- |
| fault | `{worker:0, path, stage, action}`; exact full v2 path, one-shot |
| fault-status | `{worker:0}` → hit boolean; useful for barriers |
| release | releases a paused hook |
| restart-app | `{worker:0}`; replaces the application process on the same owned port/DB |
| restart-mongo | SIGKILL/restart the owned single-node replica set |
| clock | `{worker:0,at:<integer-or-null>}`; test-only absolute clock sample override, always unmonitored; null restores real wall samples |
| snapshot | consistent raw synthetic aggregate; credentials excluded from User; keep private |
| majority-result | `{attemptId}` → majority-visible winner boolean |
| invalidate-catalog / repair-catalog | removes/restores only the frozen synthetic item's required fields, for repair/retry tests |
| isolation | private MongoDB version/name/owned loopback-port diagnostics |

Example: arm lost ready ACK **before** issuing the ready request:

```js
await integration.control('fault', {
  worker: 0,
  path: `/api/v2/sessions/${attemptId}/ready`,
  stage: 'afterCommit',
  action: 'drop',
});
```

Stages: afterCommit (use exact create/ready path), finish:admitted (durable intake
and clock admission), finish:committed (durable final result), grant:inventory
(inside the atomic final transaction). Actions: drop closes HTTP acknowledgment,
crash SIGKILLs that worker, fail throws a retryable save error, pause waits for
private release. Use drop at the documented committed stages to claim lost ACK;
dropping inside a transaction alone is not commit proof. A resolver-first test
pauses the finalizer and shows its stale request cannot overwrite the abort.

Normal close, SIGTERM, SIGINT, IPC disconnect and startup failure clean up owned
resources. Tests cover normal close and both signals, including closed MongoDB
and HTTP ports. Controlled SIGKILL of an application worker and MongoDB are
supported while the supervisor stays alive. SIGKILL/power loss of the supervisor
itself cannot run JavaScript cleanup; automatic orphan scavenging after that case
is not implemented or claimed. No filesystem path is placed in public metadata.

## Evidence and measurable PASS definition

Author local results: **41/41 harness tests PASS**, **445/445 full repository tests
PASS**, zero failed/cancelled/skipped/todo. Smoke flow PASS; frozen source/response
contract, syntax, whitespace and RFC byte-replay checks PASS. Privacy-filtered
schema-2 evidence is committed in [harness-results.json](harness-results.json) and
[regression-results.json](regression-results.json); free-form logs stay private.

PASS requires actual authenticated create/ready/route/result/recover, matching
frozen response envelopes; accepted untimed progress and one grant/inventory
credit; no final effects for rejected routes/expired/foreign submissions; same
winner through lost ACK/restart/two-worker contention; real v1 compatibility;
and unchanged production interlock. The suite exercises wall/unarmed fire/pickup/
stationary clear/fresh entry/tipi, bad schema/sequence/hash/rules, real 10-second
partial-upload timeout, deadline −1/0/+1, abandonment, failed grant write and
catalog repair. Earlier inspector transaction-parallelism and startup-exit-code
bugs were fixed before the final runs; they were harness defects, not server
protocol changes.

These are Node HTTP/process/database tests. **No real browser or client build is
certified by this PR.** Sprint 1.5C must pin this server SHA plus the client #47
implementation and run the compiled browser at the agreed viewport/input/storage/
refresh/two-tab/lost-ACK matrix. Client recorder fidelity, prefix/storage integrity,
ready latch, accessible Help/recovery and no mid-attempt downgrade still need that
cross-repository evidence. Physical clock authority, live writer inventory/drain,
historical reconciliation, multi-member partitions/elections/physical durability,
production capacity, adjudication, public projections/privacy/retention/backups
and authorized cutover/rollback remain release blockers. No production data,
external database, migration, seeder, deployment or CI polling was used.
