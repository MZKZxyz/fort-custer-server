# Reproduce the disposable isolation proof

Use Node 24, Linux with a local trusted Docker daemon, cgroup v2 CPU/memory/PID
controllers, default seccomp and enough disk for the Node/Mongo images. No cloud
account or production database is needed. Missing enforcement causes a failed
proof; there is no skip/fallback mode or simulated OS success. For a managed
environment follow its proxy/CA instructions; do not change network policy or
disable TLS. A Docker socket grants host authority: use a disposable test host.

```sh
node --version  # v24.x
npm ci
git status --porcelain  # must be entirely clean, including untracked files
unset MONGO_URI MONGODB_URI MONGO_URL DATABASE_URL
# Public fixture dependencies only. The proof pulls the pinned Node image and
# requires the pinned Mongo image below to be present locally.
docker pull mongo@sha256:5dda65a823a0d73d9caae4f449ab01973cf9884cea4ef56f9cb84dbe5e00acbd
npm run test:operator-isolation
npm run proof:operator-isolation -- /tmp/fc-isolation-evidence.json
```

The harness explicitly selects `/var/run/docker.sock`, clears Docker endpoint/TLS
selectors and preserves registry/proxy configuration. It builds a clean exact Git
archive, uses pinned public Node 24/Mongo 8 image digests, installs locked packages
with lifecycle scripts disabled and TLS verification enabled, and mounts the
build CA using BuildKit secrets (`CODEX_PROXY_CERT` or system CA bundle). There
are no runtime package installs. It measures all `/app` source/dependency regular
files (excluding its own manifest and npm executable `.bin` links). OS/runtime
files are covered by the image digest, not that manifest. No root from the request
or arbitrary image/URI selector exists in the harness CLI.

All container/volume names have a fresh `fc17j-*` prefix. Fixture credentials and
private signing keys are generated fresh; private signing keys remain in host
memory and fixture credentials go only to 0600 temporary files/named volumes.
The harness removes its containers, volumes, temporary files and image tags in
`finally`. The evidence file is created exclusively after verifying disposal;
choose a new output filename for each run. It remains outside the checkout. Docker build cache
and public base images may remain. On supervisor/host SIGKILL, `finally` cannot
run: preserve evidence first, then inspect and remove only that invocation's
exact recorded prefix. Never use a broad Docker prune on a shared daemon.

Evidence contains source SHA, runtime Node version, base digests, built image ID,
content measurement, individual passed assertions and aggregate document/claim/
audit counts. It contains no grid, credential, URI, signature or private key.
Failure exits nonzero and produces no success evidence. Avoid publishing raw
fixture volume contents or Docker build environments.

The opt-in Docker proof is separate from automatic test discovery because it
requires a trusted local daemon and builds images. It is **not** represented as
a skipped test in `npm test`. Its probes deliberately trigger OOM/PID pressure
inside bounded containers. It never creates remote infrastructure or publishes
a port. The fixture admin account exists only to build/read disposable state;
jobs never receive that account.

## Adversarial checks

The executable harness covers: real network/DNS/metadata denials; missing
generator secret/socket mounts; separate writer UID; read-only source; active
seccomp/capability/no-new-privs state; exact cgroup settings; actual memory OOM,
CPU throttling and PID-exhaustion event; detached descendant teardown; changed
source; signed wrong source; invalid signatures; signed malformed candidate;
unauthenticated DB access; actual least-privilege denials; independent concurrent
writers; replay after fresh container start; unknown claim ACK with zero insert;
unknown insert ACK and separate read-only reconciliation; retained central claims
and audit counts; target metadata drift. Assertions are required, not informative
log messages. See the [threat model](THREAT-MODEL.md) for what each does not prove.

The source-only tests verify measurement and signed authority/input bindings.
The prior operator suite remains the complete release/window/fresh-provenance,
worker watchdog, exact-date publication and actual Mongo fault regression suite.
The new fixture protocol stores synthetic candidate bytes in its reserved DB;
it is not wired into the app model or a live publication adapter. Fixture ACK
faults occur after actual commands and deliberately discard results; they model
uncertainty rather than assert that a network partition happened.

## Full regression and independent QA

Obtain a local `mongod` 8 binary for the existing test fixtures (the repository CI
documents its checked download), then run from the clean pinned PR head:

```sh
unset MONGO_URI MONGODB_URI MONGO_URL DATABASE_URL
export MONGOD_BINARY=/absolute/path/to/mongod
npm test
npm run test:operator
npm run test:operator-isolation
node tools/integration/freeze-contract.mjs
git ls-files -z '*.js' '*.mjs' | xargs -0 -n1 node --check
git diff --check
```

Independent Systems/Security QA should record exact `git rev-parse HEAD`, inspect
the live-block file and unchanged production configuration, rerun every command
and the Docker proof, and verify the report against actual daemon inspect/cgroup
observations. Review exact entrypoints/mounts/users, source/bootstrap trust,
canonical role separation, central claim atomicity, one-submit behavior and
read-only recovery. Inspect denied operations, not only declared role names.
Review the host-death, DDL, Atlas TLS/egress and audit/restore gaps explicitly.
Do not install real roots/credentials, query production Atlas, start a production
server, merge, deploy or poll GitHub CI as part of this engineering handoff.

The report establishes engineering evidence only. Independent QA must return its
own verdict at the final PR head. A source merge, runner provisioning, credentials,
owner release/date/signing, exact one-date approval/insert, Railway promotion,
client #54/Vercel promotion, rollback/monitoring and scheduling remain separate
owner GOs in the [runbook](RUNBOOK.md).
