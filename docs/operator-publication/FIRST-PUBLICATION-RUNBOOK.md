# First publication: separately authorized one-date cutover

**NOT EXECUTABLE AUTHORIZATION. Production NO-GO.** No first UTC date is selected.
Issue [#33](https://github.com/MZKZxyz/fort-custer-server/issues/33), parent #28.
Read [1.8B prerequisites](PRODUCTION-READINESS-1.8B.md) and
[1.8C authority/audit decision](ONE-USE-AUTHORITY-1.8C.md) first.
`LIVE_APPLY_BLOCKED` remains unconditional; `config/fresh-release.json` PENDING.
A future separately reviewed live adapter is required; never relabel fixture modes.

Owner = resource/release decision maker; Operator = named executor/on-call contact;
QA = independent Systems/Security/Operations reviewer. The following are separate
written owner GOs, not permissions conveyed by source merge or this runbook.

## Ordered GO/NO-GO checkpoints

| Step / owner decision | Executor / independent verifier | Exact evidence and STOP condition |
| --- | --- | --- |
| 0. Accept source/fixture only; authorize later preparation scope/spend | Owner / QA | Exact merged SHA, reviewed tests and open controls. Choose default DynamoDB + independently retained S3 audit or separately proved fallback, region/accounts/custodian/retention and full budget. No resources authorized here. |
| 1. Select and verify dedicated operator host | Operator + Systems / QA | Owner-authorized host installation/failure drills, 1.8B **H1–H4** signed evidence: actual PID1 deadline after supervisor death, separate slice freeze/kill/late-start fence, daemon interruption, reboot/power-loss/ENOSPC, logs and exact-ID cleanup. Missing proof = NO-GO. Restore is fenced/reconcile-only. |
| 2. Approve trusted source/image and offline roots | Owner + build operator / Security QA | Resulting merged commit, clean archive/lockfile/base/tool digests, image/platform digests and measurements, build provenance; witnessed out-of-band public-root fingerprints. Distinct offline Ed25519 release/publish keys, tested synthetic rotation/recovery; no private key on host/CI/container. Rehearsal signatures never authorize live writes. |
| 3. Authorize Atlas observation/network/identity/DDL fence | Owner + DBA/Operator / Security QA | Exact deployment/namespace/UUID/full index/validator hashes; required unique date/archive indexes; effective writer find/insert/listIndexes, separate metadata inspector, reader-only recovery. Actual CA/hostname/full replica discovery and IPv4/IPv6 socket-denial proof including monitors. Owner/independent witness fences every DDL administrator/job for preflight→verification. Unknown actor/tier/permission/endpoint = NO-GO; no auto-DDL repair. |
| 4. Approve authority and independently retained audit | Owner + authority/audit custodians / QA | Pinned account/region/table **TableId**, broker and bucket/versioning/retention/epoch; actual two-key transaction races, unknown ACK, retry denial, denied runtime deletion/reset and restore tests. Exact compliance-locked intent/result VersionIds/checksums/retention, independent recovery control. Agree broker/admin residual trust in decision packet. Model tests alone FAIL this gate. |
| 5. Authorize fresh-compatible Railway API deployment **before any insert** | Owner + API operator / QA | Choose future release identity/date/window in draft (still no publication authority), separately review/approve fresh manifest and pinned postmerge deployment image. Keep auto-update OFF, v2 OFF. Verify deployed SHA/config/root/readiness and tested fresh-compatible rollback image. Empty Today/archive is acceptable; legacy-date starts must be refused. Old live `8e3eac84` lacks fresh behavior and is not routine rollback. No insert if API smoke fails. |
| 6. Authorize one future UTC date and exact signed preview | Owner offline signers / QA | Owner finalizes/reconfirms future date and notBefore/exclusive expiresAt; finite ≤24h window, synchronized clock. Review exact version/seed/full config, grid/content/provenance hashes, solver/difficulty, source/image/limits, target metadata, stable logical namespace, resource identity, attempt/approval UUIDs. Bind fresh manifest/release signature and separate one-date publish signature to exact plan. No wildcard/tomorrow/backfill; if backend deployment required selecting date earlier, this final signature still waits for Step 5 smoke. |
| 7. Authorize one submission in attended window | Owner + Operator / QA witness | Reverify pinned host/build/roots/target/privileges/DDL/time; original approved artifacts, no secrets in reports. PREPARED external intent → one atomic consume → ACK-bound retained INTENT version → final window/target check → **one** UUID-bound native majority insert, all retries off. Independent hard deadline covers whole job. Any uncertain claim ACK means zero insert; no resumed receipt from restored host. |
| 8. Verify outcome and retain evidence | Operator + separate reader identity / QA | Exact primary-majority date/UUID/content/provenance matches original intent, retained result and receipt hashes. Confirm one stored maze, no alternate day. No history/player scan. Missing/conflicting/unreadable winner remains uncertain; unknown ACK never retries. Failed audit means incomplete release even if winner verified. Retain spent keys and alert owner. |
| 9. Approve client #54/Vercel promotion after backend smoke | Owner + client operator / independent client QA | Verify exact final client combined-tree SHA, archive routes/labels/year controls, fresh date handling and backend compatibility before merge/promotion. Test warm/cold/cache/offline PWA, service-worker refresh/update, queued old tab, existing profile/session UUID and original completion retry; no duplicate rewards/receipt loss/session reset. Client #54 stays draft/unmerged in this sprint. |
| 10. Accept first-day observation; consider later schedule separately | Operator / QA + Owner | Immediate and next UTC rollover smoke, delivered alerts and handoff to recovery contact. Missing days stay unavailable, no substitution/backfill. A daily scheduler requires new reviewed recurring authority and a separate owner GO; one-date signature does not authorize tomorrow. |

Step 5 can require a draft future launch date to approve the fresh API manifest;
that owner choice occurs only in a later approved operation. Step 6 is the final
publication signature after API acceptance. If any timing/preview/target changes,
stop and review new artifacts rather than editing signed bytes or reusing claims.

## Smoke, monitoring and rollback contract

API smoke uses separately authorized owned test accounts/scopes: deployment
SHA/readiness, missing Today, legacy-date refusal, archive/rankings/owner-only
projection, v2 OFF; after verified publication add exact first-date/hash and
start/complete/original-UUID retry with no duplicate reward. Use a pre-agreed
traffic pause if needed; old API must not expose a new grid before fresh guards.

Before GO, name primary/recovery contact, communication channel and maximum
attended window. Test delivery of broker-error, unresolved-intent/missing-result,
audit/retention/denied-access, host deadline/resource/drift, API/client-error and
missing-day alerts. Retain redacted reports immediately and at first UTC rollover.
The cost model includes two custom metrics/four alarms; map signals to those
aggregates/native metrics explicitly before purchase, reprice extra monitoring.
No monitor or schedule is installed by this sprint.

| Incident | Immediate action | Recovery and owner disposition |
| --- | --- | --- |
| Before claim, invalid/expired signatures, target/resource/time drift | Stop; no submit. Keep PREPARED/error evidence where available. | New reviewed owner artifacts may be needed; no automatic alternate date. |
| Claim timeout/unknown ACK or worker death after consume | Fence/revoke writer; alert. No insert continuation, even if claim is later visible. | Exact read-only investigation. Preserve spent authority; never reset local/central state or reissue same-date authority as recovery. |
| Insert ACK unknown, timeout/OOM/TLS/daemon failure | Fence, revoke writer, retain intent/claim/audit. | Separate read-only majority reconciliation for original date/UUID/content/provenance. Missing/failed/conflicting evidence stays uncertain. No new submit. |
| Winner proven but result/audit missing | Preserve maze and claims; report audit-uncertain release. | Append independently retained recovery evidence when available; no repeat insert. |
| Authority restore/tamper/retention failure | Disable publication, preserve resource identities and all object versions. | Independent custodian compares complete spent history before any replacement authority acceptance. Empty/rolled-back state never means fresh authority. |
| API/client/cached-bundle failure | Owner may pause traffic and roll code/client back only to independently tested fresh-compatible image with **same release identity**. | Recheck cached workers/tabs, old UUID completion/retry and receipts. Old server `8e3eac84` is not safe fresh-era rollback. |
| Bad immutable date/content | Stop publication/traffic as owner directs; integrity incident. | Never delete/update/upsert/reseed a publication, reset consumed keys or silently reset player sessions. |

Rollback concerns traffic/code/configuration, not published maze history. Before
cutover retain old client assets for cache compatibility and a fresh-compatible
server image; rehearse failure/recovery against synthetic data first. Do not promise
a production rollback until the exact combined server/client tree passes QA.

## Decision record to complete later

- Host identity/operator/recovery contact and witnessed H1–H4: **UNVERIFIED**.
- Merged production image/roots/offline custody: **UNVERIFIED**.
- Actual Atlas identities/TLS/full egress/DDL freeze: **UNVERIFIED**.
- Cloud consume/IAM/immutable audit/independent recovery and actual bill: **UNVERIFIED**.
- Live adapter, fresh manifest/date/window/signatures: **NOT AUTHORIZED / PENDING**.
- API deployment, client #54/Vercel, monitoring/rollback/scheduler: **NOT AUTHORIZED**.

No production GO follows from this checklist being filled with fixture results.
Owner approves each real operation only after independent evidence is reviewable.
