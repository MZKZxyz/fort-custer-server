# Reproduce the disposable isolation proof

Sprint 1.8A extends this same opt-in Docker harness with real supervisor SIGKILL,
exact-ID recovery and retained central approval consumption. See
[HOST-LIFECYCLE](HOST-LIFECYCLE.md) for the host fixture, separate failure-case
matrix, NOT VERIFIED controls and operating instructions. It does not turn this
surviving-parent proof into a durable host deadline.

Use Node 24, Linux with a local trusted Docker daemon, cgroup v2 CPU/memory/PID
controllers, default seccomp and enough disk for the Node/Mongo images. No cloud
account or production database is needed. Missing enforcement causes a failed
proof; there is no skip/fallback mode or simulated OS success. For a managed
environment follow its proxy/CA instructions; do not change network policy or
disable TLS. A Docker socket grants host authority: use a disposable test host.

```sh
node --version  # v24.x
npm ci
git status --porcelain  # must be entirely clean, including untracked files
unset MONGO_URI MONGODB_URI MONGO_URL DATABASE_URL
# Public fixture dependencies only. The proof pulls the pinned Node image and
# requires the pinned Mongo image below to be present locally.
docker pull mongo@sha256:5dda65a823a0d73d9caae4f449ab01973cf9884cea4ef56f9cb84dbe5e00acbd
npm run test:operator-isolation
npm run proof:operator-isolation -- /tmp/fc-isolation-evidence.json
```

The harness explicitly selects `/var/run/docker.sock`, clears Docker endpoint/TLS
selectors and preserves registry/proxy configuration. It builds a clean exact Git
archive, uses pinned public Node 24/Mongo 8 image digests, installs locked packages
with lifecycle scripts disabled and TLS verification enabled, and mounts the
build CA using BuildKit secrets (`CODEX_PROXY_CERT` or system CA bundle). There
are no runtime package installs. It measures all `/app` source/dependency regular
files (excluding its own manifest and npm executable `.bin` links). OS/runtime
files are covered by the image digest, not that manifest. No root from the request
or arbitrary image/URI selector exists in the harness CLI.

Most container/volume names have a fresh `fc17j-*` prefix. Sprint 1.8A lifecycle
jobs instead use `fc18a-<UUID>` names bound to their private intent/ID receipts;
both sets are tracked for verified disposal. Fixture credentials and
private signing keys are generated fresh; private signing keys remain in host
memory and fixture credentials go only to 0600 temporary files/named volumes.
The harness removes completed provisioning helpers and stopped jobs promptly
(jobs only after inspecting their stopped/PID-zero state), bounding retained
filesystem copies on a `vfs` daemon. Remaining containers, volumes, temporary
files and image tags are removed in `finally`. The evidence file is created exclusively after verifying disposal;
choose a new output filename for each run. It remains outside the checkout. Docker build cache
and public base images may remain. On supervisor/host SIGKILL, `finally` cannot
run: preserve evidence first, then inspect and remove only that invocation's
exact recorded prefix and lifecycle receipt IDs. Never use a broad Docker prune
on a shared daemon.

Evidence contains source SHA, runtime Node version, base digests, built image ID,
content measurement, individual passed assertions and aggregate document/claim/
audit counts. It contains no grid, credential, URI, signature or private key.
Failure exits nonzero and produces no success evidence. Avoid publishing raw
fixture volume contents or Docker build environments.

The opt-in Docker proof is separate from automatic test discovery because it
requires a trusted local daemon and builds images. It is **not** represented as
a skipped test in `npm test`. Its probes deliberately trigger OOM/PID pressure
inside bounded containers. It never creates remote infrastructure or publishes
a port. The fixture admin account exists only to build/read disposable state;
jobs never receive that account.

## Adversarial checks

The executable harness covers: real network/DNS/metadata denials; missing
generator secret/socket mounts; separate writer UID; read-only source; active
seccomp/capability/no-new-privs state; exact cgroup settings; actual memory OOM,
CPU throttling and PID-exhaustion event; detached descendant teardown; changed
source; signed wrong source; invalid signatures; signed malformed candidate;
unauthenticated DB access; actual least-privilege denials; independent concurrent
writers; replay after fresh container start; unknown claim ACK with zero insert;
unknown insert ACK and separate read-only reconciliation; retained central claims
and audit counts; target metadata drift. Assertions are required, not informative
log messages. See the [threat model](THREAT-MODEL.md) for what each does not prove.

The isolation/security tests verify measurement, signed authority/input bindings
and strict index readiness, including disposable-Mongo metadata regressions.
The prior operator suite remains the complete release/window/fresh-provenance,
worker watchdog, exact-date publication and actual Mongo fault regression suite.
The new fixture protocol stores synthetic candidate bytes in its reserved DB;
it is not wired into the app model or a live publication adapter. Fixture ACK
faults occur after actual commands and deliberately discard results; they model
uncertainty rather than assert that a network partition happened.

## Index readiness correction (Sprint 1.7J P3)

