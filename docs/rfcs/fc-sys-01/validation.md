# FC-SYS-01 v0.3 — reproducible local design validation

Starting commit: `e30e1b72f51f19f7e20f646770bc08dcfed67551`. Runtime: Node **v24.19.0**, built-in test/crypto modules, no third-party dependencies. Only RFC-directory design artifacts changed. All labels/grids/timestamps are synthetic; the pure movement fixture is pinned source, not a running app.

**124 fixture passes: 77 session/outcome fixtures + 47 transcript fixtures; zero failures, skipped, cancelled or todo.** The 64 previous session fixtures are retained/adapted to provide a required legal transcript, including all prior expiration, clock, entitlement and tie regressions. Receipt-only acceptance is replaced with the owner-selected route tier. The new fixtures add the two precise P2 corrections and route rules/schema/limits/parity tests.

From the repository root:

```sh
node --version
node docs/rfcs/fc-sys-01/model.test.mjs
node docs/rfcs/fc-sys-01/transcript.test.mjs
node --check docs/rfcs/fc-sys-01/model.mjs
node --check docs/rfcs/fc-sys-01/model.test.mjs
node --check docs/rfcs/fc-sys-01/transcript.mjs
node --check docs/rfcs/fc-sys-01/transcript.test.mjs
node --check docs/rfcs/fc-sys-01/replay.mjs
node docs/rfcs/fc-sys-01/replay.mjs > /tmp/fc-sys-01-replay.json
cmp docs/rfcs/fc-sys-01/replay-output.json /tmp/fc-sys-01-replay.json
sha256sum docs/rfcs/fc-sys-01/replay-output.json
git diff --check
```

Expected: direct suites report **77/77** and **47/47**; all syntax, replay comparison and whitespace checks exit zero. Direct execution reports individual fixture counts. Replay SHA-256:

```text
f8920cfcb785c68c763f6677dddb91e1b3051f7a15c1ccb6635775b797b90345
```

Replay shows 12000ms loading excluded, 600ms start ACK delay charged, a 6500ms immutable receipt with normalized transcript hash/count and route-valid tier, identical recovered snapshot, separate eligible date entitlement and internal best projection. Post-commit observation is separate from the frozen result. No item selection/inventory grant occurs. JSON is byte-reproducible; test runner durations are not golden data or performance evidence.

## Executed counterexamples

| Area | Offline fixture outcome |
| --- | --- |
| P2 receipt/guard clock reversal | 4999/5000/5001 guard versus receipt=5000. Backward guard is 503 CLOCK_UNAVAILABLE with confirmed abort in this oracle, no final result/outbox; retry retains original receipt/anomaly and cannot auto-rank |
| P2 post-commit observation | Observation at guard−1/0/+1 never supplies scoring authority. Durable receipt has no committedAt field and replays despite later backward samples |
| P2 unknown commit | Lost ACK with durable result returns winner even if a caller supplies abort proof; no second receipt/opportunity. Unknown without result blocks new receipt/abandon until synthetic proved-abort resolution advances session revision; old request then fails revision. Bound key/transcript hash survives abort |
| P2 ready/abandon scopes | Same ready/abandon key on two owned attempts succeeds independently. Changed nonce/reason on same scoped key conflicts; foreign actor cannot replay. Old revision exact replay preserves start/effective state |
| Canonical legality | Exactly one S/E, rectangle/boundaries/walls, cardinal directions, revisits, one equipment capacity, full pickup consumption, stationary F clear/extra step, new pickup replenishment, terminal E and suffix rejection; pinned fixture parity |
| Transcript envelope/order | Contiguous safe sequence, no sorting/dedup, valid repeated directions, unknown/inherited direction rejection, no caller position/equipment/time/finish flag, supported manifest tier/policy/public label/grants |
| Limits | Inclusive 65536-command route; next command 413. Inclusive 2MiB decoded wire including whitespace; next byte 413. Invalid pinned grid is 503, incomplete/after-goal route 422; no partial result/key/date claim |
| Timing/projection/date regressions | Original deadlines/recovery/ownership, no-commit later receipt, retained internal receipt, unhealthy/irreparable clock evidence/repair, first accepted date/fallback/late adjudication, legacy holds, exhausted opportunities, receipt ties and source-revision publication fence |

## Limits of this evidence

All transaction/race/unknown-outcome schedules are **serial JavaScript oracle mutations**. Pending maps, intake hash bindings, guard samples, abort-proof flags, authority/repair objects and revision advances are synthetic inputs/outcomes; they do not authenticate callers, monitor clocks, persist MongoDB intents, prove majority reads or resolve real transactions. The `committedAt` oracle schedule argument remains for the review regression; it now means only a private post-commit observation. Public API has no such caller input/result field.

`transcript.mjs` imports no app code. Its tests import only Node built-ins and the pinned pure client-movement test fixture; parity is representative, not a browser/gameplay certification. The model uses one immutable synthetic grid per instance and fixture information-only abilities; no production power is implicitly supported. Exact-state log reduction, browser durable prefix/intent persistence, optional batches, HTTP parsing/auth/status, public serializer, confidential cursor, quotas and measured CPU/load are specified, not implemented/tested here.

Internal projection rows include synthetic private identities/timing/evidence/hash and are **not public response schemas**. Projection recomputation/source fencing is semantic evidence, not MongoDB event dedup/index/pagination/load proof. Raw transcript/private evidence retention and deletion are still policy/implementation work.

The replayer validates a submitted legal route; it does **not** prove actual live traversal, action timing, human input, honest viewport or absence of hidden assistance. A fabricated legal transcript is an accepted D1 limitation. No cadence floor/solver/human-speed inference is introduced. The timed oracle preserves proposed D5 accepted-date entitlement; it does not settle timing-only quarantine/untimed core-progression policy. Entitlement terminal-state simulation performs **no catalog, randomness, inventory, external grant or delivery**.

No runtime routes, application modules, production data or historical records changed. No database was started/accessed, migration/deployment/new PR/CI polling performed or packages installed. Isolated MongoDB tests T1–T8 in the [implementation plan](implementation-plan.md), actual HTTP/client/accessibility/privacy/clock evidence and separate runtime/rollout authorization remain required. No new broad theoretical audit is requested by these passes.
