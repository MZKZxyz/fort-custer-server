# Publication release artifacts

Sprint 1.7G uses `fresh-release.json` for the owner's fresh-only archive decision.
It is deliberately **pending**, with no approved date, identity or approval.
See [fresh cutover contract and runbook](../docs/release/fresh-archive-cutover.md).
The real startup and default archive/start/daily routers now share
`services/publication/release-runtime.js`, which denies every legacy date and
independently checks the modern document's cutover/time/release binding. Startup
requires an explicitly reviewed `approved-fresh` artifact; there is no environment
bypass or hot unlock. Never copy approved synthetic fixtures into either file.

## Retained legacy schema (not active for fresh production admission)

`legacy-publications.json` is intentionally **unapproved and empty**. No positive
production publication inventory was supplied for issue #19, and no production
database was inspected. Never copy synthetic fixtures into this file.

The legacy artifact is still validated once per process by `legacy-runtime.js`.
An approved or nonempty legacy artifact conflicts with fresh startup and refuses
it. The inventory mechanism is retained for regression/audit; fresh production
does not use it for admission. There is no environment-selected path, network
fetch, date-range inference, hot reload or HTTP administration endpoint.

The fresh entrypoint permits empty/unapproved legacy inventory only when the
separate fresh decision is approved. Missing/malformed legacy config still fails
closed. Historical-inventory approval is no longer a release prerequisite.

## Legacy schema v1

| Field | Rule |
| --- | --- |
| schemaVersion | Exactly 1 |
| policyVersion | Distinct reviewed identifier, 1–64 lowercase letters/digits/hyphens |
| status | unapproved or approved |
| approval | null for unapproved; otherwise decisionRef, approvedAt, entriesHash |
| entries | Empty while unapproved; 1–3660 reviewed records when approved |
| entry.date | Real UTC YYYY-MM-DD, strictly ascending and unique |
| entry.gridHash | 64 lowercase hex characters, SHA-256 of the exact stored grid |
| entry.evidence | publicationRef, gridObservationRef, observedAt |

Every object must have exactly its schema's own enumerable data keys. Symbols,
accessors, custom prototypes and unknown/non-enumerable keys reject. References
are short audit identifiers using letters/digits and `/_:#.-`; they must resolve
in the separately reviewed evidence package, without personal identifiers or
credentials in this public artifact. Merely writing a reference does not prove
publication. Human review and an explicit owner-approved release commit are the
authorization; the JSON is not a cryptographic signature.

Times are exact UTC `YYYY-MM-DDTHH:mm:ss.sssZ`; date <= observedAt day <= approvedAt.
The loader also refuses an approval time later than its trusted startup clock.
No timestamps supplied by an HTTP client can approve an inventory.

`legacyEntriesHash(manifest)` returns SHA-256 of UTF-8 JSON.stringify of:

```text
["fort-custer/legacy-publications-v1", policyVersion,
 entries.map(e => ({date:e.date, gridHash:e.gridHash, evidence:{
   publicationRef:e.evidence.publicationRef,
   gridObservationRef:e.evidence.gridObservationRef,
   observedAt:e.evidence.observedAt
 }}))]
```

This fixes property order without depending on JSON file formatting. Entries
stay date-sorted. Any change to date, grid hash, evidence or policy version needs
a fresh digest and reviewed approval. The file is capped at 2 MiB by the loader.
After load, mutation of parsed input or the file cannot change active policy.

For the grid hash use the existing engine `hash(storedGrid)`: SHA-256 of UTF-8
JSON.stringify of the original 2D character array, with no trailing newline.
Do not trim spaces, join rows, normalize characters, change dimensions, regenerate
from seed labels, or rewrite a historical grid. The actual record must still pass
the shared publication predicate; a matching date with different bytes is hidden.

## Historical workflow — canceled for this fresh cutover

This retained schema reference is not an instruction to collect historical data.
Issue #22 cancels the proposed inventory; any different future product decision
would require separate owner authorization and source review.

1. Owner identifies a narrow exact date set and positive release evidence for
   each date. The old 2025 constants, row existence, seed labels, player progress
   and successful synthetic generation are insufficient evidence.
2. Obtain separate explicit authorization for a read-only observation of those
   exact stored grids, or an already authorized trustworthy snapshot. Bind the
   observation reference, UTC time and exact grid digest to the release evidence.
   Do not query player histories, rewards or unrelated dates; never export grids
   or credentials into public comments to establish the manifest.
3. Owner and independent reviewer reconcile every publication/observation pair,
   approve the inventory digest and decision reference, and review the manifest
   in a pinned source change. This task supplies no actual records or approval.
4. Validate the candidate offline before any rollout:

```sh
node --input-type=module -e 'import fs from "node:fs"; import {validateLegacyManifest} from "./services/publication/legacy-manifest.js"; const r=validateLegacyManifest(JSON.parse(fs.readFileSync(process.argv[1]))); console.log(r.status); if(!r.status.approved) process.exitCode=2;' config/legacy-publications.json
```

5. Restart only through a separately approved release. Record policyVersion,
   entriesHash, manifest source SHA and actual deployed image. A changed file in
   a running process has no effect. Rollback to a previously approved artifact
   and compatible image requires its own reviewed decision, not a broad unlock.

The owner selected the fresh-only alternative in issue #22. Follow
`docs/release/fresh-archive-cutover.md`; do not start the historical workflow.
