# One-date operator publication — live apply BLOCKED

Issue [#24](https://github.com/MZKZxyz/fort-custer-server/issues/24), parent #6.
Starting server main `daf455a61aed7d83eb3f0bfc115044db1e46d992` matched fetched
main exactly. This is preparation outside the live API process, not activation.

**No production publisher is delivered as executable authority in this PR.**
`applyProduction()` and `npm run maze:operator -- apply` unconditionally return
`LIVE_APPLY_BLOCKED`. Arguments, approval files, environment flags and edited
config cannot enable it. There is no production URI selector or connection code.
`config/operator-publication.json` is blocked/empty and is a review template, not
an enable switch. `config/fresh-release.json` remains pending. No real launch date,
release certificate, production key, target or live grid is invented.

The concrete rehearsal implements preview/signature verification/one-date apply/
read-only reconcile against guarded disposable MongoDB only. Accepted
`publishApprovedDisposable`, `publishMaze`, executor, generator, runtime, routes,
models, index readiness and v2 interlock are unchanged. No API/HTTP/admin endpoint,
startup hook, seeder, cron or default package lifecycle calls the new workflow.

## Why live apply is blocked

The session has no approved dedicated operator runner, Atlas credential/role,
production target/network policy, owner signing roots or immutable release image.
Read-only environment inspection showed no effective capabilities, no-new-privs
and seccomp enabled, but **no writable cgroup delegation**. These observations do
not prove per-job network isolation, process-tree resource limits, volume trust,
a dedicated writer identity or any production infrastructure state. Presence of
Docker/bwrap executables is not proof of enforceable production isolation. No
container daemon, infrastructure, role or network policy was provisioned here.

The existing child has an empty/minimal environment and Node permissions, bounded
heap/RSS/watchdog/IPC and solver/rejection limits. **Node permissions do not deny
TCP; sampled RSS does not enforce whole-process memory or process-tree lifetime.**
The new 15s application budget is checked between phases, not an OS/socket deadline.
Existing finite DB budgets are additional safeguards, not substitutes for an OS
supervisor. Rehearsal mode is explicitly not a production security attestation.

## Reviewed execution architecture required before a live adapter

Use a dedicated one-shot operator job outside Railway and outside its account/
secret environment. Never run it as part of server deploy, web request, shell
startup or legacy seeders. Require independent security QA of the actual runner:

| Boundary | Required enforcement, not a self-reported boolean |
| --- | --- |
| Immutable source | Owner-approved exact merged server SHA and built image digest; verify read-only mounted source/artifact hashes before execution; reject dirty/mismatched source |
| Generation | Separate OS/container network namespace with no egress/DNS, no DB credential/token/socket mounts, read-only code, bounded scratch/output and no writable host mounts |
| Generator resources | Retain existing 1.5s watchdog, 128 MiB RSS/48 MiB old heap/4 MiB semispace, 256 KiB IPC and one worker; independently enforce cgroup memory+swap, CPU, PID/process-tree and wall-time limits |
| Writer | Separate short-lived unprivileged identity; no shell, no generation child access to its credentials; capability-drop/no-new-privs/seccomp and bounded filesystem/process/network resources |
| Egress | Only approved Atlas topology endpoints and required DNS/CA/time services; validate discovery hosts, DNS rebinding and TLS certificate trust; Node flags or an input hostname comparison are insufficient |
| Credentials | Separately provisioned scoped short-lived writer secret via protected descriptor/credential mount, never CLI arguments, shell history, chat, GitHub, generic .env or live-server environment reuse |
| Persistence | Dedicated protected durable intent/audit volume, singleton/cross-host exclusion, backups that never roll consumed approvals backwards; external append-only audit/consumption authority must resist copied/rolled-back local state |
| Shutdown | Independent hard deadline kills the entire process tree; after any crash/timeout, reconcile read-only before another owner disposition |

Candidate budgets for infrastructure QA, **not deployed settings**: generator
process group <=256 MiB including supervisor, no swap, <=16 PIDs, one CPU, hard
3s wall time; writer group <=192 MiB, <=8 PIDs, one CPU, hard 20s wall time.
Benchmark worst-case permitted inputs and failure injection before approving these
numbers. Runtime container/OS enforcement is missing and cannot be enabled by
this PR. A delegated trusted platform and reviewed executable supervisor are
required, not an instruction to run Docker privileged or weaken the sandbox.

The live credential should permit only exact-collection find/insert and required
read-only metadata. No update, delete, replace, upsert, collMod, collection/index
creation, user/role management or player collection access. Verify **effective**
privileges (not merely a role name) before insert. listCollections with full UUID/
validator options may require database-level metadata visibility: security must
approve that privilege or use a separate signed metadata inspector and explicit
DDL fence. It must not become broad data-read permission. Prevent concurrent
administrator index/validator DDL; collection UUID alone does not protect index
removal within the same namespace. TLS must validate certificates/hostnames, with
no tlsAllowInvalid* overrides. A one-connection pool still has topology monitoring
connections per replica member; enforce egress/capacity for the full topology.

No live credential provisioner, TLS target validator, privilege attester, distributed
lease/nonce authority or OS supervisor is implemented. Those missing capabilities
are hard prerequisites for a separately reviewed live adapter. Do not relax the
existing disposable guard or edit a `mode` string to get production access.

## Artifacts and trust

All signatures are Ed25519 over canonical UTF-8 JSON of
`["fort-custer/operator-signature-v1", payload]`. Keys are separate role-specific
public SPKI DER/base64 entries; duplicate key IDs/public keys are rejected, and
release/publish signer IDs must differ. Preview never holds a private key or signs
approval. Signing is an external owner-approved/offline process; cryptography
proves possession of trusted keys, not human review. Never transmit private keys.

The rehearsal context supplies trusted fixture public roots and expected source
SHA explicitly. **It does not measure/attest the running Git checkout or authenticate
the real owner.** A self-chosen fixture key/context proves nothing about production.
Future live roots, source/image measurement and execution policy must come from
the approved immutable runner, not the request file. All current certificate kinds
are named `rehearsal`; none is a live approval or deployment certificate.

| Artifact | Exact binding |
| --- | --- |
| Fresh release | Existing reviewed releaseId, UTC startDate/startsAt, decisionRef/approvedAt and decisionHash; never select a date from clock/old rows |
| Signed release envelope | operator-release-rehearsal-v1, sourceSha, fresh decisionHash, approval reference/time; signature verified before generation/DB operation |
| Target snapshot | Exact disposable host/port/replica set/database/mazes, collection UUID, full index fingerprint and collection-options fingerprint including validator/validation level/action/collation |
| Preview plan | one-date-rehearsal-v1, release-envelope digest, source SHA, target, worker/operator limits hash, explicit date/version/seed/full canonical config, generation identity/grid/content hashes, deterministic solver summary/hash, UTC window |
| Signed one-date approval | one-date-rehearsal-approval-v1, unique UUIDv4 approvalId, source/release/plan digests, exact date, decision reference, approval time and identical notBefore/expiresAt |

Every object has exact own data keys; unknown fields/accessors/prototypes, missing
explicit input fields, malformed signatures, mismatched source/release, future or
prelaunch dates, zero/over-24h windows, expired approvals and time reversal refuse.
Window expiry is exclusive. Preview may review a past window without writing;
apply must be inside it, and resamples after generation/metadata/filesystem waits.
Regeneration uses only the exact approved identity and compares complete content,
grid hash and solver summary before a write. No alternate seed/day or automatic
backfill exists. Collection metadata with unsupported non-JSON BSON or >64 KiB
cannot be fingerprinted by this rehearsal and is refused, not normalized silently.

Fingerprints canonicalize option keys; compound index key **order** is preserved
as ordered pairs. The entire options snapshot is pinned, even if validator is
absent. That absence is not proof of a production schema validator: owner/security
review must explicitly approve the observed validator policy. No schema/DDL is
created. Startup still separately requires all four accepted app indexes.

## Current local commands

```sh
# No connection, URI, approval-file or environment selector:
npm run maze:operator -- status
npm run maze:operator -- apply  # exits 2, always LIVE_APPLY_BLOCKED

# Optional offline review. Request contains the strict rehearsal context, full
# input, previously approved target snapshot and window; no credentials/URI.
npm run maze:operator -- preview --request "$REVIEW_REQUEST" --out "$REVIEW_ARTIFACT"

# Complete disposable end-to-end apply/reconcile and adversarial cases:
unset MONGO_URI MONGODB_URI MONGO_URL DATABASE_URL
export MONGOD_BINARY
npm run test:operator
npm test
node tools/integration/freeze-contract.mjs
```

Preview reads a bounded regular non-symlink request (<=256 KiB), uses trusted system
now, and writes an exclusive 0600 review artifact without overwriting anything.
That private artifact intentionally includes the grid for review. Stdout contains
only mode/planHash; errors are fixed/redacted. **Operation reports and audit intent
never include a grid, player document, secret, signature or connection URI.**
The offline preview does not instantiate a Mongo client or read ambient selectors.
There is no apply/reconcile CLI for arbitrary connected databases. The fixture-only
library `operateDisposable` requires an explicitly owned connected model and
`RehearsalLedger`; it accepts only the reserved unauthenticated loopback namespace.
The existing authenticated/remote/SRV refusal remains intact.

## Rehearsal apply and uncertainty protocol

1. Validate/snapshot signed release, plan and independent approval; bind current
   clock and exact source label. Refuse spent approval/date state before DB work.
2. Guard the already connected owned fixture: retryReads/retryWrites false,
   maxPoolSize 1, positive queue <=2s, discovery/connect/socket <=5s. Fixture
   configuration uses 2s discovery/connect/queue, 3s socket above the 2s command
   budget. These suit one sequential local rehearsal; live latency/capacity and
   monitoring must be measured separately before any production pool settings.
3. Read only exact-name collection metadata (closed cursor <=1 row) and <=16
   indexes, 2s commands. Verify unique date + accepted compound archive index,
   UUID, options and index fingerprints. Never scan historical maze/player rows.
4. Exact-date primary/majority read, limit 1, same UUID. **Any existing row STOPs
   apply**, including a matching row. Use explicit read-only reconciliation to
   inspect the original signed intent; never delete/stamp/reseed/choose another day.
5. Regenerate/verify the same candidate in the bounded worker, recheck clock and
   metadata. Append durable exclusive approval and logical namespace/date claims
   to owned 0700 state using O_EXCL/O_NOFOLLOW, 0600 files and fsync file+directory.
   Claims are never removed, even after failure. Recheck time after persistence.
6. Submit exactly one UUID-bound native one-document insert with majority concern,
   wtimeout/maxTimeMS 2s. No transaction body retry, driver retry or application
   insert retry. A unique date index arbitrates competing processes.
7. After ACK, duplicate or unknown outcome, perform one bounded primary-majority
   exact-date read. Only exact signed content, fresh provenance, hash and approved
   publication timestamp can report a verified winner. Conflicting content STOPs.
   Missing winner or failed read stays uncertain; local visibility is insufficient.
8. Persist a bounded report. If the row verifies but audit completion fails, report
   VERIFIED_WINNER_AUDIT_UNAVAILABLE and preserve intent. A restart may only
   reconcile the original consumed intent, including after approval expiry.

| Disposition | Operator response |
| --- | --- |
| INSERTED_VERIFIED | One ACK and exact majority-visible winner; preserve review/intent/report |
| RECONCILED_VERIFIED / VERIFIED_WINNER | Exact winner proven, creation ACK uncertain or read-only recovery; no more writes |
| NO_WINNER_UNCERTAIN / WRITE_UNCERTAIN | Not proof of absence; retain consumed intent, STOP and escalate read-only reconciliation |
| DATE_COLLISION | Existing/different content; owner decision, never overwrite/delete |
| TARGET_DRIFT / INDEX_NOT_READY | Stop; separate metadata/DDL disposition, not automatic repair |
| VERIFICATION_UNAVAILABLE / TARGET_UNAVAILABLE | Stop/reconcile under approved read scope; no misleading success |
| CERTIFICATE_INVALID / APPROVAL_INVALID / PLAN_INVALID | New reviewed artifact required; no write |
| APPROVAL_OR_DATE_SPENT | Never reset/copy/roll back ledger to retry; reconcile only |
| GENERATOR_* / WORKER_RSS_MONITOR_UNAVAILABLE | Fail closed, preserve existing rows; no reroll |

A failed attempt permanently burns its logical namespace/date claim even if no
insert was submitted. No same-date reset/supersession API exists in this PR.
A future retry after independently proven abort needs a separately reviewed owner
supersession/consumption design; using a different ledger directory is not recovery.

Local files demonstrate crash durability and nonce consumption on this filesystem;
they are **not** a global cross-host nonce service or tamper-resistant audit.
Ephemeral/cloned/rolled-back state defeats that trust model, which is another live
blocker. No process may treat disappearance of local state as fresh authorization.

## Later production gates and recommended order

Each step requires separate owner scope and an independent security/QA verdict:

1. Accept this exact source PR for design/rehearsal only; production stays blocked.
2. Provision/verify isolated operator runner and scoped credential/target/network
   policy; authorize narrow metadata observations, not broad history inventory.
3. Owner chooses real fresh launch date/time/release identity and approves a pinned
   **resulting merged source SHA/image**, signing roots and fresh release artifact.
   A verified source digest is not itself evidence of owner approval.
4. Produce/review the exact one-date candidate, solver/difficulty, target UUID,
   index/validator fingerprint, source/limits/window and plan digest. Independently
   sign the exact one-date write authorization; no recurring/wildcard authority.
5. In an announced coordinated window, prefer separately approved pinned fresh API
   deployment first (empty Today), then one scoped insert/verification, then client
   promotion after smoke. Old live source 8e3eac84 has raw date lookup and seasonal
   daily rankings: insert-first could expose a new grid before fresh enforcement.
   Any other order needs explicit traffic isolation/owner acceptance.
6. Verify root/readiness, exact admitted first day/hash, old-date refusal, owned
   start/complete/original UUID retry, public fresh rankings, owner-only projection,
   missing-day behavior and v2 OFF under separately approved authenticated scope.
7. Client #54 stays draft/unmerged here. Its 2025 weekly controls/legacy aggregate
   labels need coordinated UI correction and final combined-tree QA before owner
   Vercel merge/promotion. Cached 2025-only bundles cannot discover fresh gameplay;
   use a short approved interruption/refresh plan, preserving receipt storage.
8. Monitor bounded reports and archive lag immediately and around UTC rollover.
   No operator step is performed here against production, Railway or Vercel.

Rollback is workflow/traffic/code-only. Stop further jobs, preserve every inserted
grid and intent/receipt/reward, retain a fresh-compatible image with the same
approved release identity. Publication is permanent: no rollback delete/upsert.
The old 8e3eac84 server is not a routine fresh-era rollback because it restores old
starts and cannot rank new dates. An erroneous inserted date is an owner integrity
incident, not permission for engineering to rewrite history.

## Eventual daily scheduling — design only

A future separately approved singleton runner samples UTC once per job and proposes
one exact current-date deterministic seed/config/version. Use monitored daily
cadence after the UTC boundary; today remains unavailable until a genuine stored
publication. Missing days stay holes. No alternate day/seed, unbounded retry or
bulk backfill. Late publication needs a new finite exact-date scope/window.

Automatic scheduling requires a distinct reviewed authorization model: today's
human one-date certificate cannot authorize tomorrow. Alert on missing current
day, deadline/memory/IPC/monitor failure, busy/lease state, expiry/clock reversal,
target/privilege/index drift, collision, uncertainty or audit failure. A future reviewed retry/supersession design must cap retries
and backoff after read-only resolution and a fresh exact authorization;
never auto-replay an uncertain insert or erase consumed state. No cron, deployment
hook, schedule resource, cloud function or long-running publisher is installed.
