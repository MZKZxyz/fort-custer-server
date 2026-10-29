# Sprint 1.8A: one attempt host lifecycle and recovery

Scope: [#29](https://github.com/MZKZxyz/fort-custer-server/issues/29), parent
[#28](https://github.com/MZKZxyz/fort-custer-server/issues/28). Engineering base:
`19519ce470b2a569f1002e7d26536d4a4b00690b`, the independently accepted 1.7J
source. **Disposable synthetic proof only; production NO-GO.** No production
credentials, signer roots, dates, Atlas reads, service installation, reboot,
provisioning, deployment or scheduling are authorized by this document.

## Decision and enforcement boundaries

Keep the small dedicated Linux host recommendation from [ADR-001](ADR-001-ISOLATED-PUBLISHER.md).
Do not add a control plane. Kernel, host root, systemd, Docker/containerd and the
protected supervisor are trusted. The supervisor's Docker socket is host authority;
neither generator nor writer receives it. Accepted generator/writer isolation,
resource budgets and least privilege remain unchanged. A production writer still
requires all the separate Atlas, authority and signing gates below.

Two independent boundaries are needed:

1. PID 1 owns the supervisor's lifetime (`Type=exec`, `RuntimeMaxSec=30`,
   `Restart=no`, `KillMode=control-group`, `ExecStopPost`). A surviving Node timer
   is not a substitute. The deadline includes setup and the fixed synthetic
   workload, not just an individual database command. At expiry systemd initiates
   termination; cleanup has its own 25-second service bound. This is not a claim
   that all hardware/kernel failures finish within exactly 30 seconds.
2. Docker containers live under a **separate dedicated** `fc18aproof.slice`,
   not the supervisor's service cgroup. Killing the service cgroup alone cannot
   kill a daemon-owned container. The fixed stop entrypoint first writes
   `cgroup.freeze=1`, then `cgroup.kill=1`, then requires `frozen 1` and
   `populated 0`. This path does not contact Docker. Keep the slice active and
   frozen through every cleanup error. Freezing also fences a delayed daemon
   start that arrives after the kill; killing an empty cgroup alone does not.

The slice has no delegation, must contain **only this disposable attempt**, and
must persist while fenced (`StopWhenUnneeded=no`, `RefuseManualStop=yes`). Use a
systemd cgroup driver, unified cgroup v2 with freezer/kill support, and disabled
Docker live restore. A host QA run must verify actual cgroup placement, parent
freeze propagation, delayed-start fencing, empty-state observation, and slice
persistence. **None of those host guarantees were verified in this workspace.**
Missing/failed fencing is STOP, never successful cleanup. Uninterruptible kernel
tasks, unavailable PID 1, power loss, malicious root and kernel compromise cannot
be resolved by a Node process. No signal-based software can guarantee progress
through every kernel/hardware failure. Keep the host isolated and investigate.

The fixed host fixture intentionally runs only the accepted image's `tree`
workload: an unprivileged process and detached descendant, no database or write.
It is not a production supervisor or a runnable replacement publication adapter.
The separate Docker proof exercises the actual synthetic writer after consuming
its majority-acknowledged claim. This separation avoids turning a fixture's local
state into production authority.

## Protected state and recovery semantics

`lifecycle.mjs` writes private exclusive files and fsyncs files and directory:

| Record | Meaning |
| --- | --- |
| `spent.json` | First durable local reservation, bound to intent hash; any partial/existing state blocks another prepare |
| `intent.json` | Unique UUID/name, pinned image ID/source SHA, exact cgroup parent; no caller command, URI, root or date |
| `receipt.json` | Exact full container ID, bound to intent; durable before start |
| `STOP.json` | Permanent local quarantine; cleanup/reconnect never clears it |

These are logically append-only under trusted ownership, **not WORM or a global
consumption authority**. Files/ancestors must be protected; records reject
symlinks, hard links, wrong ownership, permissive access, corrupt/oversize data.
The host fixture uses one fixed `/var/lib/fort-custer-proof/attempt`, root-owned
0700 policy/state, a root-owned non-writable `/opt/fort-custer-proof` tree and
exact installed clean Git SHA. Its CLI accepts only `run`, `status`, `recover`,
`boot-sweep`, never selectors. `/etc/fort-custer-proof/policy.json` supplies
owner-installed synthetic-only image ID and source SHA. Image bytes and installed
source are trusted, not authenticated by an operation request. Image ID and clean
Git content checks are not independent build provenance or owner attestation.

Recovery freezes/kills the fixed slice **before** fallible policy/state/daemon
work. It then quarantines and queries exact scope/job labels plus exact receipt ID.
ID, name, image, intent label, cgroup parent, disabled restart and disabled
auto-remove must agree before a destructive Docker command. It kills only the
recorded ID, observes stopped/PID-zero, removes that ID, then confirms absence.
No volume, image, audit or claim deletion exists in this recovery API. It never
prunes. Status uses the same validation without changing state or starting work.

| Interruption | Required disposition |
| --- | --- |
| Before local reservation | No job created; initial empty host is fenced and needs manual synthetic arming |
| During reservation/intent persistence | Partial state stays spent; fence, STOP; no start |
| During Docker create / before receipt persistence | Possible stopped orphan, missing receipt; fence, STOP; **no automatic container deletion** |
| After receipt / during start, generation or writer | Fence whole subtree, validate exact receipt, terminate/reap only recorded job; no restart |
| Daemon timeout or failed cleanup | Keep slice frozen and state spent, STOP; after reconnect run recovery only |
| Unknown claim or write ACK | No retry, no reset, no alternate date; retain original authority/audit and perform approved exact read-only reconciliation |
| Corrupt/missing records, policy drift, unexpected labels/IDs | Fence, STOP; human investigation; never guess authority from an orphan name |
| Reboot | No job enabled at boot, restart policy `no`; boot unit fences and reconciles only; no thaw or publication |

Local copied/rolled-back records cannot restore the actual synthetic writer's
central Mongo claim. The Docker proof demonstrates a real post-claim hold,
supervisor SIGKILL, exact-ID recovery, fresh writer refusing replay and read-only
missing-winner uncertainty. The retained claim count becomes 3, with 1 maze and
1 result audit. The fixture administrator explicitly destroys this synthetic DB
at final proof disposal; that does not demonstrate external immutable retention.
Production must use independently administered restore-resistant authority/audit.

## Reproduction in this workspace

Follow [ISOLATION-PROOF](ISOLATION-PROOF.md) for Node 24, pinned Mongo image,
managed proxy/CA and a local `mongod` binary. Start with a clean exact commit:

```sh
unset MONGO_URI MONGODB_URI MONGO_URL DATABASE_URL
export MONGOD_BINARY=/absolute/path/to/disposable-test/mongod
npm test
npm run test:operator
npm run test:operator-isolation
npm run test:operator-lifecycle
npm run proof:operator-isolation -- /tmp/unique-fc18a-evidence.json
node tools/integration/freeze-contract.mjs
git ls-files -z '*.js' '*.mjs' | xargs -0 -n1 node --check
git diff --check
```

The Docker proof starts a separate supervisor process, observes its real SIGKILL
and the surviving container, then explicitly invokes recovery in its surviving
parent. It also observes a detached descendant, leaves an unrelated container
untouched, repeats cleanup, compares retained record bytes, and tests central
approval consumption after writer death. Its exception-injected daemon adapter
failure is **not a daemon interruption**. Unit tests likewise use a fake daemon
adapter; their drift/failure results do not certify host behavior.

Success evidence is written exclusively only after all assertions and verified
disposal, and includes source SHA, runtime/image identities and explicit host
NOT VERIFIED fields. On failure no success evidence is produced. Public images
and build cache may remain. The top-level proof itself is not protected against
SIGKILL here; on interruption preserve records and remove only its exact recorded
disposable resources. Never run global prune or erase consumed state as recovery.

## Dedicated disposable-host fixture and later QA

The checked-in `systemd/` definitions are **uninstalled, unverified fixtures**.
Do not execute these privileged steps in this managed workspace or on a shared
machine. No host has been bought, provisioned or rebooted. Later owner-authorized
host QA needs a disposable Linux machine with no unrelated workloads, root,
systemd, Node 24 at `/usr/local/bin/node`, Docker systemd cgroups, disabled live
restore and the pinned built isolation image present. Use the exact QA SHA and
image ID; build using the existing pinned Dockerfile/locked dependencies and CA
secret. Do not point the fixture at a production image or database.

On that **separately authorized disposable machine only**, an operator can:

1. Copy the clean exact checkout (including `.git`) to `/opt/fort-custer-proof`,
   make its complete tree root-owned and non-group/world-writable. Provision
   `/etc/fort-custer-proof` and `/var/lib/fort-custer-proof/attempt` root:root 0700.
   Install a 0600 policy file with exactly
   `{"disposableOnly":true,"sourceSha":"<exact-QA-SHA>","imageId":"sha256:<built-ID>"}`.
   This is synthetic policy, never a real signer root or credential.
2. Review and copy the three definitions to `/etc/systemd/system/`; verify with
   `systemd-analyze verify` and `systemctl daemon-reload`. Enable **only**
   `fc18a-proof-recovery.service` for boot recovery. The job has no Install section.
   No timer, inbound port or schedule exists. Do not enable a publishing job.
3. Start `fc18a-proof-recovery.service`. An initially empty attempt reports
   `FENCED_EMPTY_DISPOSABLE_HOST; MANUAL_ARM_REQUIRED`. Confirm the slice is active,
   frozen and empty. For this first synthetic attempt only, manually write `0`
   to `/sys/fs/cgroup/fc18aproof.slice/cgroup.freeze`. There is no automatic thaw.
   Start `fc18a-proof.service` manually. Retain journal, unit properties,
   monotonic timestamps, receipt and actual cgroup/task paths before injection.
4. On distinct fresh disposable test hosts/fixture instances, test normal deadline
   (30 seconds), `systemctl kill --kill-whom=main --signal=SIGKILL fc18a-proof.service`,
   daemon stop/reconnect, delayed Docker start during fencing, and reboot after
   receipt/start. Verify `ExecStopPost` invocation, populated-zero, frozen-one,
   no surviving detached tasks, exact-ID absence after daemon recovery, immutable
   records retained, no automatic re-execution, and unaffected bystander outside
   the dedicated slice. Verify a start request cannot execute through the frozen
   parent even after cleanup returns. Do not create a bystander inside that slice.
5. Inject missing receipt, false labels, stopped stale container and cleanup
   failure. Expect STOP without guessing/removing unrelated resources. Fill only
   a separately bounded disposable filesystem to test ENOSPC, including stopped
   container storage; test permission failure and host power-loss persistence.
   These cases are not replaced by a mocked success result. Use fresh *synthetic*
   fixtures for separate scenarios, never restore spent production authority.
6. Recovery after reconnect uses the fixed `host-supervisor.mjs recover` command
   (or restart the recovery unit); it never runs the workload. Keep the slice
   frozen. Retain state/journal before reverting. Stop/disable the recovery unit,
   remove only the reviewed fixture units and reload systemd; preserve spent
   records. Destroy the disposable host only under its explicit disposal scope.
   Never weaken the fence, reset attempt state, or enable production to reuse it.

## Evidence and production gap matrix

| Boundary | Evidence in this sprint | Remaining production blocker / owner |
| --- | --- | --- |
| Real supervisor death | Docker proof kills an actual child supervisor; container survival and later parent recovery observed | Independent PID 1 cleanup after loss of *all* supervisor processes NOT VERIFIED; Systems/Security host QA |
| Whole-job deadline | Surviving-parent timer stops a real container, including bootstrap; detached-child teardown is separately observed before SIGKILL/recovery | systemd RuntimeMaxSec and complete-job cgroup path NOT VERIFIED; cannot label a Node timer durable |
| Daemon-independent kill/fence | Fixed freeze/kill/empty-check implementation and unit fixtures | Actual freeze/kill, late start fencing, slice persistence NOT VERIFIED; approved dedicated host needed |
| Daemon interruption | Injected adapter failures preserve STOP/spent state; reconnect cleanup only | Actual dockerd/containerd interruption, live-restore behavior NOT VERIFIED; no privilege to interrupt this daemon |
| Reboot and boot sweep | Fixed boot recovery unit, no restart job | Reboot, power loss, boot ordering and no-resurrection NOT VERIFIED; no shared-host reboot |
| Targeted orphan cleanup | Real stale job removed, unrelated container retained, second cleanup idempotent | Missing receipt/drift intentionally STOP; independent exact-host review required |
| Spent authority / audit | Exclusive fsynced local records; actual central claim retained after supervisor kill; 3 claims/1 maze/1 audit | Local state is rollbackable; single-member Mongo and admin disposal are not global restore resistance or WORM; 1.8C |
| Disk/permissions | Real malformed/private-file regressions; command/output bounds; stopped jobs promptly removed | Full disk, stopped writable-layer quotas, power-cut/fsync durability and host log quota NOT VERIFIED; mount/quota and alarm acceptance |
| Source and image | Exact base and proof SHA, clean archive, pinned bases/runtime image ID and content measurement; fixed root policy fixture | Owner-approved merged image digest, supply-chain provenance, immutable installed source, real host ownership NOT VERIFIED; 1.8B |
| Generator/container boundary | Existing actual no-network/no-secret, UIDs, seccomp, capabilities, read-only root, memory/CPU/PID pressure regressions | Repeat on approved kernel/daemon; worst-input budget and patch baseline acceptance |
| Writer credentials and privileges | Existing synthetic UID 10002 and authenticated exact-collection denial proof | Real short-lived credential delivery and effective Atlas privilege attestation absent; 1.8B |
| Atlas TLS/discovery/egress | None: fixture uses local Unix socket only | Complete topology IPv4/IPv6/TLS/CA/hostname/DNS/metadata deny policy absent; 1.8B |
| Target metadata and DDL | Existing UUID/index/options fingerprints and adversarial index checks | External administrator DDL fence and production validator acceptance absent; 1.8B |
| Owner identity and release/date | Existing synthetic signature and single-submit/uncertain-ACK regressions | Real offline distinct roots, approved date/window/release and broker receipt absent; no date chosen |
| Activation and rollback | Live-block implementation/config unchanged, contract and regression checks | Fresh manifest PENDING, live apply unconditional blocked, no client #54 merge, Railway/Vercel promotion or v2 activation; separate owner GOs |
| Operational trust | Fixed manual fixture, no new dependency or control plane | Dedicated host ownership, patching, backup retention, alarms, read-only recovery credential and independent exact-head QA pending |

Full existing production requirements remain in [THREAT-MODEL](THREAT-MODEL.md),
[ADR-001](ADR-001-ISOLATED-PUBLISHER.md) and [RUNBOOK](RUNBOOK.md). This table adds
lifecycle detail; it does not waive any prior gate. Independent Systems/Security
QA must review the exact final PR SHA and return PASS / PASS WITH CONDITIONS /
FAIL, distinguishing source acceptance from missing host proof. Source review or
merge cannot certify an untested host or authorize activation.

## Cost and routine operations

No infrastructure was provisioned and no purchase is proposed by this PR.
Incremental source dependencies/control-plane services: zero. Keep the previous
planning allowance: existing **dedicated** host $0 incremental rental, or a small
VM approximately $5–12/month plus $1–3/month backup/log storage. Electricity,
egress, immutable retention, alarms and Atlas/private networking are additional;
do not assume a free shared development machine meets the trust boundary.

Allow roughly half a day to two days for initial host/fence/recovery QA and
hardening, then 30–60 minutes/month for ordinary patch/backup checks plus urgent
kernel/daemon fixes, topology drift and incidents. These are planning estimates,
not observed labor or vendor quotes. Retained spent records/logs need bounded
growth and alerts; never reclaim disk by deleting authority. A stopped writable
layer can consume disk even after tmpfs jobs stop: set approved backing-store
quotas and exercise ENOSPC before production. Keep monthly patching, urgent
security updates and periodic disposable recovery drills under one named owner.
The small VM remains cheaper and easier to audit than a new broker/orchestrator
fleet, provided the owner accepts these maintenance duties and all later gates.
