# PR #23: confirmed-exit ESRCH reconciliation

Addresses independent [QA review 5683445591](https://github.com/MZKZxyz/fort-custer-server/pull/23#pullrequestreview-5683445591)
and [integrator review 5683485493](https://github.com/MZKZxyz/fort-custer-server/pull/23#pullrequestreview-5683485493)
on failed head `ea9d5012b1721c5c436f545be70eab0ad6ce9a07`. This is a correction
on the same draft branch/PR. The leaderboard P2 was independently closed; this
remaining defect is a false rejection of successful worker teardown, not a
fail-open publication or RSS bypass.

## Minimal production correction

Linux procfs can reject a status read with ESRCH after a worker disappears but
before Node delivers exit. The previous catch allowed only ENOENT to reach
`confirmMissingProcess()`, so ESRCH incorrectly short-circuited to monitor failure.

The catch now admits **ENOENT or ESRCH** to that same unchanged helper. It waits
at most one 10ms sampling interval to reconcile exit, then requires either Node
exit state or OS-confirmed ESRCH from a signal-0 probe. An alive PID, ambiguous
state or denied probe still fails closed. EACCES, EPERM and every other read
error remain immediate monitor failures; they do not become disappearance proof.

Only this condition and its explanatory comment changed in production source.
The helper, sampling and settlement logic are unchanged. All safeguards remain:
initial live VmHWM sample, final high-water comparison, 128 MiB RSS, 48 MiB old
heap/4 MiB semispace, 1.5s watchdog, 256 KiB IPC cap, 10ms sampling, Linux-only
monitor, one execution slot, input validation, deterministic identity, child
permissions/environment, cleanup and insert-only publication/reconciliation.

## Permanent regressions and red/green evidence

The committed parent-only `publication-monitor.mjs` fixture now includes both
`os-exit-before-event` (ENOENT) and `os-esrch-before-event`. Each begins with a
valid live RSS sample and valid deterministic result/final metrics, reports the
read failure while child.exitCode and signalCode are null, and delays the exit
event. Its impossible Linux PID yields a **real OS ESRCH** on signal-0. Assertions
require the probe, successful settlement without a kill, closed child, and a
subsequent healthy real worker. No production hook or weakened monitor is added.

Before changing the supervisor, ran these new fixture sources against the old
supervisor: ENOENT passed; ESRCH deterministically failed with
`WORKER_RSS_MONITOR_UNAVAILABLE` in 12.018543ms. This was an intentional red
regression, not an intermittent test failure. After the correction both pass
without an external temporary source substitution.

Additional permanent cases verify:

- Real active workers with persistent injected ENOENT, ESRCH, EACCES, EPERM and
  EIO are killed/refused, concurrent entry is busy, and each next healthy worker
  succeeds. No missing initial sample is forgiven.
- Controlled active ESRCH/ENOENT with a live PID and a permission-denied signal-0
  probe cannot claim disappearance. Permission/read failures (EACCES/EPERM/EIO)
  do not even invoke exit reconciliation. An actual Linux filesystem read of a
  directory supplies a genuine native read failure, also rejected without a probe.
- Even a gone-PID fixture with EACCES fails closed: permission failure alone does
  not authorize accepting a result. Exit-ESRCH/ENOENT and pending-read cleanup,
  zombies, released memory maps, fast exit and missing RSS retain healthy reuse.
- Real disposable Mongo publication inserts nothing during all five active
  monitor errors, keeps earlier records unchanged and publishes when monitoring
  recovers. Both pre-exit disappearance scenarios now insert exactly one verified
  deterministic grid, replay the exact stored winner, and preserve prior rows.
  Every child closes and the next real worker succeeds. This is seven synthetic
  published rows (five recovered failures plus two reconciled exits), never live
  publication or an alternate seed.

Fault hooks affect only the fixture supervisor's imports/process probe; healthy
checks and race repeats use real fork/read/worker code. The fixture now records
probe counts and pre-exit state rather than accepting child result metrics as
process-exit evidence.

## Validation and independent re-QA

Node 24.19.0 / disposable loopback MongoDB 8.0.16. All four external database
selectors are unset; MONGOD_BINARY selects the existing local disposable binary.
Final observed results on the corrected source:

| Check | Result |
| --- | --- |
| Focused `npm run test:publication` | **40 passed**, 0 failed/cancelled/skipped/todo; 5785.042193ms |
| Complete `npm test` discovery | **542 passed**, 0 failed/cancelled/skipped/todo; 83788.69312ms |
| Additional two-independent-publisher race repeats | **3/3 passed** (six real workers), no failures/skips; 1629.946499 / 1621.744275 / 1597.497425ms |
| Existing optimized-client → actual default server → disposable MongoDB smoke | **13 checks passed**, Chromium 154.0.8037.57 |
| Static validation | **104 JS/MJS syntax checks**, FROZEN_CONTRACT_MATCH, whitespace check passed |

The preliminary focused run passed 39/39 before the final genuine-filesystem-read
regression was added. No intermittent failure occurred in these corrected-source
runs. The only observed failure in this correction was the intentional old-source
ESRCH counterexample documented above. Existing worker-slot and memory/deadline
cases, seven-row disposable monitor publication fixture, controlled publication,
leaderboard/UUID, and other regression suites all passed in full discovery.

Reproduction:

```sh
unset MONGO_URI MONGODB_URI MONGO_URL DATABASE_URL
export MONGOD_BINARY
npm run test:publication
npm test
node tools/test-support/publication-monitor.mjs os-exit-before-event
node tools/test-support/publication-monitor.mjs os-esrch-before-event
node --test --test-name-pattern='two independent publishers race different identities' test/publication-api.test.js
node tools/integration/freeze-contract.mjs
```

The PR description pins the corrected exact head SHA and observed test counts.
Independent re-QA should reproduce both pre-exit errors, active/unmonitorable
failures, the real disposable publisher, worker-slot recovery and the repeated
publisher race before changing the source verdict. The known ESRCH defect does
**not** prove it caused an earlier untraced intermittent failure. No inference
about that event is made, and natural successful repetitions alone do not replace
the permanent deterministic regression.

HTTP/client/ranking behavior and frozen v2 wire examples are unchanged. Prior
independent QA on `ea9d5012` passed 229 client units, 131 Chromium tests/28 opt-in
skips and 13 actual-server browser smoke checks; these are prior-head evidence,
not a fresh full-client certification of this supervisor-only correction. The
13-check real-server browser smoke was rerun successfully on the corrected source
using the existing local optimized combined client tree
`8cb6ee8e8562be4b4081b81980c8436bb69e58de`; no client source/build/configuration
was changed and no full client Jest/Chromium suite was rerun for this narrow fix.

Release remains **HOLD**: fresh artifact pending, no owner-approved real launch
identity/date/time or live publisher. OS network/process-tree/memory containment,
scoped live credentials/target/approval, coordinated client legacy-label update,
exact-date insertion, deployment, monitoring and rollback still need separate
review/authorization. Node permissions/RSS sampling do not provide OS isolation.
No production data/Atlas access, real publication, new PR, infrastructure change,
merge, deploy, scheduler/v2 activation or GitHub CI polling occurred.
