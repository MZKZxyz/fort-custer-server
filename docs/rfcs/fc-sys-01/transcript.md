# FC-SYS-01 v0.3 — bounded legal-route replay

D1 is settled by [owner clarification 6416037589](https://github.com/MZKZxyz/fort-custer-server/issues/5#issuecomment-6416037589): **server-owned timing plus deterministic validation of a submitted ordered action transcript**. This is proportionate protection for optional, low-stakes recognition in a maze adventure. No per-movement network hop, live authoritative movement service, anti-bot system or traversal secrecy is required for the first implementation. [Handoff 6416107046](https://github.com/MZKZxyz/fort-custer-server/issues/5#issuecomment-6416107046) supersedes the earlier D1 interpretation.

## Recommended architecture and costs

| Approach | Network/storage/work per run | Guarantees and limits | Selection |
| --- | --- | --- | --- |
| One bounded post-run transcript | One completion upload plus normal create/ready/recovery; ≤65536 commands, ≤2MiB decoded transcript, ≤4KiB envelope. O(cells+commands) replay; no shortest-path search. At most one private raw transcript plus digest/summary/result; retries reuse content storage | Checks submitted route legality; cannot establish when/by whom it happened. Partial local log is not server gameplay state. Upload time before receipt is charged | **First implementation**, smallest protocol and preserves fluid local input |
| Optional bounded ordered batches | Suggested later 256-command chunks: 16–256 requests for 4096–65536 commands, roughly 6–102KiB extra headers at assumed 400B/request, plus durable chunk keys/checkpoints/final digest. In-order contiguous prefix only | Can support long routes/crash recovery and incremental workload. Does not establish human timing or remove fabricated legal routes. Arrival cadence is not legal action cadence | Add only if measured upload/recovery/size problems justify complexity. Not required now |
| Online authoritative transitions | Up to one event per accepted/attempted action, sustained channels/queues, session state and prediction/reconciliation | Enforces server event ordering/state with a separately approved timing/rate rule. Still permits bots/pre-solving. More latency, disconnect and operations cost | Optional escalation on evidence, not first-release gate |

Byte costs are concrete caps and arithmetic, not load measurements. A compact example command is ~23–29 UTF-8 bytes; 4096 commands are roughly 112KiB, 65536 under 1.9MiB for the allowed schema. Provision raw storage at **2MiB per maximum run** before replication/index/backup overhead: 10000 retained maximum runs are ~19.5GiB raw. Set retention/appeal policy, compressed-at-rest private object storage if justified and measured validation concurrency before admission. Never grow the existing User attempt arrays with transcripts. Whole-body retries can repeat upload bytes; content addressing prevents duplicate stored copies, not network cost. No browser benchmark or throughput claim is made here.

## Versioned envelope and commands

Completion body, bound to the owned UUID/session manifest:

```json
{
  "completionKey": "client-uuid",
  "transcript": {
    "version": "route-transcript-v1",
    "commands": [
      {"seq": 1, "dir": "right"},
      {"seq": 2, "dir": "right"},
      {"seq": 3, "dir": "right"},
      {"seq": 4, "dir": "right"}
    ]
  }
}
```

For grid `SXFE`, these four commands pick up X, clear F **without moving**, step onto cleared F, then enter E/the tipi. No separate pickup/fire/finish opcode exists in this rules version: the canonical directional action determines interaction. An action is a logical dispatched direction, not a keydown, queued-turn request, animation frame, pixel motion or held-input duration. Keyboard/D-pad/accessibility adapters feed the same canonical transition. Log directions when dispatched, not when a turn is merely buffered. No client timestamps, coordinates, inventory, score, duration or completed boolean are accepted. Envelope/schema unknown fields fail closed.

Sequence must start at 1 and be a contiguous strictly increasing safe integer at each array index. Do not sort or fill gaps. Duplicate sequence IDs within a transcript, even identical payloads, are malformed, not skipped. Repeated directions with **different** contiguous sequence numbers are separate actions. A whole completion retry with the same account/key/normalized body replays one immutable result. A different unused completion key on that UUID may alias only the **same transcript hash**; changed transcript after saved completion conflicts. Recovery without the raw body uses owned GET result/status, never a new finish assertion.

Canonicalize object property order and command field order before hashing; retain command array order. Server computes SHA-256 from normalized `{version,commands}`; client hash/signature is never evidence. Bind request hash to account/profile/attempt, operation and transcript digest. The session already pins immutable maze/date/gridHash/rules/competition/grants, allowed integrity tier/validation policy/public label. Before replay, verify those server references and supported validator/config versions; never select a grid or abilities from a completion body. An unchanged create intent keeps its original manifest even after server defaults change.

## Deterministic replay state and transitions

Start from **exactly one S**, equipment empty, no changed cells and terminal=false. Require rectangular grid with exactly one E and known `#`, space, S, E, X, F tiles. Source evidence: pinned client movement semantics captured in `test/fixtures/client-movement.js`, independently represented by analyzer `solver.js` at server baseline `d82c272`; no production helper is imported by the validator. `transcript.test.mjs` compares representative outcomes with the pinned pure fixture. No source claim extends to an unpinned future client build.

| Target / state | Replayer action |
| --- | --- |
| Direction not up/down/left/right | Schema error, including inherited names such as constructor/toString; never property lookup through prototype |
| Outside rectangle / wall # | Legal blocked input: unchanged position/equipment/grid. Cannot wrap rows, clip walls or teleport |
| Space or S | Move exactly one cardinal cell; revisiting S/loops is legal |
| X | Enter cell, set equipment to **one** extinguisher; replace pickup with space even when already full. No stacking or regeneration on revisit |
| F without equipment | Legal blocked input, state unchanged; cannot clear/enter it |
| F with equipment | Consume one extinguisher, replace F with space, **remain in original cell**. Another direction action is needed to enter the cleared cell |
| E / tipi | Enter E, set terminal=true automatically. This must be the last submitted action |
| Any action after terminal | Reject whole submission as TRANSCRIPT_AFTER_GOAL, including blocked/no-op directions |
| Transcript ends before E | TRANSCRIPT_INCOMPLETE; never infer goal from caller finish |

Blocked actions may be omitted by the logger because they do not change canonical state; if included, they count against bounds. Exact-state loop reduction is permitted as a representation optimization: remove only a segment whose beginning and end have identical position, equipment and **entire changed pickup/fire set**, then renumber the retained commands. It grants no route hints, movement shortcut or time credit; it is not an input-assistance classification. The server still replays the resulting route from S. This is a submitted route proof, not raw input telemetry or proof that the supplied route matches every real action. Never remove pickup/fire effects or reorder actions; no claim of real action timing is made by reduction.

No universal action-time floor, hold-delay minimum or solver optimality check is used. There is no reason to solve for shortest route on the server: the bounded submitted route is the proof. 400/180ms hold defaults are UX behavior, not an enforced minimum manual/accessibility cadence. Continued exploration, detours, practice and archive familiarity are legitimate. Fast legal times are not automatically rejected as fraud.

## Class, equipment and supported abilities

S starts with no F/X equipment regardless of cosmetics or collectible ownership. Competitive grant/config versions lock at session creation. Standard means no server-granted competitive capability; equivalent screen-reader/zoom/reduced-motion/input adapters stay standard. An information-only competitive grant can be assisted without changing movement rules, but its exact supported config and disclosure must be bound. A movement/state-changing power requires an explicit versioned replayer transition and tests before sessions using it are admitted. Reject unsupported grants/configs with 503 POLICY_UNSUPPORTED before allocation/ready; never silently ignore an ability or treat hidden assistance as proven absent.

The offline oracle's two `fixture-*` information-only grants are **synthetic test registry entries**, not production abilities or product approval. Initial runtime registry should enable only actually designed/tested versions; it may initially allow no competitive grants while retaining durable assisted-class support. Changing a grant/class requires explicit abandon/new attempt. The manifest also pins approved EG-09 logical visibility; replay does not prove what a modified client saw.

## Bounds and admission

Proposed engineering bounds for this schema: **65536 commands, 2097152 decoded UTF-8 transcript bytes, dimensions ≤101×101**; command and byte boundaries are inclusive. Request envelope adds at most 4096 bytes. Enforce total decoded request bytes at ingress before JSON parsing, including whitespace and decompressed payload; reject compressed requests if decoded accounting is unavailable. No truncation, silent sampling, prefix-only acceptance or zip bombs. Body-read timeout and measured worker wall/CPU budget are infrastructure bounds, not gameplay speed thresholds. Transcript parsing/replay is O(N+cells) with bounded memory, no exponential solver.

Admission proposal: at most one new validation job per account at once, bounded global worker queue (initial staging cap 128), and a per-profile token bucket of three new validation bodies/minute with burst two. Tune against accessible play/retry evidence; these are not owner-approved production numbers. Hash-matched committed-result/status recovery takes a cheap path; it must remain available under throttling. All requests, including retries, obey byte caps/auth. Return 429 + Retry-After for quota, 503 retry-same for infrastructure timeout/queue failure; no fraud label or irreversible loss of date eligibility.

Warn locally before large transcript/storage limits; exact-state loop reduction can preserve long exploratory routes. Do not silently freeze movement or forfeit progression at a logging cap. If an unreducible legal route exceeds these bounds, retain local journey and offer untimed/practice continuation plus explicit recovery guidance; enable bounded batch support before admitting a maze/rules combination whose legal completion/accessibility journeys cannot fit. Raising caps requires measured resource proof. The rare overflow/untimed recovery UX must be validated before rollout, rather than promising these bounds fit all journeys. Collection/progression must never depend on fast time, public participation or leaderboard place. D5 still needs Progression confirmation on timing-only hold and an untimed route-valid recovery path using the same date ledger; the timed oracle does not settle that policy.

## Interruptions, failures and outcome recovery

* Intact state/log, lost connectivity: continue local movement; clock keeps running. Persist transcript/checkpoint and create/ready/complete intent locally under profile/attempt. Ready ACK loss recovers original start; no local pause/refund.
* Reload with intact coherent durable local checkpoint: reconstruct by replaying its complete prefix from S against original manifest, continue same STARTED session only after owned status confirms usable state. This is client reconstruction, not a trusted server position. Never resume arbitrary caller coordinates. Partial/torn/missing prefix: no suffix-only proof; explicit abandon/new rank-eligible replay from S, or practice. A pending save stays latched until commit outcome resolves.
* Local finish: atomically persist full immutable completion intent/transcript before POST. Body upload and parsing up to trusted capture boundary are charged. Capture receipt **after auth/session binding and bounded schema normalization, before deterministic replay and final transaction**. Full route replay is outside the Mongo transaction to avoid long locks. Only then take the guarded write timestamp; replay/queue contention can still cross expiry and fail. Check manifest/version/hash again in the final write.
* 400 malformed/sequence/unknown fields; 413 size; 422 illegal/incomplete/after-goal route: no completion result, date claim or receipt outbox; session remains STARTED subject to its original deadline. No automatic retry loop of the same invalid data. Explain “route could not be validated,” preserve local evidence privately, offer resume/recovery/new run. Corrected uncommitted input may use a fresh key; after a hash is durably bound to an intent, changes require a new key and definitive abort of the old operation. No extension/backdating.
* 503 invalid server grid/unsupported manifest/validator failure: operational error, not player rejection; no partial result or reward. An exhausted worker budget is retriable infrastructure failure, not evidence of cheating. A coherent valid route remains necessary for accepted completion.
* Timing-only uncertainty with legal route: preserve separate route validation and clock evidence; no auto-rank or generic acceptance bypass. D5 completion-credit/untimed policy remains explicit. No broad “possible cheat” copy.
* Unknown commit: keep original operation/intent; retry/status/resolver must return durable winner or prove abort by shared intent/session fence. **A missing read or backwards post-commit clock sample is never proof.** No second result/receipt/grant. After proven abort, preserve key/body binding, advance generation and acquire a new server receipt with current healthy clock evidence. See RFC P2 section and transaction plan.

## Residual threats and proportionate response

| Case | What route validation prevents / permits | Response |
| --- | --- | --- |
| Forged position/finish, crossing walls, infinite equipment, skipping fire-clear input | Cannot create a legal accepted route under pinned rules | Reject invalid submission without fraud accusation |
| Fabricated/precomputed legal transcript or offline solver | Permitted; legal sequence says nothing about real input timing | Disclose limited tier; no high-value leaderboard incentives; no advanced anti-cheat gate |
| Hidden assistance/full-grid reading/misrendered crop | Replay cannot establish absence; grants/manifest bind declared capabilities | Preserve standard/assisted and EG-09 compliant-client checks; do not claim tamper-proof visibility |
| Reordered/duplicated commands or terminal suffix | Structural/semantic rejection; whole-HTTP retry remains idempotent | Bounded schema, normalized hash and stable result |
| Replay flooding/oversize body or huge blocked loops | Resource bounds/quota, cheap committed recovery; no unbounded route search | Measure/tune account/global controls, keep status usable |
| Modified client clocks or bogus per-action times | Not accepted as score/state inputs | Server receipt/start plus clock-health safeguards |
| Leaked transcript/cursor/private tie times | Not addressed by legal replay | Private retention/access, allowlisted public fields, confidential cursor reference or AEAD token |

Tier label **“Server-timed · route validated”** means exactly these properties. It never means verified human, live authoritative movement or proven honest screen/input. Optional future escalation needs actual abuse evidence and a separately reviewed cost/UX contract.
