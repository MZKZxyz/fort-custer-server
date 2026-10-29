# One-shot publisher threat model and gap matrix

Scope: issue #26, disposable proof only. Assets are permanent maze integrity,
single-use owner authority, source/key identity, credentials and retained intent.
Attackers include malicious operation inputs, modified source/dependencies, a
compromised generator, concurrent/replayed requests, resource overruns and lost
ACKs. Host root/daemon/kernel, owner signing devices and the approved authority's
administrators are trusted. A compromised writer can exercise its effective DB
rights; this prototype is not a malicious-writer-resistant capability DB.

| Threat / boundary | Executable fixture evidence | Production gap / required next evidence |
| --- | --- | --- |
| Generator exfiltration, TCP/DNS/metadata access | `network=none`; only loopback interface; direct IPv4/IPv6/metadata connection probes fail, DNS resolver fails; no secret/socket/policy mounts | Verify same kernel policy on approved host, including UDP, topology proxy absence and no inherited sockets. Host root can override policy. |
| Writer egress and credentials | Distinct UID 10002; no IP/DNS network, read-only Mongo socket and 0600 fixture auth mount; generator UID 10001 cannot see either | Atlas TLS and complete discovery/egress policy unimplemented and untested. Unix socket is not a production Atlas transport or TLS proof. |
| Resource overrun / child escape | cgroup memory OOM, zero-swap setting, CPU throttling, PID-limit event; read-only root and bounded tmpfs; dropped capabilities, seccomp/no-new-privs status; external kill stops PID namespace with detached child | Approved host cgroup delegation, seccomp policy review, worst-input budgets; durable host deadline and cleanup after supervisor death/reboot missing. CPU quota throttles; wall deadline bounds total work. |
| Tampered source, substituted image | Clean Git archive and SHA; runtime image ID pinned by supervisor; full app/dependency measurement; changed engine in derived image refuses; signed wrong SHA refuses | Owner-approved merged SHA/registry digest and independent build provenance absent. Self-measurement cannot attest hostile bootstrap/host. Runtime image still contains OS utilities, though shell paths are removed and entrypoint fixed; production image minimization needs review. |
| Forged signature, caller trust roots | Existing canonical Ed25519 verifier; distinct release/publish keys; mounted public fixture roots, no roots in requests; bad signature/wrong source/signed bad candidate refused | Real owner identities/roots/offline signing and full 1.7H date/window/release artifacts not provisioned. Fixture signatures have no human or production authority. |
| Broad database privilege | Actual authenticated denials: update/delete mazes, createIndexes, collMod, players read, delete claims, update audit; reader denied insert | Verify effective Atlas inherited privileges, metadata visibility and short-lived credentials separately. `insert` permits arbitrary docs to a compromised writer; a role does not constrain exact date. |
| Namespace/schema/index substitution | Exact collection UUID and options/index fingerprint; actual index addition refuses before claim; UUID-bound insert | External concurrent DDL fence missing. Metadata fingerprint alone does not close TOCTOU. Full Atlas validator semantics require review. |
| Replayed approval and cross-process contention | Two independent containers contend on central insert-only intents with unique approval ID and namespace/date indexes; exactly one winner; fresh container replay refuses | Multi-node durability, independently administered nonrollback authority and recovery/retention missing. Fixture claim role cannot erase records, but fixture admin can. |
| Unknown claim ACK | Fault after actual acknowledged intent insert reports uncertainty, makes no maze insert; approval/date stay spent | Real cross-service partition, broker receipt and shutdown handling need independent tests. No read-to-retry recovery. |
| Unknown maze ACK | Fault discards actual insert ACK; exact majority read reports reconciled winner; reader-only account recovers; one document remains | Real Atlas latency/primary failover tests missing. Existing 1.7H tests preserve actual Mongo failpoint/connection-loss coverage. |
| Audit unavailable or copied local ledger | Intent is the central claim document; result is insert-only; jobs use no local ledger; central counts verified | Immutable external retention, audit failure alarms and administrator recovery are design only. Single-member majority is not multi-node durability or Object Lock. |
| Production activation via fixture | No live imports changed; full existing operator suite retains unconditional `LIVE_APPLY_BLOCKED` | Every production gate remains closed. No environment/config toggle may replace later reviewed implementation and explicit owner authorization. |

NO-GO until **all** production gaps above have an approved implementation and
independent pinned-head Systems/Security QA. Absence of infrastructure evidence
is a blocker, not a skipped passing test. Do not weaken the host sandbox, use
privileged containers, mount the daemon into a job, or relabel fixture policy as
production policy to fill gaps.
