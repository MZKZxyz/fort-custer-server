# Stamp checkpoint generator v2: offline engineering report

Design authority: issues #38 and #39. Base: `4493b531f8dd4597170be993f42beb2586afc6c9`.

## Rule contract

`daily-dfs-v2`, `sha256-xoshiro256ss-v2` and `stamp-card-interact-v2` identify this isolated format. Its grid uses `S` start, `E` exit and `P` station. Easy has no `P`; Medium and Hard have exactly one. Every attempt starts with a card and `stamped: false`. A directional input enters a passable adjacent tile. `interact` while standing on `P` sets `stamped: true`, and is idempotent. At `E`, arrival completes only if the tier does not require a stamp or the card is stamped. An unstamped arrival leaves the player free to leave and return. The stamp is never consumed. This one logical action can map to keyboard, touch, or controller controls later; no active client mapping is included here.

The existing v1 API, runtime, publication validator, `F`/`X` grids and random stream remain separate. Publication of a v2 maze requires a later coordinated server/client contract, authoritative per-attempt stamp validation, serialization/recovery, and UI input support. The current publication validator refuses v2. `LIVE_APPLY_BLOCKED` and pending fresh release stay in force.

The generator carves a perfect tree, chooses endpoints, then places `P` off the direct route. The verification function rejects disconnected/cyclic or malformed grids, on-route stations and detours inconsistent with `2 × branchDepth`. The BFS solver includes movement and one station interaction. Medium placement currently requires branch depth 2–8; Hard requires depth at least 9 and one misleading offshoot. Selection biases Medium toward shallow and Hard toward deep/complex eligible branches. These thresholds are provisional.

Xoshiro256** has 256 bits of internal state seeded by SHA-256. This removes the v1 32-bit state bottleneck. It is a deterministic PRNG, not a cryptographic secrecy primitive; private unpredictable seeds and access control remain required.

## Private calibration sample

The disposable sample used 30 independent 32-byte seeds per tier and size, 270 attempted and 270 accepted, with zero exhausted cases. No calendar or production candidate was generated. The raw grids, seeds and owner shortlist are outside Git in a mode 0700 directory, with mode 0600 files. This report contains only aggregate data. For each tier and size, mandatory backtrack distance (min / median / p90 / max) was:

| Tier | 13×17 | 17×19 | 21×21 |
| --- | --- | --- | --- |
| Easy | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| Medium | 4 / 4 / 6 / 6 | 4 / 4 / 6 / 6 | 4 / 4 / 6 / 6 |
| Hard | 18 / 44 / 80 / 94 | 24 / 62 / 102 / 126 | 46 / 96 / 152 / 184 |

Median optimal inputs were Easy 40 / 44 / 65, Medium 49 / 60 / 77, Hard 85 / 119 / 146 across the same sizes. Median misleading side branches were Medium 1 / 1 / 1 and Hard 2 / 2 / 3. Size still affects overall route burden; medium detour selection currently clusters at the shallow end. The hard upper tail reaches 235 inputs. These are perfect-information estimates and do not establish actual fog-of-war play difficulty.

To reproduce a *new disposable private cohort*, run `node tools/year-ahead/stamp-experiment.js /absolute/private/new-directory 30` on Node 24. The directory must not exist and must be outside Git. `sample.jsonl` holds private seeds/grids; `shortlist.json` gives local line numbers for low, median and high navigation burden in each tier/size. Keep both files private; do not put their contents in an issue, PR, build or public API. The old v1 annual batch tool is untouched, and this experiment refuses to overwrite a prior directory. A repeat run uses fresh seeds; exact regeneration of one candidate uses its private seed, tier and config with `generate()`.

## Verification and decisions

The independent test oracle computes routes using its own BFS, exercises unstamped exit and return, repeated interaction, solver movement/action counts, all sizes and tiers, and a pinned v1 grid hash. The v2 verifier and solver also check that required stations are reachable and the detour equals the tree lower bound. No live API or game renderer was changed.

Owner decisions remain: final tier thresholds and distribution, fog-of-war/device playtest results, precise client interaction affordance, launch date, and private durable batch custody. A later integration phase must prove authoritative result validation and compatible saved-session recovery before any v2 publication.

## Engineering QA at draft handoff

Files changed: `lib/maze/random-v2.js`, `lib/maze/stamp-v2.js`, `tools/year-ahead/stamp-experiment.js`, `test/stamp-v2.test.js`, and this report. Base SHA is above; the final PR head SHA is recorded in the PR and issue #39 engineering comment.

Node 24.19.0 focused offline run: 57/57 passed, covering v2, v1 daily snapshots, existing annual private-batch behavior, and publication input guards. The complete `npm test` run recorded 689 tests: 349 passed and 340 failed due to `spawn mongod ENOENT` in tests requiring a local MongoDB binary. Client movement parity was checked for Easy using the existing pure client fixture; Medium/Hard interaction parity is defined by the offline state model and requires follow-up client implementation. `npm pack --dry-run` included no private sample artifacts. `git diff --check` passed.

The sample directory is disposable and not a durable backed-up batch. Its contents have not been published. No subjective or physical-device playtest has occurred. Independent Gameplay/Server/Security verdict is pending on the final PR head.
