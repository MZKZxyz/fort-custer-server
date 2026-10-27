# Published mazes and archive — Sprint 1.7C

Implements issue #17 on exact main baseline
`6ff49d10d7fa6679b9f3e1f88ba032df0b0c45c4`, the approved squash merge of generator
PR #16. Parent #6 remains the umbrella for later rollout and scheduling. The
reviewed client issue #50 contract is the API handoff; client implementation is
separate Sprint 1.7D work. No live publication, database access, deployment,
legacy seeder execution or v2 enablement is part of this change.

## Publication authority and immutable content

`services/publication/policy.js` provides the shared `isPublished(maze, now,
legacyPolicy)` predicate. Archive, new legacy-route starts and daily leaderboards
all use it. Each request captures one trusted server Date; civil offsets, client
timestamps, local storage and debug flags cannot supply that clock.

A new publication requires:

- A real date in years 0001–9999 no later than the captured UTC day.
- A complete stored grid with matching dimensions, one S/E/X/F, valid tiles,
  intact border, and a verifiable content hash.
- `publicationEra: "year-round-v1"`, explicit `publishedAt` no later than the
  captured instant, and complete `maze-publication-v1` provenance.
- Supported algorithm/config/RNG versions, canonical config and correct
  seed/config/identity hashes; a bounded contiguous attempt trace ending in
  ACCEPTED. The publisher's worker verifies gameplay with the approved solver.

Publication metadata is additive and embedded in the same Maze document as
content, so a single insert makes the complete record visible atomically:

```text
date, seed, grid, width, height, collectibles             # existing content
publicationEra, publishedAt
provenance:
  manifestVersion, algorithmVersion, configVersion, rngVersion
  config, configHash, identityHash, gridHash
  acceptedAttempt, attempts[{attempt,code}]
```

Mongoose explicitly persists the provenance subdocument with strict unknown-field
refusal. Markerless historical rows remain loadable and saveable without adding
publication fields. Content and publication fields are immutable; nested content
changes on save and model query updates/replacements are refused. The publication
library only inserts. Privileged raw collection operations remain outside this
application boundary; tests use them exclusively to construct corrupt fixtures,
simulate catalog loss, or clean up disposable databases.

The unique `{date:1}` index is retained. An additive
`{publicationEra:1,date:1,publishedAt:1}` index supports the modern archive bounds.
No migration or index synchronization command runs in this task. Production
index creation, including Mongoose auto-index behavior on an eventual deployment,
requires release review before rollout.

### Markerless legacy policy: deny until confirmed

There is **no approved production inventory in source**. The default legacy
policy is deliberately empty; old seasonal constants and the existence of a
markerless row do not establish publication. Unknown markerless rows are retained
unchanged and unavailable to archive/start/daily admission until confirmed.

`createLegacyPolicy` accepts at most 3,660 reviewed entries, each with real
`date`, exact `gridHash`, and a nonempty evidence reference; duplicate dates and
malformed entries reject. A matching date with different content remains hidden.
No historical grid, seed, score, reward or user history is reconstructed or
rewritten. Synthetic tests inject their own explicit fixture policies, including
the existing completion and compatibility harnesses. Those policies are never
imported by the production application.

**Release gate:** obtain positive evidence for intended legacy releases and
review the exact date/hash inventory before deploying these guards for legacy
players. An empty policy is safe but intentionally makes old markerless mazes
unavailable. Expanding the inventory needs review; never auto-approve a range.

## HTTP contract

`GET /api/maze/archive?month=YYYY-MM` is public. Omitted month means the captured
server UTC month. It returns only actual eligible publications in ascending
order, at most 31 items; a month is the complete page and has no cursor/offset.
Past holes, missing days and future valid months produce successful empty or
partial pages, never generated dates or attempts.

