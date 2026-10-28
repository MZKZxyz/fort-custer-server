# PR #25: canonical Ed25519 signing-key identity

Addresses [independent Security QA 5690825924](https://github.com/MZKZxyz/fort-custer-server/pull/25#pullrequestreview-5690825924),
its [inline P2](https://github.com/MZKZxyz/fort-custer-server/pull/25#discussion_r4406995343)
and [integrator review 5690890156](https://github.com/MZKZxyz/fort-custer-server/pull/25#pullrequestreview-5690890156).
Failed source: `11b3e4c94a2a626dc959f6366faea8125ff6ed83`. This correction stays
on the existing draft PR/branch; it does not authorize live publishing.

## Defect and correction

The old validator compared base64 SPKI strings for uniqueness and parsed only the
selected signing root. Node/OpenSSL accepts a standard 44-byte Ed25519 SPKI and
a 45-byte variant with outer length `30 81 2a ...` as the same key. Their canonical
base64 strings differ, so one ephemeral private key could satisfy both role IDs.

Every configured root is now bounded/exact-key checked, canonical-base64 decoded,
parsed with createPublicKey, and required to be Ed25519. The validator exports
each parsed key to canonical SPKI DER and compares that canonical material across
**all IDs and roles**, including roots not selected for the current signature.
Duplicate IDs or key material reject as CERTIFICATE_INVALID. Role selection and
signature verification use the already parsed key only after the whole table
passes. An alternate accepted encoding of a genuinely different key remains valid;
raw string inequality is never proof of independent signing material.

Existing signature domain separation, envelope validation, list/size limits,
one-date authority, source/release/window binding, nonce/date consumption, unique
inserts, majority verification, uncertain-write reconciliation and unconditional
LIVE_APPLY_BLOCKED are unchanged. Rehearsal context keys/source labels remain
caller-provided inputs, not measured source, owner identity or production roots.
Distinct keys do not themselves prove distinct humans.

## Permanent regressions and red/green evidence

The new test generates an ephemeral Ed25519 pair, exports 44-byte SPKI, constructs
the exact independently demonstrated 45-byte alias and verifies that Node exports
both to identical canonical bytes. One private key signs both valid envelopes.
Controls exercise identical encoding and both role orderings (44/45 and 45/44).
The full workflow is called against owned disposable MongoDB, not only a crypto
helper. No production or retained private key is used or logged.

With the new test but the **old unchanged validator**, the targeted run failed:

```text
result: INSERTED_VERIFIED
DB commands: 7
inserts: 1
ledger claims: 1
stored rows: 1
ledger files: 3
```

The intentional red run reported 0 passed / 1 failed, zero skips,
1859.492702ms. This reproduced the actual one-key/two-role insertion, rather than
merely proving different input bytes. Fixture teardown removed owned state.

After the source correction, the same test passes: CERTIFICATE_INVALID,
**zero operation DB commands, zero claims, zero stored rows and zero ledger files**.
DB-free preview rejects the same roots as well. The targeted green run reported
1 passed / 0 failed, zero skips, 1564.636996ms. Preparatory fixture provisioning/
metadata capture and post-operation assertions are separate from the monitored
operator DB command stream.

Additional permanent tests reject unselected malformed DER, noncanonical base64,
wrong types and X25519 roots; reject an unselected canonical alias across both
roles/IDs; and prove two genuinely distinct Ed25519 keys (including a nonminimal
SPKI encoding for one) still produce exactly one immutable winner. Spent approval
refusal and read-only reconciliation preserve that winner without another insert.
The existing tampered-signature, scope/expiry, UUID/metadata drift, actual fault,
crash, uncertain-write and hostile production-entrypoint cases remain in the suite.

## Final validation and handoff

Node 24.19.0 / owned loopback MongoDB 8.0.16. All server invocations unset
MONGO_URI, MONGODB_URI, MONGO_URL, DATABASE_URL; only a local MONGOD_BINARY is used.
Final corrected-source results:

| Check | Observed result |
| --- | --- |
| Targeted same-key alias regression | 1 passed, 0 failed/skipped; 1564.636996ms |
| Dedicated `npm run test:operator` | **30 passed**, 0 failed/cancelled/skipped/todo; 8740.47532ms |
| Complete `npm test` | **572 passed**, 0 failed/cancelled/skipped/todo; 77865.702358ms |
| Static syntax | **112 JS/MJS files** passed |
| Frozen contract | **FROZEN_CONTRACT_MATCH** |
| Whitespace | Passed |

No intermittent failure occurred in corrected-source runs. The sole red failure
was the deliberate pre-fix exploit regression documented above. All 26 original
operator cases remain, with four new key-identity/root-validation controls. No new client build or
browser campaign is claimed for this standalone artifact-validator correction.

```sh
unset MONGO_URI MONGODB_URI MONGO_URL DATABASE_URL
export MONGOD_BINARY
node --test --test-name-pattern='same Ed25519 material' test/operator-publication.test.js
npm run test:operator
npm test
node tools/integration/freeze-contract.mjs
```

The PR body/handoff pins the corrected full SHA. Independent security QA must
reproduce the alias rejection before any DB/intent and distinct-key successful
publication at that exact SHA; author tests are not independent acceptance.

Production remains **LIVE_APPLY_BLOCKED**. No live-boundary, rehearsal insert/
reconcile, ledger, worker, app/route/model, release manifest, dependency, schema,
index or infrastructure change is included. Missing isolated runner, OS network/
cgroup/process-tree enforcement, measured source, trusted production signers,
scoped TLS/Atlas identity, global consumption/audit and real release/date/write/
deployment approvals remain hard gates. No production Atlas access, real key
provisioning, live publication, deploy, merge, scheduler/v2 activation or GitHub CI
polling occurred. Stop for focused independent security re-QA.
