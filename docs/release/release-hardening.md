# Sprint 1.6B release hardening

This change addresses issue [#12](https://github.com/MZKZxyz/fort-custer-server/issues/12),
following the completed [#11 preflight](https://github.com/MZKZxyz/fort-custer-server/issues/11#issuecomment-6431828582).
It fixes test isolation and prepares a reviewed count-only schema assessment; it does
not authorize executing that assessment or releasing the server.

## CI isolation

The pinned baseline is `983f1b20f0dd20d9435c9faae7cf4524c71c6e6f`. Its workflow set
`MONGO_URI=mongodb://127.0.0.1:1/unused_ci_database`, which the new disposable harness
correctly rejects even though that URI is synthetic. Fresh reproduction: **445 tests,
404 passed, 41 failed**, all harness failures from `INTEGRATION_EXTERNAL_CONFIGURATION_REFUSED`.

The job-wide selector is removed. The actual test step uses Bash strict mode and
explicitly unsets `MONGO_URI`, `MONGODB_URI`, `MONGO_URL`, `DATABASE_URL` before automatic
`npm test` discovery. This covers inherited runner settings, including empty strings.
The harness's external-selector refusal is unchanged. A workflow regression test
executes the real shell block with all four selectors poisoned and npm substituted
with a strict environment/argument assertion; another test checks the actual suite
environment. No integration suite is skipped, replaced by an analyzer-only subset or
pointed at a shared database.

| Prior gate | Resulting workflow |
| --- | --- |
| Ubuntu 24.04, Node from `.nvmrc` (`24`), 15-minute job, job concurrency cancellation | Unchanged |
| `NODE_ENV=test`, synthetic JWT signing material, `npm ci`, npm cache | Unchanged |
| Local MongoDB 8.0.16, downloaded SHA-256 validation, no shared service/seeder | Unchanged |
| File-presence checks and full `npm test` discovery, all 41 harness cases | Preserved, now with genuinely unset database selectors |
| Tracked JavaScript syntax check | Unchanged; new `.mjs` modules also receive local syntax verification |
| Seeded CLI, 1,000-maze sample, 10,000-maze memory-bounded benchmark and deterministic report checks | Unchanged |

For a local full run, use the clean-environment command in the
[schema assessment procedure](schema-assessment.md); for CI equivalence, execute the
workflow's actual full-test shell block, including its `unset`, with synthetic inherited
selectors. Fresh engineering validation on Node **24.19.0** / local MongoDB **8.0.16**:

- Original pinned workflow environment: **445 total, 404 passed, 41 failed**, no skips.
- Corrected workflow's actual shell block, launched with all four inherited selectors
  present (both nonempty and empty values): **461/461 passed**, zero failed, cancelled,
  skipped or todo; 67.54 seconds. This includes the original 445 tests and 16 new
  CI/audit checks, with authenticated disposable replica-set audit fixtures.
- The explicitly approved database-name scope includes `test` (never chosen implicitly),
  matching the later metadata-only context on #12. That metadata does not establish
  the Railway database target or authorize a live audit; exact scope and read-only
  privilege checks still apply. Admin/system databases remain refused.
- Seeded CLI, 1,000-maze sample, memory-bounded 10,000-maze benchmark and deterministic
  report checks passed. The full regression run includes production installer OFF /
  explicit-true blocking and all 41 existing disposable harness cases.
- Locked `npm ci` succeeded. Additional disposable integration smoke passed with
  `untimed` timing and one awarded collectible; this does not activate production v2.

Independent QA must publish its own evidence and verdict on the full draft-PR head
SHA. Do not poll GitHub Actions to obtain that evidence.

## Release and rollback gates retained

- Production baseline remains **`c4f480abb309a7a4d141b20ab462552a868ef0e3`**, Railway
  deployment **`696a04d0-4aa0-4171-be51-4e1acb4693b7`**. It was rollback-capable in #11;
  that observation is not a guarantee of future image retention or availability.
- Former proposed **`983f1b20f0dd20d9435c9faae7cf4524c71c6e6f`** is now only the comparison
  baseline. This PR produces a **new proposed deployment SHA**. Independent QA must pin
  the full PR head; after merge, the owner must separately pin and review the actual
  resulting release SHA, including any squash/merge difference. Recheck branch HEAD
  immediately before any future manual deployment; a moved SHA stops release.
- Production `index.js`, all v1 routes/models/writers, v2 runtime/activation interlock,
  dependencies/lockfile, build defaults and Railway/Vercel configuration are unchanged.
  `FC_SESSION_V2_ENABLED` stays unset. Explicit `true` remains startup-blocked before
  MongoDB access/listen. Earlier gameplay QA still applies to unchanged gameplay code;
  it does not substitute for review of this new release candidate.
- **Any adopted profile or shared-writer state is a HARD NO-GO** for this legacy-writer
  refresh and for reverting to older code. V1 still has per-attempt rewards and latest
  completion ranking. Do not claim once-per-date rewards, best-time migration or v2
  activation. Server #5/#7 all-writer/provenance/clock/staging/privacy gates remain.
- Required sequence: hardening QA → separately authorized count-only schema assessment
  and owner disposition → explicit approval of the manual pinned Railway release →
  terminal SUCCESS, correct SHA, 1/1 replica and live public read checks → separately
  authorized existing test-account v1 smoke and the #11 fifteen-minute watch.
- Recheck the old deployment's rollback/redeploy availability immediately before and
  after release. Ordinary redeploy repeats a deployment's code; it does not select a
  new source SHA. A future deliberately pinned deploy can use the Railway documented
  `serviceInstanceDeployV2(..., commitSha:...)` path from #11; none is invoked here.
- The existing service has no explicit HTTP healthcheck. Root starts after Mongo
  connects but does not test ongoing DB readiness. Use #11's root text, public catalog
  array and historical in-season leaderboard GETs, `/api/v2/capabilities` 404 and
  unauthenticated profile 401 checks. A tool/DNS limitation is unverified health, not
  an outage. Keep public response contents/identifiers out of the audit evidence.
- Wrong SHA/scope, unresolved schema findings, staged changes, unavailable fallback or
  failed baseline smoke aborts deployment. Crash, duplicate same-attempt credit, lost
  results/inventory, reproducible v1/auth/CORS/DB failure, two failed probes 30 seconds
  apart or sustained new 5xx for two minutes stop acceptance and trigger owner review.
  Repeat checks immediately and around +5/+15 minutes; keep bounded logs private.
- Rollback is code-only and owner-approved, only with compatible unadopted v1 data.
  Railway rollback restores the old image **and custom variables**; privately verify
  intended settings and v2 unset. If image retention expired, evaluate redeploy of that
  historical deployment rather than latest source. Verify old SHA, SUCCESS, 1/1 and
  smoke again. Never restore a stale DB, erase inventory/results/grants, backfill
  versions, run seeders, enable automatic updates or activate v2.

**Release remains HOLD.** This PR can close the engineering preparation gate after
independent QA, but neither passing synthetic tests nor merge authorizes a live audit,
production mutation or deployment. The owner-approved live count assessment and pinned
manual release approval remain separate decisions.