```json
{
  "today": "2028-03-01",
  "serverNow": "2028-03-01T12:00:00.000Z",
  "nextDayAt": "2028-03-02T00:00:00.000Z",
  "month": "2028-02",
  "firstPublishedDate": "2028-02-28",
  "lastPublishedDate": "2028-03-01",
  "todayMaze": {"date":"2028-03-01","publicationEra":"year-round-v1","available":true},
  "items": [
    {"date":"2028-02-28","publicationEra":"year-round-v1"},
    {"date":"2028-02-29","publicationEra":"year-round-v1"}
  ]
}
```

This is a synthetic example. Bounds cover eligible publications across both eras,
not just the requested month; they do not promise intervening dates exist. Empty
catalogs have null bounds and `todayMaze:{date:today,available:false}`. The next
UTC boundary is a clock hint, not a promised publishing time. At the upper domain
edge, ISO `nextDayAt` can use extended year +010000; no year-10000 date is admitted.

Optional `subProfileId` requires Bearer authentication and ownership. The only
added field on eligible items and available todayMaze is
`progress:{completed:boolean}`, derived strictly from the owned profile's saved
progress. The database projection returns only that matched profile's requested
month/today completion booleans (at most 32 dates). There are no profile identifiers/names/ages, attempts, histories, rewards,
credentials, grids, seeds or provenance in an archive response. Metadata-only
responses omit progress; omission means unknown, not incomplete.

| Condition | Status/code |
| --- | --- |
| Invalid real month/date | 400 INVALID_MONTH / INVALID_DATE |
| Duplicate, bracketed or unknown catalog/daily scalar query | 400 INVALID_QUERY |
| Malformed private profile ID with valid auth | 400 INVALID_PROFILE_ID |
| Missing/invalid auth for private projection or start | 401 |
| Foreign or absent valid profile ID on archive | Same 404 PROFILE_NOT_FOUND |
| Missing/unpublished/future start or daily date | Same 404 MAZE_NOT_PUBLISHED |
| Read/database/integrity budget failure | 503 ARCHIVE_UNAVAILABLE / LEADERBOARD_UNAVAILABLE |
| Valid empty/past/future month | 200 with actual eligible items, possibly empty |
| Published daily date without saved times | 200 [] |

Raw URL parameters are validated independently of Express's query parser. Strict
Gregorian validation covers 1900/2000 leap rules and years 0001/9999, rejecting
year 0000, normalization, whitespace and timestamp date keys. Starts/completions
also retain readable validation errors with stable INVALID_DATE/INVALID_PROFILE_ID.
Authentication precedes private profile validation; cardinality errors precede auth.

### Bounded reads, integrity and caching

Month reads use at most 31 explicit real date keys and the date index; the today
read is one exact date. Global first/last are indexed forward/reverse scans,
separately scoped to modern publications and the finite legacy inventory. Each
scan examines at most 32 candidate documents, streaming one at a time. If that
budget is exhausted on corrupt/ineligible records, return a private 503 instead
of inventing empty bounds. There are at most six initial find operations and
160 examined documents (31 month, one today, four scans of 32); no all-history
application scan or unbounded response. Find commands carry a 2-second server query budget; driver transport
timeouts are a separate concern. This is not a transactionally frozen catalog snapshot: concurrent
insert-only additions appear on refresh.

**Integrity tradeoff:** public output is metadata-only. Internal bounded queries
also fetch the content/manifest fields needed to recompute and check grid hashes.
This deliberately costs more than the proposal's metadata-only database projection
and avoids trusting a stale persisted "valid" boolean. No generator or solver runs
in API handlers. For larger catalogs, profile the bounded reads before adding an
immutable verified-manifest read index/cache; do not weaken the shared predicate
silently. Database transport failures must remain errors rather than empty pages.

Anonymous public metadata may cache for at most 60 seconds, rounded down and
capped before the UTC boundary. Monotonic request elapsed time is deducted from
that budget; the final partial second uses `private, no-store`. All profile
projections, requests carrying Authorization, catalog errors, starts/completions
and daily responses use `private, no-store`. Archive responses vary on
Authorization. No durable negative cache or new conditional-cache protocol exists.

### Existing start, daily scores and recovery

