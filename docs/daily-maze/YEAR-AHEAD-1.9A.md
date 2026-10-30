# Sprint 1.9A — private annual maze generation

Issue [#36](https://github.com/MZKZxyz/fort-custer-server/issues/36), parent #35.
Branch: `codex/sprint-1.9a-private-year-ahead`. Starting main was reverified as
`cec541d71f83eca42463182b62c00433acc53746`. Implementation/experiment revision:
`e9e2715fc620f5147b730e59a79e96fb349315e3`. The final tested PR head is recorded in
the PR's exact-head QA handoff (a document cannot contain its own commit SHA).

This is offline, nonproduction engineering. No launch date, production batch,
final mix, owner approval, publication, scheduler, database/role provisioning,
server/client deployment, client PR #54 merge, or 1.9B advancement is authorized
by this result. Production `LIVE_APPLY_BLOCKED`, the fresh release configuration
PENDING, existing publication guards, and deployed Railway revision
`8e3eac84f7081f3b1a51df317b35f782d64561db` remain untouched.

## Run and recover (Node 24, local POSIX filesystem)

Use an explicit absolute private root **outside every Git checkout, build and
served directory**, on a trusted host. The tool rejects public/static/dist/build
ancestors, symlinks, group/world-accessible stores, foreign ownership, unexpected
files, and shared hard links. Store directories are 0700; artifacts are 0600.
Do not redirect private records through the older preview CLI, which prints seeds
and grids. The new CLI emits aggregate allowlisted JSON and static error codes;
it never emits date-specific records, hashes, seeds, paths, or stack traces.

```sh
# Representative fixture only; 2031 is not a launch-year decision.
node tools/year-ahead/cli.js --command create \
  --root /absolute/private/store --id normal-fixture --year 2031 \
  --plan tools/year-ahead/experiment.json --source-revision <40-character-source-commit>
node tools/year-ahead/cli.js --command generate --root /absolute/private/store --id normal-fixture
node tools/year-ahead/cli.js --command validate --root /absolute/private/store --id normal-fixture
```

`create` exclusively creates a batch: it never replaces an existing directory.
Its checksummed frozen manifest contains the exact canonical plan, UTC dates, algorithm/RNG
configuration, source revision, computational source digest, Node version,
creation instant and independent 256-bit `randomBytes` seeds. Its creation-time
content checksum is verified before every load, including incomplete batches;
valid-shaped seed/config corruption therefore fails before generation. Each date has up to
16 independent bounded seed candidates (8 in the experimental plan). The existing
`daily-dfs-v1` generator owns its own bounded internal retries (32 here).
Each accepted private record preserves the seed, full grid, version/config,
identity/grid hashes, rejected-candidate traces, analyzer output, solution and
elapsed generation time. No new generator or database dependency is introduced.

Tier names, integer weights, dimensions and optional inclusive `minActions` /
`maxActions` bounds are explicit plan inputs. Weights form a repeating schedule;
they are not randomized or a proposed production weekday schedule. The shipped
`small-sample` / `middle-sample` / `large-sample` plan is a balanced size experiment,
not an approved easy/medium/hard distribution. Failed quality bounds try the next
private seed. Exhaustion stops before sealing; accepted earlier records survive.
Rejected trials are stored in successful records; an exhausted date can be
reconstructed from all frozen seeds but has no saved timing/exception artifact.

Restart `generate` against the same directory: it replays and verifies existing
records, then fills missing dates. Altered source digest, seed/config, date list,
metrics, grid, solution, duplicate seeds, identities or grids fail closed.
`COMPLETE.json` seals the manifest and every full record only after all 365/366
UTC dates pass. Revalidation checks the seal and reproduces all selected and
preceding rejected candidates. An absent/corrupt artifact never triggers silent
replacement. A changed plan or source requires a new batch ID and QA.

A mkdir lock excludes concurrent writers; validation refuses an active lock.
After a killed process, `--command recover-lock` removes only a same-host lock
whose recorded PID no longer exists. Active/reused PIDs, other hosts, malformed
or missing lock metadata require operator investigation. Then run
`--command cleanup-temporary` to remove interrupted atomic-write remnants, and
resume/revalidate. Cleanup only removes recognized private temporary files and
checks sealed data afterward; it never deletes/replaces records or whole batches.
An external owner-managed `APPROVED.json` marker blocks all mutating commands;
the tool does not grant approval. Read-only validation remains available. Whole
batch deletion, migration and damaged-lock recovery are deliberate owner custody
operations, not automatic cleanup.

Atomic exclusive hard-link installation plus file/directory fsync targets local
POSIX disks. Symlink/permission checks are defense in depth on a trusted host,
not protection against a hostile same-UID process racing filesystem checks.
Do not use a network filesystem or a public/shared writable host for custody.
The preserved versioned generator uses a **32-bit deterministic RNG state**;
256-bit private seeds remove predictable date defaults but do not upgrade that
RNG to cryptographic grid security. Duplicate-grid detection is still required.

## Annual quality evidence

The private fixture dates cover calendar years 2031 (365) and 2032 (366), including
leap day. They are disposable research fixtures, not release assignments. Full
aggregate distributions, retry reasons, score, movement inputs, turns, branches,
dead ends, alternate-route proxies and timings are in
[`ANNUAL-QUALITY-1.9A.json`](ANNUAL-QUALITY-1.9A.json). No date-to-result mappings,
private hashes or selected puzzle identities are included.

| Metric | Normal fixture | Leap fixture |
| --- | ---: | ---: |
| Accepted / expected | 365 / 365 | 366 / 366 |
| Sizes 13×17 / 17×19 / 21×21 | 122 / 122 / 121 | 122 / 122 / 122 |
| Existing heuristic easy / medium / hard | 244 / 117 / 4 | 248 / 111 / 7 |
| Optimal required inputs min / median / p95 / max | 24 / 55 / 118 / 200 | 24 / 55 / 113 / 196 |
| Movement steps median / p95 | 55 / 117 | 54 / 113 |
| Direction changes median / p95 / max | 18 / 37 / 64 | 17 / 36 / 62 |
| Dead ends median / p95 | 9 / 14 | 9 / 14 |
| Branch cells median / p95 | 7 / 12 | 7 / 12 |
| Internal candidate rejections | 298 | 274 |
| Exhausted dates / accepted solvability failures | 0 / 0 | 0 / 0 |
| Reachable extinguisher / required-fire optimal routes | 365 / 228 | 366 / 226 |
| Generation-only milliseconds median / p95 | 0.598 / 1.311 | 0.627 / 1.348 |

There were 572 rejected internal candidates in 1,303 attempts (43.90%); bounded
retry recovered every date. Reasons: 535 legacy fire/extinguisher reachability,
35 extinguisher-after-exit, 2 endpoint distance. Accepted invalid/unsolvable grids,
solver limits and terminal generation failures were 0/731 (observed sample rate,
not a reliability guarantee). All have exactly one S/E/X/F and closed borders;
all extinguisher pickups are reachable before terminal exit. Fire is required on
454 optimal routes (62.11%) and optional on 277. Generation-only timing includes
carving, retries and analysis, but excludes writing, revalidation and startup;
these shared-host timings are not an SLA. The largest single trial was 6.119 ms.

Required inputs count the separate extinguish input that consumes the inventory
without moving; movement steps exclude it. Turns count changes between optimal
directional inputs, including reversal/backtracking; they are a route-complexity
proxy, not human exploration. All geometric cycle ranks were zero and all shortest
solution counts were one. These tree mazes have no geometric alternative route;
cycle rank does not estimate arbitrary longer playable action sequences.

| Size | Normal actions median / p95 | Leap actions median / p95 | Total samples |
| --- | ---: | ---: | ---: |
| 13×17 | 44 / 76 | 45 / 91 | 244 |
| 17×19 | 55 / 117 | 57 / 107 | 244 |
| 21×21 | 78 / 132 | 72 / 130 | 243 |

Larger grids trend longer, but overlap substantially. The normalized existing
score labels larger layouts easy despite more inputs; only 11 hard labels
occur across the 731 samples. Do not equate dimensions or existing heuristic score with
player difficulty. `minDistance:25` measures pre-placement path vertices, so eleven
accepted solutions need only 24 inputs. An approved action floor should use the
new explicit bound rather than changing the versioned engine.

Proposed first playtest rubric, **pending owner approval**: easy 25–49 required
inputs with at most 16 turns; medium 50–89 inputs or 17–29 turns; hard at least 90
inputs or at least 30 turns, with the higher tier winning. Flag over 160 inputs
for fatigue review rather than treating maximum length as quality. Assess fire
necessity, pickup detour, dead ends, fog/exploration and actual completion times
before adopting thresholds. No production acceptance rules or tier proportions
are enabled; collect player evidence before proposing a final annual mix.

Manual outlier cohorts: 31 routes exceed 120 inputs, 11 are under 25, 2 exceed 60
turns, and 277 bypass fire optimally (cohorts overlap). Compare the longest route
in each size with short/optional-fire examples; the 13×17 long tail is especially
useful for testing whether score normalization misleads. Exact selections and
metrics are in the **private** playtest shortlist; no date/index/hash is published.

At 320 CSS pixels of usable maze width, 13/17/21 columns imply approximately
24.6/18.8/15.2 pixels per tile before margins (360 px: 27.7/21.2/17.1). Investigate
legibility, viewport height, scaling, fog visibility, controls and panning for
17×19/21×21. This is arithmetic, not device validation. No physical mobile device
or client visual/input coverage is claimed.

## Private staging and custody

**Recommend an offline private batch for 1.9A.** It has no runtime database read
path, no deployment dependency and no new infrastructure. A separate Atlas
staging collection would improve durable recovery and shared operator access,
but only if the web identity is explicitly unable to read it, separate least
privilege identities are reviewed, and backup/restore/export access is audited.
A collection name alone is not isolation. That provisioning requires separate
authorization; none was created or queried here. Never use live `mazes` as staging:
the deployed old `/maze/start` exposes any existing future record to a valid user.
The newer API's guard is not protection for that deployed old code.

Exact current custody: private 0700 directory
`/workspace/private-maze-batches-1-9a/`, with final `final-normal-fixture/`, `final-leap-fixture/` and
0600 `playtest-shortlist.private-maze.json`. The earlier unapproved
`normal-fixture/` and `leap-fixture/` remain intact as superseded research evidence
from the earlier implementation revision; they are not the report dataset. Batches are outside
`/workspace/fort-custer-server`, untracked, unapproved and never inserted into
Atlas or any HTTP fixture. The application does not mount this directory. This
cloud workspace is **ephemeral**, is not a backup, is not encrypted by this tool,
and is accessible to the workspace operator; mode bits do not isolate the same
OS identity. No external backup/export was made and no durable recovery promise
is made. Losing the manifest/private random seeds loses reproducibility.

Before retaining real release candidates, the owner must designate a durable
private location within existing infrastructure, its access/backup operator,
encryption and recovery/retention process, and validate a restricted restore.
Back up the complete sealed directory plus the exact source revision/runtime;
verify its seal and deterministic replay on restore. Do not add these records to
Git (even a private branch), builds, client bundles/maps, CI artifacts, logs,
issue attachments or public report evidence. Existing build/runtime integrations
were not changed. Package file/content scanning found no retained private
seeds, grids, solutions or identity/grid hashes in the application package.

## Sprint 1.9D design only — one eligible date

1. Obtain separate owner authorization for custody and publication; retain current
   production blocks until that release is explicitly approved. Coordinate the
   guarded server-first rollout and later client PR #54 separately.
2. Under a restricted offline/backend identity, validate the sealed approved
   batch and select exactly one explicitly requested UTC date. Sample trusted UTC
   once; require the date to equal today's eligible publication date and satisfy
   the existing guard. No ranges, catch-up loop, web-accessible importer or
   scheduler is added. Test date boundaries and future refusal again.
3. Reproduce the preserved private seed/version/config and compare its exact
   identity/grid to the approved record. Construct the existing publication
   document from that record. Do not use the predictable date default or change
   the guard to admit future data.
4. On the existing unique date index, insert one complete record without update,
   replace, upsert-overwrite or transactions involving other dates. An existing
   exact winner is an idempotent no-op; a different identity is a conflict for
   owner review, never replacement. A duplicate-key loser rereads the immutable
   winner. For lost acknowledgement, reconcile by the one date and compare before
   any retry; do not generate another seed.
5. Audit only the authorized released date and coarse outcome; keep seed/grid,
   identity hashes, solutions, staging pointers and diagnostics private. Confirm
   readback through the intended guarded API; retain the sealed source. If a wrong
   row is discovered, stop for recovery review rather than automatic deletion or
   overwriting. Verify surrounding future dates are absent and inaccessible.

This design is not executable publication authority. No publisher adapter,
production connection, staging collection, role, cron or guard change is added.

## Verification and review handoff

Node v24.19.0; local MongoDB v8.0.16. Tests use temporary files, disposable loopback
HTTP and MongoDB fixtures with ambient database selectors unset. New tests cover
both complete years, preserved-seed reproduction, all-record client movement
completion, leap centuries/UTC/DST, rejection bounds, corrupt/incomplete batches,
duplicate seeds, real SIGKILL interruption and resume, sealing interruptions,
symlinks/permissions, stale locks, approved immutability, offline capabilities,
sanitary CLI errors/output, and package leakage. The old-router excerpt is frozen
from deployed revision `8e3eac8…`, mounted only by the new HTTP test; valid auth
exposes a deliberately poisoned future normal row on old code and is denied on
new code. Both deny unauthenticated requests; both return 404 when private staged
data is absent from normal lookup. These are disposable repository seams, not
production or Atlas permission testing.

- `node --test test/year-ahead.test.js test/year-ahead-api.test.js`: **15 passed,
  0 failed, 0 skipped**, 6.129 seconds on implementation revision above.
- Full `npm test`: **684 passed, 0 failed, 0 skipped** before the checksum fix.
  The post-fix exact-head full run is recorded in the PR handoff.
  Exact final-head verification is recorded in the PR handoff.
- Both retained annual batches revalidated with byte-identical aggregate output;
  **731/731** retained mazes completed through the separate client movement fixture.
- Private fingerprints scanned against `npm pack --dry-run --ignore-scripts` file
  contents: **198 files against 17,544 private fingerprints, zero leaks**
  (both final and superseded private fixtures).
  Source syntax and `git diff --check` also checked.

Changed files: `.gitignore`, `package.json`, `tools/year-ahead/{batch.js,cli.js,
metrics.js,experiment.json}`, `tools/test-support/{year-ahead-offline.mjs,
year-ahead-old-router.js}`, `test/{year-ahead.test.js,year-ahead-api.test.js}`, and
`docs/daily-maze/{YEAR-AHEAD-1.9A.md,ANNUAL-QUALITY-1.9A.json}`. No runtime
application, movement, publication guard, personal-best, reward, leaderboard or
art logic changes.

Request independent Gameplay/Server/Security QA on the **exact final PR head**:
replay/solvability and fire consumption, difficulty/outlier quality, seed handling
and reproducibility, interrupted-batch custody, staging isolation, public-output
and build non-disclosure, and old/new API behavior. Automated checks do not replace
human playtesting or independent release approval. Owner decisions outstanding:
launch/calendar assignment, supported mobile sizes, rubric and yearly mix,
required-fire policy, long/short exclusions, durable private custody/backups, and
separately authorized 1.9D publication/rollout. Stop at draft review.
