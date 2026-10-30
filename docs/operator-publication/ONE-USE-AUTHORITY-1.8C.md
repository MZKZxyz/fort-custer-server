# Sprint 1.8C: one-use authority and retained audit

**Source/fixture decision only; production HARD NO-GO.** Issue
[#33](https://github.com/MZKZxyz/fort-custer-server/issues/33), parent
[#28](https://github.com/MZKZxyz/fort-custer-server/issues/28). Fetched main matched
`6e7925e737674a2cc53767c8157b17bc9f8e65ac` on 2026-10-29; no drift.
`LIVE_APPLY_BLOCKED` stays unconditional; fresh release stays PENDING.
No live adapter, cloud/Atlas calls, resources, credentials, production keys or date.
Prerequisites remain the [1.8B packet](PRODUCTION-READINESS-1.8B.md); execution is
specified in the [first-publication runbook](FIRST-PUBLICATION-RUNBOOK.md).

## Decision: transactional authority plus independently administered WORM audit

| Option | Atomicity / restore trust | Burden and decision |
| --- | --- | --- |
| **Default: one on-demand DynamoDB table, tiny synchronous broker, S3 Standard Object Lock in an independently administered account** | One `TransactWriteItems` conditionally creates approval, logical-date and intent records. Separate retained intent is required before maze submission. Local restore cannot reset the table. Pin **TableId**, not only a reusable name/ARN. | Three small services, no NAT/VPC fleet, scheduler, queue or orchestration framework. Owner must name an independent audit custodian with separate recovery credentials. Modeled authority/audit/monitoring ~$1.09/month, below. |
| **Fallback: broker + one bounded S3 CAS ledger with compliance-locked versions** | Broker reads ledger, checks BOTH keys, appends both plus intent in ONE object replacement with `If-Match` ETag; bootstrap `If-None-Match:*`. Competing replacements of one version cannot both succeed. Never two separate approval/date PUTs. Versioning/retention protect prior versions, not the latest pointer. | One fewer service, but custom ledger validation, version-chain/checkpoint recovery and whole-object growth. Suitable for a bounded manual pilot only; stop at 1 MiB, no automatic compaction/reset. Needs separate proof/real-service QA. Saves pennies, so keep as fallback. |

Fallback requires broker-only conditional-write access, no deletes/delete markers,
verified monotonic append/version history and an independently held latest version
checkpoint. A missing/rolled-back pointer is STOP, never an empty new ledger.
An ETag is a concurrency token, not an owner signature. No fallback implementation
is delivered. A local file or same-admin Mongo unique index alone is ineligible.

### Fixed identity and atomic consume

Owner installs immutable policy: authority account, region, table ARN, generated
TableId/creation identity, broker identity, independent audit account/bucket/region,
versioning/COMPLIANCE retention policy and deployment epoch. Include this policy
hash in the owner-approved release/image record and exact publication plan.
Namespace is the stable owner-approved deployment/database/`mazes` identity;
**exclude collection UUID, host incarnation and image version from the date key**.
Target UUID/index/validator hashes still bind the intent and submission.

For one validated UUIDv4 approval and UTC date, the broker issues one transaction:

| Put key | Contents | Condition |
| --- | --- | --- |
| `approval/<approvalId>` | intent hash, logical namespace/date, attempt UUID | `attribute_not_exists(pk)` |
| `date/<hash(canonical namespace)>/<YYYY-MM-DD>` | same intent hash and approval ID | `attribute_not_exists(pk)` |
| `intent/<attemptId>` | exact bounded approved intent | `attribute_not_exists(pk)` |

All three commit or none do. Two workers sharing an approval overlap its first
key; different approvals for one date overlap the second key. Thus, assuming
DynamoDB transaction semantics and trusted broker, at most one fresh consume can
acknowledge success. No lease/TTL/reset, automatic retry or UUID-recreation escape.
Do not use global-table multi-region independent writers as another authority.

Each invocation verifies existing canonical Ed25519 release/publish role separation,
merged source/image, plan/target/grid/content/solver hashes, namespace, request nonce,
attempt, finite window and trusted clock. Supervisor transport is narrowly scoped
synchronous authenticated HTTPS/SigV4; writer keeps approved Atlas-only egress and
receives no AWS administration credential. A response is bound to the live request
nonce and exact intent; **not a reusable bearer permit or restart-resume API**.
Fresh workers always consume afresh and therefore refuse spent keys.

Disable SDK/application retries (`maxAttempts:1`), asynchronous invocation retries
and transaction callback retries. Never replay a DynamoDB idempotency token to
recover authorization: it could return the old success response. Unknown ACK
ends that invocation; observing the claim later cannot mint permission. Restored
hosts perform reconciliation only, never replay saved receipts into a writer.
Exactly once means **at most one authorized submission**; failure may leave zero
mazes. No system can promise one successful insert through every outage.

### Fail-closed sequence and retained evidence

| State | Required action / allowed next step |
| --- | --- |
| PREPARED | Validate/snapshot signatures, source/image/resource identity, target, window and limits. Retain full bounded hash-only intent as a PREPARED audit version. No claim or maze write if audit is unavailable/unknown. |
| CONSUMED | One atomic consume; only an unambiguous fresh ACK continues. Unknown ACK → UNCERTAIN, **zero maze submits**, no read-to-resume. Conditional failure → STOP. |
| INTENT retained | Independently retain acknowledged-consumption receipt and original intent; verify exact VersionId/checksum, COMPLIANCE mode and retain-until horizon. No maze submit if this fails, even though claim stays spent. |
| SUBMITTED | Recheck window/clock/target/DDL fence; submit one native UUID-bound majority insert, retries off. Persist result/uncertainty afterward; no second submit on any error. |
| VERIFIED | Exact primary-majority UUID/content/provenance winner and retained result agree. Preserve all evidence. |
| UNCERTAIN / STOP | Fence job, revoke writer access, alert owner. Retain original claim/intent and any known outcome; separately authorized exact read-only reconciliation only. Missing/conflicting claim, intent, audit or winner is uncertainty, never a fresh GO. |

Audit records contain schema/kind, approval/attempt IDs, canonical logical namespace,
UTC date/window, owner decision/release/signature-envelope hashes and signer IDs,
source/image/policy/plan/target/UUID/limits/grid/content/solver hashes, claim receipt,
phase/timestamps and fixed result codes. No raw grid, user record, URI, secret or
private key. Signed source/approval artifacts are retained separately by owner;
a hash alone is not proof of human review. Bound each audit object to ≤4 KiB;
refuse oversize, don't truncate. Use unique attempt/phase keys with conditional
create, then verify the **specific object version**; never trust only latest key.

Propose seven-year COMPLIANCE retention for intent/result/uncertainty versions,
90-day redacted diagnostics and permanent compact spent tombstones while the
namespace exists. Owner must approve retention and account shutdown custody.
Reject expired approvals forever; old approval windows cannot reopen after
retention expiry. Any authority migration/replacement requires independent retained
spent-history comparison before acceptance, including dates whose audit aged out.
No lifetime namespace reset or history truncation is an automatic maintenance step.

Broker reconstructs incomplete outcomes from PREPARED/INTENT plus authoritative
claim and exact maze reads; it appends recovery evidence, never edits prior events.
After death, absence of a result itself means interrupted/unknown, not absence of
submission. If a winner is proven but result audit is unavailable, report
`WINNER_VERIFIED_AUDIT_UNCERTAIN`; do not label the release complete or retry insert.

### Credentials, administrator powers and restore limits

Publisher supervisor gets invoke-only short-lived identity. Reconciler gets exact
read-only maze/claim/audit access; writer gets only scoped Atlas credentials.
Broker is a **trusted** code/credential boundary: table-specific transactional
Put access, read/DescribeTable, and creation-only audit endpoint; no Delete/Update,
TTL, restore, table/bucket policy, retention reduction or root management.
Use `dynamodb:EnclosingOperation` to deny standalone writes, but IAM does **not**
prove the broker's Put condition expressions are append-only. A compromised broker
with raw transactional Put credentials can overwrite items; no claim otherwise.
Audit custodian restricts bucket write conditions/retention, denies delete markers,
DeleteObjectVersion, governance bypass, versioning/policy changes to all runtime
identities. Prefer SSE-S3 to avoid a separately deletable customer KMS key.

Normal runtime/local restore cannot reclaim consumption. Supported DynamoDB
restores/recreation must fail the independently pinned TableId; an ARN based on
reused table name is insufficient. Suspend all publication during restore or
administrator maintenance. Independent custodian inventories retained versions,
checks signatures and all spent approvals/dates against restored authority;
missing/conflicting history means STOP. Never accept an empty replacement table.

COMPLIANCE protects a version during retention, even from account root deletion
of that version; it does not prevent new versions, delete markers, denial of
access, future policy changes or account closure. Same-person control of host,
authority, audit, roots and recovery is **not independent administration**.
A malicious table administrator deleting rows in-place, compromised broker/host,
colluding custodians or cloud-provider failure remains outside this proof.
Independent retention detects/preserves evidence; it is not an atomic transaction
with DynamoDB or a universal rollback-prevention service. Owner must accept this
trust boundary or remain NO-GO, not silently weaken it for low cost.

## Synthetic evidence and external acceptance

`authority-fixture.mjs` has no network/client SDK or production mode. Three owned
SQLite files model shared authority, separate append-only audit and **hash-only**
maze outcomes; existing release/plan/Ed25519 validation is reused. Independent
OS processes rendezvous after both pass availability checks, then contend on actual
SQLite transactions; actual worker SIGKILL retains
central claim and audit. Trigger denials model runtime append-only APIs, not IAM
or separate OS/account ownership. FULL/fsync is not physical power-loss evidence.

Run with Node 24: `npm run test:operator-authority`. Tests cover both concurrent
key collisions; no partial claim; replay/fresh host/local rewind; collection
recreation; unknown claim ACK (zero submissions); lost insert ACK, missing/conflict
and audit-incomplete recovery; expiry after waits; clock reversal; source/image/
target/signature/role/resource drift; audit faults; runtime update/delete refusal;
and SIGKILL after claim/submission. A deliberate negative test restores central
SQLite authority and demonstrates it **can** be reclaimed: administrator rollback
resistance is NOT VERIFIED. Cleanup only disposes owned synthetic fixtures.

| Acceptance boundary | Current evidence | Required independent owner-authorized evidence |
| --- | --- | --- |
| Atomic state/one-submit logic | Local SQLite transactions, independent processes and fault tests | Actual DynamoDB transaction contention, timeout-after-commit, IAM/SDK/invocation retry behavior and signed scope on pinned resources |
| Immutable retention | Separate file, insert-only API/triggers, no raw evidence fields | Real cross-account COMPLIANCE VersionIds, retention/conditional-create and denied runtime deletes/overwrites/policy changes; account/root recovery review |
| Restore/admin resistance | Host rewind/recreation stays spent; central rollback counterexample | TableId drift, in-place admin threat acceptance, supported restore drills, retained-history reconciliation and independently controlled roots/checkpoints |
| Host/Atlas/build | Prior synthetic proofs only | 1.8B H1–H4, actual TLS/full topology/IPv4+IPv6/DDL/grants, trusted merged image and offline roots |
| First publication | Runbook only | Separate future-date selection/signatures, API/client cutover permissions, tested alert delivery and rollback |

**Source/fixture GO can be reviewed; every real-service/production row is NO-GO.**
No AWS emulator, local SQLite or Docker result attests actual DynamoDB/S3 durability.

## Full incremental cost model

USD US East (N. Virginia), public prices read 2026-10-29; no free tiers/credits.
Assumptions are a budget scenario, **not a schedule**: ≤100 attempts/month,
1,000 broker/read requests, 400 audit objects/month ≤4 KiB, 200 audit LISTs and
1,000 GET/HEAD/retention checks. Seven years of versions fit a 0.25-GiB allowance;
0.1 GiB table storage/PITR allowance. No NAT, API Gateway, custom KMS key, paid
support, replication or log analytics fleet. Manual recovery reserve included below.

| Component / primary evidence | Arithmetic / monthly estimate |
| --- | --- |
| [DynamoDB](https://aws.amazon.com/dynamodb/pricing/) Standard on-demand | $0.625/M WRU, $0.125/M RRU; transactional writes cost twice normal. 100 × 2 × (1+1+4 KiB-rounded units) = 1,200 WRU, plus 1,000 strong ≤4-KiB reads: **$0.000875**. Failed/duplicate requests consume capacity too; scenario is bounded, not unlimited free rejects. |
| Table storage/PITR | 0.1 GiB × ($0.25 storage + $0.20 PITR) = **$0.045**. Tombstones grow; reprice annually. Restore list rate $0.15/GB: 0.1 GB scenario $0.015 per drill, not permission to use restored state. |
| [S3 Standard pricing](https://aws.amazon.com/s3/pricing/), [AWS rate example](https://repost.aws/articles/ARzJZVGIflS8u5W-aZmtusig/amazon-s3-vs-amazon-ebs-understanding-the-key-differences) | 0.25 GiB × $0.023 = $0.00575; 600 PUT/LIST × $0.005/1,000 + 1,000 GET × $0.0004/1,000 = $0.0034. **$0.00915**; version retention included, not just current objects. Recheck selected-region price table at purchase. |
| [Lambda](https://aws.amazon.com/lambda/pricing/) broker | 1,000 synchronous requests at 256 MiB × 1s: 250 GB-s × $0.0000166667 + $0.20/M requests = **$0.00437**. No provisioned concurrency. Latency assumption, not benchmark. |
| [CloudWatch](https://aws.amazon.com/cloudwatch/pricing/) | Two custom metrics × $0.30 + four standard alarms × $0.10 = $1.00. Logs: 0.01 GB ingested × $0.50 + 0.03 GB retained × $0.03 = $0.0059; 1,000 standard API calls at $0.01/1,000 add $0.01. **$1.0159**; include missing-outcome/denied-action alerts and native broker errors. |
| [SNS email](https://aws.amazon.com/sns/faqs/) and recovery/egress | 100 publishes × $0.50/M + 100 emails × $2/100k = $0.00205; 0.1 GB Internet recovery export allowance × $0.09/GB = $0.009. **$0.01105**. No SMS. |
| Authority/audit/monitoring total | **About $1.09/month** for this bounded scenario, not a service promise or hard billing cap. |
| [1.8B host/backup](PRODUCTION-READINESS-1.8B.md#1-hosting-decision-and-cost) | $12 + optional $2.40 = $14.40. **Modeled incremental publisher total ~$15.49/month** with backup/monitoring; propose $16/month approval envelope before exclusions. |

Startup: no listed AWS service setup fee; first full month ~$15.49 plus optional
24-hour disposable VM acceptance drill (24 × $0.01786 ≈ $0.43), service/drill
requests and unpriced labor/key media/build/registry. Full game bill = this model
+ actual existing Atlas/Railway/Vercel/registry/backup-media bills + tax; these account
facts are UNKNOWN. Dedicated hardware fallback also adds measured electricity/ISP.
Fallback S3-only ledger removes DDB charges but whole-ledger retained versions need
separate sizing; do not reuse the per-event estimate blindly.

Owner approves actual region/retention, independent custody and spend ceilings.
Limit authenticated attempt rate/size/concurrency, set usage alarms and stop new
requests on abuse. Budget notifications are not a hard spending cap; already locked
versions remain billable and must not be deleted to recover cost. Labor, incidents,
private Atlas networking or paid service upgrades can dominate these tiny requests.

Primary semantics: [DynamoDB atomic transactions](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html),
[transaction IAM](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html),
[TableId](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TableDescription.html),
[S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html),
[Object Lock versions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html),
[account-closure limitation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-configure.html).