`POST /api/maze/start` retains `{subProfileId,date}` and returns
`{maze:{grid,width,height},seed,today,attemptId,attemptIndex}` from the stored row.
It checks ownership and publication before compatibility/version guards and any
attempt append. Unpublished dates never append an attempt, even via direct POST.
Existing writer compatibility and optimistic-concurrency behavior remain intact.

Daily leaderboard dates now use the same publication guard instead of the 2025
summer restriction. The JSON array remains
`[{name,subProfileId,time,completedMazes}]`. It still represents **legacy saved
results**, derived from the latest completed progress per profile/date; this is
not an official validated competition or a new best-time policy. Weekly/alltime
logic is unchanged; weekly retains its legacy summer clamping. The archive does
not promote either view to official v2 ranking.

Completion has **no new publication lookup**. A valid already-started attempt
can finish after midnight or catalog unavailability. Saved UUID snapshots replay
under their original account/profile/date without another reward, including after
profile switching and compatibility drains. The unchanged v2 route/service stays
disabled; only the compatible bundle's v1 router accepts an injected publication
policy for disposable tests. The frozen integration contract changes only two
source hashes; all protocol examples and endpoint/result semantics stay unchanged.

## Strict ingress and constrained generation

The approved `lib/maze` engine and all v1 hashes/fixtures remain byte-for-byte
unchanged. Publisher ingress is a separate wrapper:

- Top-level input and config must have Object.prototype, only allowed own
  enumerable data keys, no symbols, accessors, inherited custom prototypes,
  non-enumerable properties, arrays, Date objects or undefined overrides.
- The library accepts only a trusted Date or integer epoch for admission; strings
  cannot authorize a publication. No ambient clock or caller-supplied HTTP instant
  is used. A date after the supplied trusted UTC day rejects before generation.
- The offline CLI alone accepts explicit ISO instants: seconds required, optional
  1–3 millisecond digits, Z or quarter-hour offsets from -12:00 through +14:00.
  Unknown offset -00:00 and exotic +23:59/+14:01/+15:00 offsets reject. This is
  an explicit numeric civil-offset policy, not IANA-zone validation. DST/travel
  are resolved by the supplied offset. It never changes the API's clock.

`generateInWorker` forks a private computation child. The parent has one active
slot, no waiting queue and GENERATOR_BUSY refusal. Limits:
1,500 ms wall-clock watchdog including startup, 48 MiB old-space, 4 MiB semi-space,
128 MiB process RSS ceiling, 10 ms Linux /proc high-water sampling and 256 KiB IPC
message cap. Limits may only be tightened. The child also reports OS peak RSS;
over-budget results are refused before any insert, even if the monitor missed a
short peak. Before dispatching generation, the parent must obtain a valid active
RSS sample. Missing/inaccessible procfs while the child remains alive terminates
the worker with `WORKER_RSS_MONITOR_UNAVAILABLE`, including persistent `ENOENT`
and `EACCES`; no result can reach insertion. Only confirmed process exit (Node
exit/close, OS zombie status or an OS `ESRCH` liveness check) permits missing
process information during cleanup. Pending reads are aborted/raced against
confirmed exit so late cleanup callbacks cannot retain or poison the execution
slot. An active reply alone is not proof that the process has exited.

The child has a minimal environment, no Mongo credentials/NODE_OPTIONS, denied
filesystem writes/process spawning via Node permissions, and no model/network/
writer imports. **Node 24 permission flags do not deny TCP/network connections.**
The current computation graph does not import a network client, but this is not
OS-enforced network isolation. A live publisher requires separately reviewed
network/egress containment; the absence of credentials or imports is not a
network-denial sandbox.

The RSS watchdog is sampled, not an OS hard cgroup limit; a process can transiently
overshoot between samples. Heap limits alone are not an RSS guarantee. SIGKILL,
timer/monitor cleanup and slot release wait for child closure. Per-process
concurrency does not coordinate separate operator processes; deployment-wide
resource isolation/concurrency ownership must be reviewed before live use.

## Dormant insert-only writer and operator runbook

