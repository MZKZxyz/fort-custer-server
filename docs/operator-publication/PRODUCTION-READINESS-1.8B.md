# Sprint 1.8B: first-publication decision packet

**Decision requested: accept the preparation plan; production NO-GO.**
Scope: [#31](https://github.com/MZKZxyz/fort-custer-server/issues/31), parent
[#28](https://github.com/MZKZxyz/fort-custer-server/issues/28). Fetched `main` on
2026-10-29 matched `726846fb1b12a52b83a7137795d596530af9c12e`; no drift.

Docs only. `applyProduction()` and `maze:operator apply` remain unconditionally
`LIVE_APPLY_BLOCKED`; fresh release remains PENDING. No production access, keys,
credentials, host, date, deployment or schedule is authorized/created. Railway
`8e3eac84f7081f3b1a51df317b35f782d64561db`, auto-update OFF and client #54
draft/unmerged are dispatch baselines, not newly inspected live state.

## 1. Hosting decision and cost

**Default:** one isolated DigitalOcean Basic Regular x86 VM, 1 vCPU / 2 GiB /
50 GiB, supported Ubuntu LTS, systemd PID 1, unified cgroup v2, Docker systemd
cgroups. Keep it outside Railway's application/secret environment. Build elsewhere;
prefetch an approved immutable image. Manual sequential generator/writer jobs;
no inbound application port, scheduler or control plane. Key-only SSH restricted
to owner-approved sources. Jobs receive no host/cloud administration credentials.

**Fallback:** existing exclusively dedicated Linux hardware passing the same
acceptance tests, with reliable power, console recovery and stable public egress.
Availability is UNKNOWN; a shared workstation/daemon is ineligible. If neither
option qualifies, remain NO-GO.

| Option | Actual capability / limitation | Operations and recovery | Monthly cost |
| --- | --- | --- | --- |
| Isolated VM (default) | Guest systemd, cgroup v2 and nftables are available technologies; actual H1–H4 enforcement must pass. Stable public source IP to Atlas. Provider/root/kernel/daemon trusted. | Owner patches OS/Node/Docker monthly and urgently for security fixes; checks disk/time/retention. Provider console recovers SSH. Restore starts fenced, reconciles only. | $12 compute + optional $2.40 weekly backup = **$14.40 host subtotal** [P1–P2]. |
| Existing dedicated hardware | Same controls only if measured. Residential dynamic IP/CGNAT can disqualify Atlas connectivity. | Owner also maintains power/router/disks/physical access and offsite recovery. Same patching and no automatic rerun. | $0 new rental if available; measured kW × powered hours × owner's tariff, ISP/static IP, replacement and offsite storage remain UNKNOWN. |
| ECS Fargate per-run tasks (not selected) | Provider patches hosts. Separate tasks/IAM/VPC possible, but no guest PID 1 or this slice freeze/kill implementation. Requires new watchdog/late-start/network-isolation proof. | More IAM/task/image/log/watchdog setup; task-stop/provider recovery semantics cannot inherit 1.8A attestation. Stable Atlas egress still needed. | Two minimum 0.25-vCPU/0.5-GiB tasks: ~$0.0004115 compute/run, ~$0.01235/30 runs **before** networking/logs/registry/authority [P3]. |

Fargate reduces patching but increases this game's implementation/verification
burden; it is a future redesign, not the fallback. A separate Railway job does not
establish these host guarantees. The 2-GiB sizing leaves OS/daemon headroom; it is
judgment, not measured capacity. Downsize to $6/1 GiB only after worst-input QA.

Public USD list prices checked **2026-10-29**, no credits assumed:

| Evidence | Observed rate / calculation |
| --- | --- |
| P1: [DigitalOcean bundled Basic Regular](https://www.digitalocean.com/pricing/droplets) | 2 GiB $12/month ($0.01786/hour), 1 GiB $6/month; bundled public IPv4 included. No setup fee listed. Region/availability/tax must be checked before purchase. |
| P2: [DigitalOcean backups](https://docs.digitalocean.com/products/backups/details/pricing/) | Weekly percentage plan 20%: $12 × 20% = $2.40/month. First full month with backup: $14.40. Backup is recovery convenience, never consumption authority. |
| P3: [Fargate](https://aws.amazon.com/fargate/pricing/), N. Virginia Linux x86 example | $0.000011244/vCPU-second + $0.000001235/GiB-second; minimum 60 seconds. Two tasks: 2 × 60 × (0.25 × CPU rate + 0.5 × RAM rate). Image download/startup can increase duration. |
| P4: [AWS VPC](https://aws.amazon.com/vpc/pricing/) | IPv4 $0.005/hour = $3.65/730h; Ohio NAT example $0.045/hour = $32.85/730h plus $0.045/GB and IPv4. No NAT proposed for the VM. |

**$14.40 is not the complete production bill.** Excluded: existing Atlas/API/client
charges, tax/overages, key/backup media, broker/audit/alerts, build/registry storage.
Account/tier/region facts are unknown. 1.8C must quote authority/audit retention
before spending GO; the ADR's earlier $1 broker allowance is unverified.
Propose 30-day/100-MiB capped local journal and 90-day redacted off-host diagnostics.
Separately immutable receipts must outlast all accepted restore/replay horizons;
owner approves retention/cost. Never truncate spent authority to fit log quotas.

Owner names operator/recovery contacts. Planning labor: 0.5–2 days initial
hardening/drills, 30–60 minutes/month patch/restore checks, plus incidents.
Missing days remain holes while the operator is unavailable.

## 2. Ordered owner gates

Systems = infrastructure engineer; Security/Operations = independent QA and named
operator. Owner may operate the game, but another reviewer performs independent QA.

| Order | Responsible / separate owner approval | Acceptance / failure condition |
| --- | --- | --- |
| G0: design | Systems + independent Systems/Security/Operations QA; owner source-only PR acceptance | Exact head, recommendation, tests and unresolved gates. Merge neither unlocks live apply nor dispatches 1.8C. |
| G1: host | Owner chooses hardware or VM/account/region and spend cap | Approve rental, optional backup and disposable QA-host costs **before** purchase. No host availability assumed. |
| G2: enforcement | Owner authorizes synthetic installation/fault drills; Systems executes, Security/Operations witness | H1–H4 evidence below. Missing/simulated observations remain NOT VERIFIED and block production. |
| G3: Atlas/identities | Owner authorizes narrow metadata/network observation, roles and credential provisioning; Security verifies | Exact target/topology, effective grants, TLS/egress and DDL fence. Unknown tier/support/fence = NO-GO. No history/player inventory needed. |
| G4: build/roots | Owner approves resulting merged commit, image and public roots; Systems measures | Signed release and independent verification below. CI success, tags and source labels alone FAIL. |
| G5: 1.8C | Separate dispatch/review; owner later approves authority/audit account, identity, retention and spend | Global nonrollbackable claim, immutable audit and restore/replay/unknown-ACK tests. Not implemented/dispatched here. |
| G6: first publication | Owner separately approves UTC date/window, release/plan, API deployment, single insert, client promotion | All gates, reviewed future live adapter, fresh-compatible rollback and alert/recovery contact ready. No date selected here. |
| G7: recurring operation | Separate owner schedule/authority approval after one-date results | No earlier gate enables cron/timer or tomorrow's authority. |

## 3. Host acceptance

Read-only observations on an already authorized selected host:

```sh
uname -r
ps -p 1 -o comm=
systemd --version
stat -fc %T /sys/fs/cgroup
cat /sys/fs/cgroup/cgroup.controllers
docker info --format '{{.CgroupVersion}} {{.CgroupDriver}} {{.LiveRestoreEnabled}}'
systemctl cat fc18a-proof.service fc18a-proof-recovery.service fc18aproof.slice
systemctl show fc18a-proof.service -p Type -p RuntimeMaxUSec -p TimeoutStopUSec -p KillMode -p Restart -p ExecStopPost
systemctl show fc18aproof.slice -p ControlGroup -p StopWhenUnneeded -p RefuseManualStop -p Delegate
```

Expect systemd PID 1, cgroup2fs, memory/cpu/pids controllers, `2 systemd false`.
Missing units = NOT VERIFIED, not permission to install. After later approved
synthetic installation, inspect exact slice `cgroup.freeze`, `cgroup.kill`,
`cgroup.events`, controller limits and each container PID's `/proc/<pid>/cgroup`.
Retain kernel/daemon/image/unit hashes, ownership/modes and journals; never dump
credentials or Docker environments. Kernel version/configuration alone is no proof.

The [1.8A synthetic fixture](HOST-LIFECYCLE.md#dedicated-disposable-host-fixture-and-later-qa)
remains uninstalled: `Type=exec`, `RuntimeMaxSec=30`, `TimeoutStopSec=25`,
`KillMode=control-group`, `Restart=no`, `ExecStopPost`; separate persistent
`fc18aproof.slice`, `StopWhenUnneeded=no`, `RefuseManualStop=yes`, no delegation,
no job enabled at boot. Containers are outside the supervisor service cgroup;
service death alone cannot kill them. Recovery must freeze/kill/observe the slice
**before** daemon/state work and retain the freeze after failure.

| Test / owner | Later separately authorized disposable-host drill: required observation | Failure |
| --- | --- | --- |
| H1 resources / Systems + Security | Repeat fixed tree workload and isolation proof on selected kernel: actual descendant cgroups, memory OOM/zero swap, PID-limit events, CPU throttling, seccomp/no-new-privs/capability drop, read-only root, no-network generator. Outside-slice bystander unaffected. | Missing controller, escaping task, secret/socket inheritance or config-only evidence. Fixture job 256 MiB/32 tasks/0.5 CPU and slice 384 MiB/64 tasks are not approved production budgets; benchmark worst inputs. |
| H2 death/deadline / Systems + Operations | Separate fresh instances: 30s expiry and supervisor SIGKILL **without surviving-parent recovery**. PID 1 invokes stop; monotonic timestamps show bounded cleanup (separate 25s stop budget), `frozen 1`, `populated 0`, no descendants. | Node-parent cleanup substituted for PID 1; remaining tasks, missing stop or exceeded reviewed timing. Kernel stalls mean STOP. |
| H3 daemon/late start / Systems + Security | Separately interrupt dockerd/containerd; delayed start cannot execute through retained frozen parent. Fence works without daemon; reconnect removes exact receipt ID only after validation. | Mock adapter failure, thawed/disappeared slice, late execution, broad prune or bystander removal. Missing receipt/drift intentionally quarantines. |
| H4 boot/disk/power / Operations | Reboot after receipt/start; separately power-cut disposable host; ENOSPC in bounded disposable filesystem including stopped layers. Observe boot fencing before work, retained spent/STOP, no restart/thaw, read-only recovery, bounded storage and off-host recovery. | Authority reset, lost accepted claim, auto-rerun, unwitnessed boot ordering/quota or no actual power-loss test. |

**Selected-host H1–H4 remain NOT VERIFIED.** Prior 1.8A Docker evidence is synthetic,
not this host's attestation. Keep credentials unavailable at boot until recovery
passes; restore fenced, consulting external spent authority. Malicious root,
kernel stalls and power loss cannot be solved by a Node timer.
References: [systemd service](https://www.freedesktop.org/software/systemd/man/255/systemd.service.html),
[kernel cgroup v2](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html).

## 4. Atlas least privilege and connection contract

`<approved-db>.mazes` is a placeholder, not a selected production target. Future
owner provisioning uses Atlas management, not live mongod `createRole`. Review
**effective union** of direct/inherited roles, cluster restrictions and propagation;
no `readWrite`, `dbAdmin`, wildcards, `anyDatabase`, player/claim/audit grants.
Verify actual Atlas tier/custom-action support before promising these roles.

| Identity | Intended privileges / operation | Residual scope |
| --- | --- | --- |
| One-attempt writer | Exact `mazes`: `find`, `insert`, `listIndexes`. One native UUID-bound insert; primary/majority exact-date read, limit 1; majority write, finite budgets, no driver/app retries or Mongoose auto-index/create hooks. | RBAC cannot enforce one document/date/window or restrict `find` to one date. |
| Reconciler | Exact `mazes`: `find` only; original signed date/UUID/content/provenance; metadata from inspector. | No insert, new claim, alternate day or reset; permission itself allows broader collection reads. |
| Independent metadata inspector | Database `listCollections` on `{db:<approved-db>,collection:""}`; exact `mazes` `listIndexes`; no data find/write. Never mounted in jobs. | Full database metadata visibility requires owner approval; exact-name filter narrows procedure, not permission. |

`authorizedCollections:true,nameOnly:true` supplies names/types, **not UUID or
validator**. Full inspection needs database metadata permission. Default to the
separate inspector; combining that permission into writer requires broader-scope
approval and adapter review. Bound/close cursors: one collection, ≤16 indexes,
existing 64-KiB metadata bound; refuse unsupported BSON. Inspect UUID, full options
including validator/validationLevel/action/collation, complete ordered indexes,
app indexes and exact unique date semantics before claim and immediately before
submit. Pin all fingerprints; they detect change but do not fence concurrent DDL.

| Synthetic denial test | Expected |
| --- | --- |
| Writer/reconciler update/replace/delete/upsert/findAndModify, create/drop index, collMod/drop/rename, users/roles, players read/write, claim/audit modification, bypass validation; reconciler insert | Unauthorized code 13, unchanged data. Check inherited grants. |
| Writer full listCollections; inspector maze data read | Unauthorized. Names-only enumeration may succeed without full metadata. |
| Writer second date, bulk insert, implicit collection recreation | **Not prevented by insert RBAC.** A compromised writer can recreate dropped `mazes` without its indexes/validator. One-submit code, authority and DDL fencing are required. |

DDL freeze: owner inventories every administrator/automation/migration actor,
suspends DDL jobs and removes/locks away usable DDL authority throughout
inspection→claim→insert→verification. Operations records start/end; independent
owner witness verifies the freeze. Any unfenced actor = NO-GO. No automatic DDL
repair. UUID client policy is not server RBAC. Atlas/provider admins remain trusted.

Unique short-lived SCRAM secret per attempt, separate from live API; protected
0600 tmpfs/descriptor delivered read-only only to writer UID, never argv/chat/Git/
.env/logs. Atlas temporary users expire within a configurable seven-day period,
not an exact subminute capability. Require approved expiry, prompt revoke after
stop/uncertainty, unmount and verified session termination; test revocation
propagation/existing sockets. Issue independent reader-only recovery access.

Future production transport requirements (no implementation here):

1. Owner pins project/cluster identity, replica-set name, exact database and **full**
   member FQDN/port list. Explicit reviewed seeds, full replica-set discovery;
   never production directConnection to hide members. Every socket validates CA
   chain and hostname/SNI. Reject `tlsAllowInvalid*`, `tlsInsecure`, custom TLS
   callbacks/CA and request/URI/SRV/environment/proxy overrides. CA alone does not
   identify the intended deployment.
2. Trusted host resolves all member A/AAAA before releasing credentials. Freeze
   per-attempt mapping in read-only writer resolver configuration; no job DNS,
   proxy or inherited sockets. Host nftables denies other IPv4/IPv6 TCP/UDP paths,
   including metadata/link-local/host paths, covering Docker forwarding and host
   output. No broad established-flow exception; test actual packets.
3. Include monitoring sockets: driver may open two extra per member/client beyond
   application pools. Unknown member/re-resolution is STOP; firewall/controlled
   resolution must deny its **first connection**, not rely on driver events.
   End before mapping TTL expiry; topology/IP changes require reviewed refresh,
   never wildcard/automatic expansion or uncertain-write retry.
4. Atlas inbound source list is separate: default stable VM IPv4 /32; disable
   writer IPv6 unless reviewed AAAA destinations and /128 source are approved.
   Never `0.0.0.0/0` or `::/0`. Atlas public IPs change; exact topology is unknown.
   Free/Flex lack private endpoints; a DigitalOcean VM cannot simply attach AWS
   PrivateLink. Any private route/tier redesign needs separate cost/owner approval.
5. One sequential operation supports proposed maxPoolSize 1/minPoolSize 0; this
   does not mean one total socket. Disable retryReads/retryWrites. Measure all
   connections and command/selection/connect/queue/socket timeouts within the hard
   whole-job budget; loopback 2–3s settings are not production latency evidence.

Safe rehearsal: owned disposable MongoDB/loopback and synthetic users/data only;
reuse `test:operator`, `test:operator-isolation` and opt-in authenticated Docker
proof. Before G3 add metadata-split/recreation cases above, then an owned TLS
multi-member fixture: wrong CA/hostname/set, unexpected discovery, A/AAAA rebinding,
failover and monitoring sockets. Those additional cases remain **NOT VERIFIED**;
Unix-socket fixtures prove no Atlas/TLS behavior. No new fixture is needed merely
to enlarge this docs-only PR.

Primary sources read 2026-10-29: [privileges](https://www.mongodb.com/docs/manual/reference/privilege-actions/),
[listCollections](https://www.mongodb.com/docs/manual/reference/command/listcollections/),
[Atlas roles](https://www.mongodb.com/docs/atlas/security-add-mongodb-roles/),
[temporary users](https://www.mongodb.com/docs/atlas/security-add-mongodb-users/),
[driver pools](https://www.mongodb.com/docs/drivers/node/v6.x/connect/connection-options/connection-pools/),
[network changes](https://www.mongodb.com/docs/atlas/reference/faq/networking/),
[private endpoints](https://www.mongodb.com/docs/atlas/security-private-endpoint/).

## 5. Source, image and distinct signing authority

1. Owner approves the **resulting merged commit**, not premerge PR SHA. Trusted
   clean builder uses exact archive/lockfile, pinned base digests/tool versions,
   disabled install scripts, no secret/dirty context. Record source/dependency
   measurement, lockfile/recipe hashes, arguments, builder identity and logs.
2. Record immutable registry OCI digest, platform digest and local image ID
   separately. Owner reviews provenance and signs release binding merged source,
   digests/measurement, limits/policy, target and fresh release decision. CI success,
   repository workflow, image label/tag cannot confer owner approval.
3. Owner installs public roots/fingerprints and immutable verifier policy out of
   band. Before job creation verify signature, merged SHA, digests and installed
   measurements; repeat on restore. Reject substitution, changed policy/root,
   duplicate key material and cross-role signatures. Existing strict canonical
   Ed25519 rules remain; rehearsal envelope kinds confer no live authority.
4. Separate publication signature binds exact preview/solver result, plan/release/
   image hashes, target UUID/index/options, attempt ID, UTC date and finite window.
   Require both signatures; release approval alone cannot authorize insertion.

Two distinct offline Ed25519 identities, even if owner holds both: different IDs
**and canonical public material**. Private keys encrypted on offline media, with
separate encrypted recovery copies/passphrases; never build/CI/host/container.
Witness fingerprint installation; test recovery with synthetic keys first.
No real key/image creation, installation or production signing in 1.8B.

Rotation/recovery: pause, owner approves versioned root set/role/activation and
retiring IDs out of band; independently verify installation. Retain old public
roots for audit, revoke for new operations; re-review affected unspent plans.
Compromise/loss means quarantine, credential revoke, preserved claims and reader-only
reconciliation, trusted rebuild and owner root recovery; never reset authority.
Matching digests prove identity, not an honest build or host. Builder, bootstrap/
verifier, owner signing device, host root/kernel/daemon remain trusted assumptions.

## 6. 1.8C and separately approved one-date cutover

1.8C must review atomic global approval-ID **and logical namespace/date** consumption
bound to immutable intent: no TTL/reset/reuse across hosts, clones, restores or
collection recreation. Continue the [ADR broker/DynamoDB + S3 Object Lock option](ADR-001-ISOLATED-PUBLISHER.md#global-authority-audit-uncertainty),
not another orchestrator. Pin account/region/resource identity; reject restore
aliases; runtime cannot delete claims. Independently retain intent **before submit**,
then result/uncertainty audit with verified retention. Cost/IAM/restore threat
model remain OPEN. Supervisor contacts broker/audit over separately scoped HTTPS;
writer receives validated receipt and retains Atlas-only egress. This is future work.

Acceptance: concurrent hosts get one claim; local rollback/authority restore cannot
free date; unknown claim ACK allows **zero** maze submits; acknowledged claim allows
at most one. Unknown write ACK, expiry, audit failure or host loss stays spent.
Reader-only exact majority verification can prove a winner; missing/failed read
remains uncertain. No read-to-retry, alternate seed/day or backfill.

After all gates, owner separately authorizes each step:

1. Pin fresh-compatible Railway API upgrade and separately reviewed approved fresh
   manifest; auto-update/v2 OFF. Empty Today acceptable. API precedes insert:
   old API could expose grids without fresh admission/rankings enforcement.
2. Approve exact UTC date/notBefore/exclusive expiresAt, release/image, target and
   signed plan. Operator verifies host/roots/DDL freeze/audit/claim and performs
   one authorized insert plus exact UUID/content/provenance majority verification.
   A future reviewed live adapter is required; this packet cannot unblock apply.
3. After API smoke, approve client #54 combined-tree QA/merge and Vercel promotion.
   Correct legacy 2025 controls/labels; test new/cached bundles, service-worker
   refresh and old session UUID completion/retry without duplicate reward or
   receipt loss. No silent session reset.
4. Operations verifies first-day/hash, missing-day behavior, old-date refusal,
   archive/rankings/owner projection, owned start/complete/original-UUID retry and
   v2 OFF immediately and at next UTC rollover. Establish alert contact/delivery
   before GO; watch host/API/client and retained reports. Alert on STOP/deadline,
   drift, missing day, collision, uncertainty, credential misuse or audit failure.

| Failure | Recovery / owner decision |
| --- | --- |
| Unknown claim ACK | Stop/fence, retain evidence, no write; later observation never mints GO. |
| After claim: timeout, daemon/host/disk/TLS failure, unknown insert ACK | Fence, revoke writer, retain spent state/audit; separately approved reader reconciles original intent only. Missing winner remains uncertain. |
| Winner verified, result audit failed | Preserve maze/intent; integrity incident pending retained audit, no second insert. |
| API/client fault | Owner isolates traffic or rolls code/client to tested **fresh-compatible image with same release identity**, accounting for caches/UUIDs/receipts. Old `8e3eac84` is not routine fresh-era rollback. |
| Bad published date/content | Permanent integrity incident. Stop traffic/publication as directed; never delete/update/upsert/reseed/substitute date/reset authority. |

## 7. Evidence and remaining decisions

Executed on Node 24.19.0: **30 operator / 16 isolation / 48 lifecycle tests pass**;
frozen contract matches; unconditional live-block/PENDING and 125 JS/MJS syntax
checks pass. Initial sandbox runs failed from loopback/subprocess restrictions;
authorized local-fixture rerun passed without source changes. Full server suite
and opt-in Docker proof were not rerun for docs-only work. Selected-host H1–H4,
production Atlas/TLS/egress/DDL, real roots/provenance and immutable authority/audit
remain NOT VERIFIED. PR/issue report records final SHA, files and links/diff checks.

Independent Systems/Security/Operations QA must return PASS / PASS WITH CONDITIONS /
FAIL on the **exact draft PR head**, for nonproduction design only: feasibility,
prices, privileges/DDL/TLS, key custody, uncertainty and rollback. Re-review changes.

Owner still chooses host/spend, operator/recovery contact, target tier/topology,
metadata visibility/DDL owner, build/key custody, separate 1.8C scope/retention
budget; later exact date, one publication, Railway upgrade, client/Vercel promotion
and eventual schedule. Stop at draft PR/report. **Production remains NO-GO.**
