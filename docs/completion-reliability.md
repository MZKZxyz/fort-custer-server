# Reliable maze completions (Sprint 3)

## Contract and atomicity

`POST /maze/start` adds a server-generated UUID `attemptId` to the existing embedded attempt and response. Send that ID with `POST /maze/complete` alongside `subProfileId` and `date` (`YYYY-MM-DD`). Authentication resolves the owning user; lookup is scoped to that user's profile, date, and attempt. IDs are selectors, not credentials. An unknown ID never falls back to the latest attempt.

Completion uses the server's receipt time minus the persisted server start time, including the existing three-second minimum; client times are ignored. The first committed completion stores its exact JSON response (including a reward catalog snapshot, or null) on the attempt. Retries return that response without changing inventory, timestamps, daily progress, or the leaderboard. Deleted or renamed rewards do not change replayed responses. Completed results remain recoverable even if an attempt subsequently expires.

All affected state already lives in one User document. Mongoose optimistic concurrency makes its save a single version-checked atomic MongoDB update: attempt completion, result snapshot, inventory, progress and version commit together. A losing writer reloads and returns the winner's result; unrelated conflicts retry up to eight times, then return 503 with `RETRY_SAVE`. A crash before the write leaves no side effects; a crash or lost response after the write is resolved by retrying the same attempt. If no write happened, a later retry's server receipt time becomes the completion time. Client clocks cannot determine an earlier completion time.

No new collection, transaction, uniqueness index, or replica set is required. Server-generated UUIDs distinguish starts, and the document version acts as the concurrent write gate. Client-supplied IDs are never inserted. Different attempts may legitimately earn different rewards; concurrent completions reload inventory before choosing a reward. All User `save()` calls now use optimistic concurrency, so simultaneous profile edits may receive an existing route's error response and need a retry rather than overwrite newer game data.

Leaderboard ranking is unchanged: one progress entry per profile and date, with the most recently committed distinct completion replacing that day's time. Weekly/all-time totals and sorting are untouched. Replaying an older completion does not replace a newer day's score. Server validation of a solved path is outside this sprint; the existing minimum-duration rule remains.

## Existing data and compatibility

Changes are additive and lazy. No backfill, data deletion, reward reconciliation, or index migration is required. Existing Mongoose user documents already have `__v`; preserve it. Do not strip versions in maintenance scripts. Imported/corrupt users without a non-negative integer `__v` are rejected with 409 `PROFILE_VERSION_REQUIRED` before any completion mutation: Mongoose otherwise omits the version predicate. Any repair of such player data requires an explicit reviewed migration with writers drained; this sprint does not silently initialize versions. No automatic expiry/TTL policy is introduced. An optional persisted `expiresAt`, if present, is enforced for unfinished attempts; existing attempts without it remain playable. Invalid/future start times are rejected.

Old clients may omit `attemptId`: their latest attempt is selected and pinned across internal retries. New saves made this way also get a replayable response. Across separate legacy requests, an intervening start makes this inherently ambiguous: old clients cannot identify a previous attempt. Upgrade the frontend for safe refresh recovery and multi-tab behavior. Historical completed attempts without a response snapshot return 409 `LEGACY_COMPLETED` and never award again; their original reward cannot be reliably reconstructed. Previously duplicated rewards are not removed.

The legacy `/users/subprofile/:id/progress` write endpoint previously accepted arbitrary client times. It now returns existing saved progress without modifying it, or 409 directing callers to `/maze/complete`. The current client has no callers. Third-party clients relying on that endpoint must adopt server-started completions; this is an intentional compatibility restriction required for server-authoritative leaderboard data.

## Deployment sequence (instructions only; not executed)

1. Review the additive schema and legacy progress restriction. Confirm any other writers preserve User version checks. No database migration is needed for ordinary existing Mongoose records.
2. Drain/stop **all old API workers** before switching to the new backend, then start the new workers. Do not run old and new completion writers together: old code does not honor this response/atomicity contract and may award again or overwrite a snapshot. Treat an old-backend rollback the same way; do not serve pending retries through old completion handlers.
3. Validate completion/replay against staging synthetic data. Deploy the frontend only after the entire backend supports `attemptId` and saved responses. Old clients can continue using the updated backend subject to the limitations above.
4. Preserve saved response snapshots for as long as recovery is supported. Attempts and reward snapshots grow the already unbounded embedded arrays; the MongoDB 16 MiB document limit is an existing architectural constraint. Future archival/retention requires explicit design and player-data review, not a TTL on these results.

## Tests

Use Node and a local `mongod` binary:

```sh
MONGOD_BINARY=/absolute/path/to/mongod npm test
```

The suite spawns its own mongod on loopback with a temporary data directory and synthetic users, profiles, mazes and rewards; it never consumes `MONGO_URI` or starts the production entrypoint. It covers normal/legacy completion, simultaneous duplicates and distinct attempts, repeated replay after a new start, lost HTTP response after persistence, failure before persistence, invalid/expired/foreign attempts, immutable rewards and leaderboard consistency. Browser refresh and timeout recovery live in the companion client PR. The backend is unbundled JavaScript and has no production build script; syntax-check its application modules in addition to running integration tests.

## Concurrent sprint conflicts

This work overlaps the local `fix/maze-completion-reliability` branch's completion guard, User concurrency setting and integration-test intent; that branch is not the verified server main base. Do not independently merge its older 409-on-duplicate implementation over these handlers. Coordinate any other changes to User save/version handling, reward selection, maze start/complete, or the legacy progress endpoint. No open GitHub PRs were returned for either repository when inspected; unpushed simultaneous work cannot be discovered through that listing. The client's previous shared-movement sprint is already in its main base; movement rules and board sizing are unchanged.
