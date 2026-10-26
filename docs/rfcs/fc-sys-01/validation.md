# FC-SYS-01 v0.2 — reproducible local design validation

Environment: Node **v24.19.0**, built-in `node:test`, no third-party dependencies. Starting design commit: `effc3f47584ff6d315302a9c05569cbd31c4a0f4`. Synthetic profile/account labels and relative millisecond values only. The original 20 fixtures passed before editing; the revised suite has **64 passes, 0 failures, 0 skipped/cancelled/todo**.

From the repository root:

```sh
node --version
node docs/rfcs/fc-sys-01/model.test.mjs
node --check docs/rfcs/fc-sys-01/model.mjs
node --check docs/rfcs/fc-sys-01/model.test.mjs
node --check docs/rfcs/fc-sys-01/replay.mjs
node docs/rfcs/fc-sys-01/replay.mjs > /tmp/fc-sys-01-replay.json
cmp docs/rfcs/fc-sys-01/replay-output.json /tmp/fc-sys-01-replay.json
sha256sum docs/rfcs/fc-sys-01/replay-output.json
git diff --check
```

Expected: tests report 64/64 passing; syntax, `cmp` and whitespace checks exit zero. Replay SHA-256:

```text
ac3480bade8ff3353ae8a8b4d04063b9d022e9d0ac97c2f2464b262e54aff766
```

Replay has 12000ms loading excluded, 600ms start ACK delay charged, a 6500ms immutable receipt, identical recovered snapshot, a separate eligible date entitlement after acceptance, and a receipt-only board entry. It performs no inventory operation. Saved JSON is byte-reproducible; test runner durations are not golden data.

## Regression coverage

| Area | Executed oracle fixtures |
| --- | --- |
| Identity/replay | Account-key collisions across profiles, separate accounts, canonical property/ability ordering, pinned original manifest after policy change, ready rules/hash/nonce, foreign access, stale revisions, alternative completion keys |
| Session/expiry | Lost ACK/status, load/connection delay, both serial create/ready/abandon/complete orderings, prepare/play deadline−1/0/+1, predeadline receipt with late guard or late commit, cleanup-first fence, successor-safe slot release, explicit fresh ranked replay |
| Receipt durability | No modeled side effects before commit; stable receipt across internal retry; later HTTP retry after no-commit; lost/unknown ACK replay after expiry/new session; twenty serialized duplicates |
| Clock/integrity | Positive unhealthy start and receipt, negative/missing/epoch failures, uncertainty boundary, authorization/revision/repair guards; preserved evidence and elapsed; accepted claim without any traversal evidence |
| Entitlement | Rejected/pending/quarantined first receipt, both accepted ordering schedules, fallback/release, stale claim token, late reacceptance, terminal consumed/exhausted opportunity, unknown/absent/awarded/exhausted legacy input, profile/date/class/midnight scopes |
| Best projection | Slower replay, invalidation fallback/empty deletion, opposite adjudication ties, exact ties, class/era split, stale source snapshot rejected even after a newer board revision, repeated recomputation after reversed/duplicate notifications |

## Evidence limits

These are **serialized JavaScript oracle schedules**. No Promise.all test is presented as overlapping transactions. `captureComplete` and `commitComplete` separate trusted receipt/guard/commit schedule inputs; they do not create a durable ingress reservation. State/manifest and timing policy values are synthetic. Internal oracle projection rows include synthetic private evidence; they are not public API responses. Public HTTP status/shape, UUID/date parsing, ownership lookup, quotas, nonce cryptography, middleware, browser transport/rendering and actual MongoDB concerns are not implemented here.

Authority/repair objects stand in for a trusted validator and independently verified clock-monitor evidence; they do not authenticate a reviewer or corroborate clocks. Clock health is simulated. The model's full recomputation and source revision fence demonstrate desired semantics, not MongoDB epoch locking, outbox event deduplication, delivery, indexed queries, throughput or cursor correctness. Reversed notifications rerun current-state projection; no real worker consumer is tested.

Legacy snapshots/statuses are supplied to the model and preserved; this is stronger than the former disconnected sentinel but does not discover or migrate history. Unspecified historical status defaults to held. `consumeOpportunity` exercises ledger fencing/terminal state only: **no catalog, randomness, item selection, inventory grant, external effect or exactly-once delivery** is modeled. SYS-03 inventory and grant failpoints remain required.

Only `docs/rfcs/fc-sys-01/` is revised. No application test suite/database was started, no live database accessed, no packages installed, no historical data edited, and no deployment/implementation PR/CI polling performed. Tests establish design regression behavior, not release readiness or independent signoff. Required follow-up HTTP/replica-set/clock/accessibility/compatibility/migration/rollback evidence is listed in the [implementation plan](implementation-plan.md).