`publishMaze({model,input,now})` is unhooked: no routes/startup/scheduler import it.
It requires an explicit connected model whose DB name matches
`fc_publication_synthetic_*`, only loopback hosts, no SRV/auth principal, finite
driver selection/connect/socket timeouts no greater than five seconds, and a
nonpartial nonsparse unique date index. Fixture timeouts are 2s selection/connect
and 3s socket, above the 2s command budget. These are short loopback-test settings,
not recommendations for the live API. The library never opens a connection.
Any production-shaped handle is refused with LIVE_PUBLICATION_NOT_AUTHORIZED.

1. Validate scope, input, date and index. Read an existing exact-date winner first.
2. Return any existing row unchanged, without generating or normalizing it. An
   identity/hash/manifest mismatch reports STORED_WINNER_IDENTITY_MISMATCH.
3. If absent, generate in the constrained worker, validate the complete manifest,
   and create one atomic document using majority write concern. No upsert, $set,
   replacement, alternate seed or automatic application-level write retry exists.
4. On duplicate key, re-read and return the exact stored winner, including when
   candidate identities/hashes disagree. On ambiguous insert/network loss, return
   PUBLICATION_UNCERTAIN; retry the **same** identity later. If the original insert
   committed despite lost ACK, that retry returns its immutable winner.
5. Timeout, memory limit, busy slot and deterministic exhaustion leave the date
   absent. Missing-day reads never auto-generate/backfill or silently substitute a
   previous date. Operator monitoring should alert on the stable reason codes.

The CLI has **only dry-run**, and never imports mongoose/models/the writer:

```sh
npm run maze:publication-preview -- --date 2028-02-29 --at 2028-03-01T00:00:00Z
node tools/maze-publisher/cli.js --date 2028-01-01 --at 2028-01-01T00:00:00Z \
  --config '{"width":21,"height":21}' > preview.json
```

Explicit `--at` is a simulation clock. With it omitted, preview uses its own
current clock; neither mode writes anything. Output contains the proposed stored
document, difficulty/solver summary and measured elapsed/peak RSS. Failure has
empty stdout, structured code/diagnostics on stderr and exit 1. `--apply` is an
unknown option; ambient Mongo URIs never enable a writer. The older 1.7A CLI
remains an offline research tool and is not the constrained publisher ingress.

### Manual future enablement — separate owner GO

Before any API deploy, approve the legacy date/hash inventory and additive schema
and index behavior, independently QA the pinned PR, and smoke-test old-client
start/result recovery with the intended catalog. Confirm missing-day UX and the
client 1.7D debug/season changes separately. Keep the previous approved image as
rollback and `FC_SESSION_V2_ENABLED` absent; auto-update remains a separate gate.

Before any live maze insert, a later reviewed adapter must deliberately replace
the disposable-only capability with explicit scoped authorization, fixed identity
and operator-approved date list. Review production connection timeouts from real
latency and topology rather than copying fixture settings. Measure current/total
connections, checkout waits/failures and command latency before changing pool size.
Set a deployment-wide worker count, OS/container memory containment, explicit
network/egress isolation and monitoring;
verify backup/read-only inventory access and least-privilege insert/read authority.
Each live publish/backfill execution needs owner authorization. There is no
environment flag here that grants it. Scheduling and automatic backfill need a
separate design/approval after this manual workflow is proven.

Resource planning assumption only: budget roughly 128 MiB child RSS plus parent,
API, buffers and database connections; this is not a verified hosting plan limit.
Do not co-locate an unbounded number of workers with a small shared API instance.
If publication is late or fails, keep today unavailable, alert, inspect diagnostics
and retry the exact approved identity after recovery. A budget/version change is
an explicit new identity decision, never a hidden reroll. Never repair by running
legacy seeders or overwriting a prior publication.

Rollback is code/image rollback, with no database reseed, historical rewrite or
metadata deletion. Inserted publications remain stored authority; old images must
be separately assessed for future-date admission before exposure. No operation
in this task changes the currently deployed image or data. Exact executed tests
and remaining limitations are in [validation evidence](publication-validation.md).