[Independent review 5693265522](https://github.com/MZKZxyz/fort-custer-server/pull/27#pullrequestreview-5693265522)
demonstrated that a unique `{seed:1}` index named `date_1` passed the former
fixture readiness check. `target(db)` now reuses the server's index assessment:
the actual ordered key must be exactly `{date:1}`, with `unique === true`, no
sparse/partial/hidden/in-progress-build/TTL behavior and absent or simple
collation. The name provides no authority. The complete options/index metadata
and ordered keys still participate in the target fingerprint.

The permanent regressions cover misleading field, direction, compound keys,
missing uniqueness, sparse, partial, hidden, TTL and incompatible collation.
They also exercise unfinished-build metadata, compatible simple collation,
name-independent success and preservation of full fingerprints. Disposable Mongo
must reject each adversarial definition and accept the correct date index,
which must reject a duplicate date with code 11000.

The Docker proof adds nine actual authenticated writer attempts against those
adversarial index definitions. Each must refuse before creating any claim, maze
or audit row. Restoring the exact correct index must retain the original signed
target fingerprint and allow the subsequent one-winner concurrency/recovery
proof. These nine checks extend the original 24 required assertions to 33.
Only the synthetic fixture administrator can install these definitions; the
writer's DDL privileges remain denied.

During expansion of this matrix, two local proof attempts stopped at partial-index
setup; bounded diagnostics on the second identified MongoDB `14031`
(`OutOfDiskSpace`). Retaining every completed container until final teardown
exhausted the `vfs` daemon's fixture disk. Prompt removal of stopped containers
addresses that test-harness limit without changing job budgets, enforcement or
retained Mongo authority. Failed runs produced no success evidence and completed
their disposal checks; the final full proof must pass without skips.

Red/green verification: the new wrong-field regression failed on the baseline
predicate with `Missing expected rejection`; the corrected predicate passes.
The handoff on PR #27 records the final exact SHA, observed suite counts and
Docker evidence. No production readiness is inferred from these tests. This
correction does not close the external concurrent-DDL fence or any production
gap in the [threat model](THREAT-MODEL.md).

## Full regression and independent QA

### Sprint 1.8A P3: primary and cleanup diagnostics

The proof runs primary work and disposal as separate phases. Disposal continues
all tracked removal and inventory checks after an individual failure. Only exact
Docker responses for an already-absent tracked resource are benign; every other
nonzero removal remains a cleanup failure, even if a later inventory is empty.
Success evidence is written only after **both** phases succeed. Either failure
exits 1; combined failures retain both contexts in one `PROOF_FAILED` JSON record.

Reports contain phase identity, a command/operation allowlist, bounded exit status,
and allowlisted reason codes. Raw stderr, command arguments, paths, grids,
credentials, signatures, arbitrary error properties, causes and stacks are never
serialized. Unknown free-form diagnostics are suppressed, rather than guessed
safe by truncation. The published controlled fault tokens
`QA_PRIMARY_PROVISION_FAILURE` and `QA_SECONDARY_CLEANUP_FAILURE` are allowlisted
for reproducible QA. Cleanup retains at most eight diagnostics plus
the total failure count; reason scanning is limited to the first 4096 characters.

Permanent subprocess regressions in `test:operator-lifecycle` cover primary-only,
cleanup-only and combined failures, no success artifact, exact-ID adapter calls,
continued disposal verification, bounded reports, secret canaries, unknown/falsy
exceptions and the success path. These synthetic command adapters prove reporting
and control flow, **not OS/Docker enforcement**. A separate controlled Docker CLI
shim reproduction must fail writer-helper start before execution and refuse
removal of that same inspected helper ID. It must exit nonzero with both reason
codes and disposal failure, produce no success evidence, and preserve the stopped
helper/owned volume for explicit exact-ID fixture teardown. This injection does
not establish actual daemon loss, physical ENOSPC or the cause of earlier natural
provisioning failures.

This diagnostic correction changes no lifecycle authority, consumed claims,
production policy or host enforcement. All NOT VERIFIED host properties in
[HOST-LIFECYCLE](HOST-LIFECYCLE.md) remain blockers.

Obtain a local `mongod` 8 binary for the existing test fixtures (the repository CI
documents its checked download), then run from the clean pinned PR head:

```sh
unset MONGO_URI MONGODB_URI MONGO_URL DATABASE_URL
export MONGOD_BINARY=/absolute/path/to/mongod
npm test
npm run test:operator
npm run test:operator-isolation
node tools/integration/freeze-contract.mjs
git ls-files -z '*.js' '*.mjs' | xargs -0 -n1 node --check
git diff --check
```

Independent Systems/Security QA should record exact `git rev-parse HEAD`, inspect
the live-block file and unchanged production configuration, rerun every command
and the Docker proof, and verify the report against actual daemon inspect/cgroup
observations. Review exact entrypoints/mounts/users, source/bootstrap trust,
canonical role separation, central claim atomicity, one-submit behavior and
read-only recovery. Inspect denied operations, not only declared role names.
Review the host-death, DDL, Atlas TLS/egress and audit/restore gaps explicitly.
Do not install real roots/credentials, query production Atlas, start a production
server, merge, deploy or poll GitHub CI as part of this engineering handoff.

The report establishes engineering evidence only. Independent QA must return its
own verdict at the final PR head. A source merge, runner provisioning, credentials,
owner release/date/signing, exact one-date approval/insert, Railway promotion,
client #54/Vercel promotion, rollback/monitoring and scheduling remain separate
owner GOs in the [runbook](RUNBOOK.md).
