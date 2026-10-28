# PR #23: fresh-only public leaderboard correction

Independent re-QA closed this leaderboard P2 on `ea9d5012` and identified a
separate pre-existing ESRCH supervisor defect. Its targeted correction and current
validation are in [the monitor reliability report](esrch-monitor-remediation.md).
The earlier monitor incident below remains untraced; no causal link is assumed.

The independent [Systems/Security failure](https://github.com/MZKZxyz/fort-custer-server/pull/23#pullrequestreview-5682264559)
and [integrator correction](https://github.com/MZKZxyz/fort-custer-server/pull/23#pullrequestreview-5682304785)
rejected head `8dd9263ef80341744c974bef75606be20e6cc350`: daily/start/archive
excluded 2025 test rows, while weekly still clamped to summer 2025 and all-time
summed every saved progress date. This correction stays on the same draft PR.
The owner requires every public board to exclude unpublished/test history.

## Public contract

All three views use the same `isPublished` predicate and immutable default fresh
release policy. A completed progress entry is a candidate, never publication
proof. Counting a date requires the actual stored grid/hash/version/provenance,
approved release identity/digest/cutover timestamp/date, and sampled UTC now.
Missing, malformed, unbound, wrong-release, prelaunch or future maze rows do not
count. Raw saved progress, rewards, attempts, receipts and grids are never changed.

- Daily keeps `?date=YYYY-MM-DD` (default server UTC today), `404
  MAZE_NOT_PUBLISHED` for excluded dates and the existing result row shape.
- Weekly accepts `?start=YYYY-MM-DD` (default server UTC today). It normalizes
  within that exact civil week to **Sunday 00:00:00 UTC through the following
  Sunday, exclusive**. Its maximum seven date keys are verified before reading
  players. No summer clamp, substitution of a different week, fallback day or
  phantom publication. Old/all-unpublished weeks return `200 []`; this remains
  possible even if the player population exceeds the ranking work budget.
- All-time sums only completed progress on verified fresh publications. Shared
  dates are deduplicated before indexed verification. It returns `200 []` when
  there are no eligible completions. A rejected original result remains recoverable
  by its original UUID and does not become publicly ranked through recovery.
- Both aggregates retain `[{name, subProfileId, time, completedMazes}]`, three
  decimal places, ascending total-time order and at most 25 rows. The UI can keep
  its existing completion-count re-sort. Each progress date counts once; existing
  saved v1 completion semantics are unchanged. This does not enable official v2
  ranking or reconstruct best times.
- Invalid dates, timestamp/offset strings, duplicate/bracketed/unknown parameters
  return 400. All-time accepts no date selector. An otherwise real extreme date
  whose Sunday week extends outside years 0001–9999 is rejected as an invalid
  representable week. Unrecognized timeframe returns 404.
- All leaderboard responses are private/no-store. Catalog/DB/query integrity or
  work-limit failure returns `503 LEADERBOARD_UNAVAILABLE` with a fixed retry
  message. Never publish a partial top 25, silently ignore a failed date batch,
  leak database details or convert a verification failure into an empty board.

## Bounded reads and remaining scale limit

The ranking service replaces the previous unbounded `User.find()` hydration.
It uses one read-only aggregation, capped **before** processing profiles:

| Budget | Maximum |
| --- | --- |
| Input users | 1,000, plus one overflow sentinel |
| Profiles | 1,000, plus one overflow sentinel |
| Completed entries per profile | 4,096, plus one overflow sentinel |
| Total projected entries processed | 16,384 |
| Distinct candidate dates | 4,096 |
| Maze verification batch | 32 exact dates through existing unique date index |
| Per-command server execution | At most 2,000ms, reduced by remaining work budget |
| Application work budget | 5,000ms checked between phases/maze validations |

The aggregation projects only public profile identity and bounded date/time
scalars, not passwords/emails/attempts/receipts/rewards. Disk spilling is disabled;
MongoDB aggregate/BSON limits also fail the request rather than truncate results.
Only strict completed=true and finite positive numeric completion times count;
malformed, coerced objects, numeric-prefix garbage, infinity, zero, negative and
oversized time strings are skipped. Existing completion output fits the accepted
1–12 integer digits and up to 9 fractional digits. Stored values are unchanged.

All-time candidate dates are sorted/deduplicated, then looked up with bounded
`date: {$in: batch}`, a date-index hint, explicit row limit and maxTimeMS. No
per-player N+1 verification, full maze scan or schema/index change. Weekly has
one batch of at most seven dates; daily retains its authoritative existence check.

**Scale limitation:** these are explicit safe finite work budgets, not a scalable
permanent ranking read model. Above a cap, a board with eligible dates returns
503, including when omitted players might affect top 25. A larger population or
history needs a separately reviewed indexed ranking projection/query design.
No migration or new collection is introduced here. The application work check
is not an OS/process or connection-pool wall-clock deadline; existing driver and
server availability remain part of operational readiness. No arbitrary production
connection pool tuning or deployment setting change is included.

## Real default-server regressions

Tests start the actual index/default router composition with a copied synthetic
approved fresh artifact, MongoDB 8.0.16 replica-set fixtures, and no ambient DB
selector. Production config stays pending. Regressions cover:

- QA's exact 2025-05-26/12.345 result: all aggregates empty, daily/start refuse,
  archive excludes, repeated original UUID returns unchanged saved result. Snapshot
  comparisons protect every fixture grid/user/reward/attempt and observe zero DDL
  or application mutation from leaderboard reads and result recovery.
- Mixed old and fresh results, absent dates, incorrect release ID/digest, prototype,
  corrupt grid hash, preapproval and future publication, incomplete/invalid times.
- UTC Saturday/Sunday at minus-one millisecond and exact midnight, default/requested
  week agreement, sparse days, delayed publication, invalid/ambiguous queries.
- Actual Mongo failCommand errors for player aggregation and maze reads. A failure
  after the first 32 verified dates still returns 503, with no partial results.
- Forty dates shared by two players use one bounded player aggregation and exactly
  two indexed maze batches (32 + 8). Population overflow returns 503 rather than a
  truncated board, while a genuinely unpublished old week still returns empty.

The optimized-client → actual-default-server browser smoke also seeds a saved
historical receipt, plays/completes a fresh stored grid, loses/retries its completion
ACK, tests the unchanged client weekly empty state/all-time table, and recovers the
old UUID without mutation. No mocked backend substitutes for this smoke.

## Coordinated client follow-on (not edited here)

Client archive PR #54 at `2c6dc171e6c7786ef5469009f593f9fa48a952e5` still exposes
`Legacy weekly — Summer 2025`, hard-coded May 26–September 1 selectors, and
`All-time legacy saved results`. Those descriptions are now inaccurate for public
fresh-only rankings. Its response parser still accepts the unchanged arrays and
row keys: stale weekly controls show an empty state, and all-time shows fresh-only
counts. Server enforcement must not restore historical scores to fill that UI.

Before coordinated release, the client owner should **hide the old summer weekly
control** until its fresh UTC week navigation is reviewed, or replace it with a
fresh Sunday-based selector and explicit UTC interval. Retitle all-time and its
empty/table messages as fresh-archive saved results, retaining the distinction
from official validated rankings. Test current/older bundles, empty old weeks,
fresh daily/all-time, 503 retry, identity switching and retained receipt recovery.
This is a client release gate, not permission to modify/merge #54 here. Existing
old-bundle gameplay interruption and refresh/recovery plan still apply.

The latest locally exported combined client tree is
`8cb6ee8e8562be4b4081b81980c8436bb69e58de`, from unchanged archive head plus
art-main `72e5f90786288f02371da18139e1e834d8d13f64`. It includes the additional
`docs/art/meshy-spike/` commit mentioned by independent QA. No client branch,
commit or PR is changed/pushed/merged; these reference assets are not runtime art.

## Validation / independent re-QA handoff

Final engineering validation on Node 24.19.0, disposable MongoDB 8.0.16 and
Chromium 154.0.8037.57:

| Check | Observed final result |
| --- | --- |
| Complete `npm test` discovery | **534 passed**, zero failed/cancelled/skipped/todo; 98039.273931ms |
| `npm run test:fresh` | **29 passed**, zero failed/cancelled/skipped/todo; 17048.093812ms |
| Client unit suite, latest combined tree | **229 passed / 17 suites**, zero failures/skips; 11.106s |
| Combined optimized build, CI=true REACT_APP_API_URL=/api | Compiled successfully |
| Combined archive Chromium configuration | **131 passed / 28 intentional skips**, 159 discovered; 6.0min |
| Optimized client → actual default server → disposable MongoDB | **13 checks passed**, including both aggregate controls and original old UUID recovery |
| Static source | **104 JS/MJS syntax checks**, FROZEN_CONTRACT_MATCH, clean whitespace check |

The 28 existing browser skips cover presentation/input opt-ins and native touch
applicability. No server/unit test is skipped. Chromium does not certify physical
devices or screen readers. The unchanged client checkout stayed clean; its draft
PR and branch were not modified. Local optimized asset-manifest SHA-256:
`8f23e25d6f07fdaa71e53a101706646bdc43f73e19dc016a8abb03d1c8726bd3`;
main.fa89226e.js SHA-256:
`5dd8acc7238f80d96e1138bd69e7553420c38fa0d0a7f5e799f0ef0c19b5475f`.

An earlier full run, overlapping the Chromium run, reported **533 passed / one
failed** (180045.387803ms). The existing independent-publisher race test returned
`WORKER_RSS_MONITOR_UNAVAILABLE`; it failed closed. No worker/monitor/cap code was
changed or disabled. The final complete rerun passed all 534 tests. Root cause of
that earlier monitor failure is not established; retain it as a resource-monitor
reliability limitation for independent re-QA, not evidence of a safe live publisher.
The initial new fault-injection test also targeted configureFailPoint at the fixture
application database; corrected the harness to use its disposable admin database.

Reproduce with all
four external DB selectors unset, an explicit local MONGOD_BINARY, `npm run
test:fresh`, `npm test`, frozen-contract and JS/MJS syntax checks. Use the combined
client's existing unit/build/archive browser configuration with CI=true and local
REACT_APP_API_URL=/api, then `fresh-browser.mjs --client "$CLIENT_CHECKOUT"`.

The PR body pins the corrected full head SHA. Independent systems/security QA
must review and reproduce that exact head before source acceptance. The prior
QA verdict remains FAIL for the old SHA; author evidence is not independent re-QA.

Release remains **HOLD**: pending fresh approval artifact; owner-selected real
UTC launch identity/date/time; isolated/scoped live publisher security review;
separately authorized exact-date collision/insert/verification; pinned server
deploy and client UI/cutover QA/promotion; monitoring and fresh-compatible rollback.
No production Atlas read/write, migration/deletion, live maze publication,
scheduler, v2 activation, merge, deploy, platform configuration change or GitHub
CI polling was performed.
