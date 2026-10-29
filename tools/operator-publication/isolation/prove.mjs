// Explicit, opt-in local Docker proof. Not discovered by npm test or app startup.
// Creates only uniquely named local disposable containers/volumes; never cloud resources.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import assert from 'node:assert/strict';
import { digest, signingBytes } from '../artifacts.mjs';
import { isolationIndexFixtures } from '../../test-support/isolation-index-fixtures.mjs';
import { prepare, receipt, containerLabels, recover, status } from './lifecycle.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const prefix = `fc17j-${randomUUID().slice(0, 8)}`;
const nodeImage = 'node@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df';
const mongoImage = 'mongo@sha256:5dda65a823a0d73d9caae4f449ab01973cf9884cea4ef56f9cb84dbe5e00acbd';
const containers = [], lifecycleNames = [], volumes = [], checks = [];
const temp = await mkdtemp(join(tmpdir(), `${prefix}-`));
const reportPath = resolve(process.argv[2] ?? join(tmpdir(), `${prefix}-evidence.json`));
const dockerEnv = { ...process.env };
// buildx needs writable transient state; preserve DOCKER_CONFIG/registry identity.
dockerEnv.BUILDX_CONFIG = join(temp, 'buildx');
for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete dockerEnv[key];
async function command(binary, args, { timeout = 60000, max = 2 * 1024 * 1024, input, allowFailure = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { cwd: root, env: dockerEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), failed;
    const timer = setTimeout(() => { failed = Error('SUPERVISOR_COMMAND_TIMEOUT'); child.kill('SIGKILL'); }, timeout);
    const append = (which, bytes) => {
      if (stdout.length + stderr.length + bytes.length > max) { failed = Error('OUTPUT_LIMIT'); child.kill('SIGKILL'); }
      else if (which === 'out') stdout = Buffer.concat([stdout, bytes]); else stderr = Buffer.concat([stderr, bytes]);
    };
    child.stdout.on('data', b => append('out', b)); child.stderr.on('data', b => append('err', b));
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (failed) reject(failed);
      else if (code !== 0 && !allowFailure) reject(Error(`COMMAND_FAILED: ${binary} ${args[0]} (${code}): ${stderr.toString().slice(-1500)}`));
      else resolvePromise({ stdout, stderr, code });
    });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
const docker = (args, options) => command('docker', ['--host=unix:///var/run/docker.sock', ...args], options);
const json = result => JSON.parse(result.stdout.toString());
const check = (name, value) => { assert.ok(value, name); checks.push(name); process.stderr.write(`PASS ${name}\n`); };
const mount = (volume, path) => ['--mount', `type=volume,src=${volume},dst=${path},readonly`];
let imageId, sourceSha, evidence;
async function volume(label, files = {}, uid = 10002) {
  const name = `${prefix}-${label}`; volumes.push(name); await docker(['volume', 'create', name]);
  const dir = join(temp, label); await mkdir(dir);
  for (const [file, data] of Object.entries(files)) await writeFile(join(dir, file), typeof data === 'string' ? data : JSON.stringify(data), { mode: 0o600 });
  const helper = `${prefix}-copy-${label}`; containers.push(helper);
  // Trusted fixture provisioning helper; no socket, host mounts, network or secrets outside this fixture.
  await docker(['create', '--name', helper, '--network', 'none', '--user', '0:0', '--cap-drop=ALL', '--cap-add=CHOWN', '--cap-add=FOWNER',
    '--mount', `type=volume,src=${name},dst=/data`, '--entrypoint', '/usr/local/bin/node', nodeImage,
    '-e', `const f=require('fs'); f.chownSync('/data',${uid},${uid}); f.chmodSync('/data',0o755); for(const n of f.readdirSync('/data')) {f.chownSync('/data/'+n,${uid},${uid}); f.chmodSync('/data/'+n,0o600);}`]);
  await docker(['cp', `${dir}/.`, `${helper}:/data`]); await docker(['start', '-a', helper]);
  // vfs copies each container filesystem. Release completed helpers promptly;
  // named volumes retain the fixture data until final verified teardown.
  await docker(['rm', helper]);
  return name;
}
async function job(mode, { args = [], mounts = [], uid = 10001, image = imageId, deadline = 20000, memory = 256, lifecycle } = {}) {
  let stateDir, intent;
  if (lifecycle) {
    stateDir = await mkdtemp(join(temp, 'lifecycle-'));
    intent = await prepare(stateDir, { imageId: image, sourceSha });
    lifecycleNames.push(intent.name);
  }
  const name = intent?.name ?? `${prefix}-job-${containers.length}`; containers.push(name);
  const created = await docker(['create', '--name', name, '--restart=no', '--network', 'none', '--hostname', 'fixture', '--user', `${uid}:${uid}`,
    '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges=true', '--pids-limit', '32',
    '--memory', `${memory}m`, '--memory-swap', `${memory}m`, '--cpus', '0.5', '--ulimit', 'nofile=64:64',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=8388608,mode=1777', '--log-driver', 'none',
    ...['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'].flatMap(k => ['--env', `${k}=`]),
    ...(intent ? Object.entries(containerLabels(intent)).flatMap(([key, value]) => ['--label', `${key}=${value}`]) : []),
    ...mounts, image, mode, ...args]);
  const spec = json(await docker(['inspect', name]))[0];
  assert.equal(spec.Image, image); assert.equal(spec.HostConfig.NetworkMode, 'none');
  assert.equal(spec.HostConfig.Privileged, false); assert.equal(spec.HostConfig.ReadonlyRootfs, true);
  assert.ok(spec.Mounts.filter(m => m.Type === 'volume').every(m => m.RW === false));
  if (lifecycle) {
    await receipt(stateDir, created.stdout.toString().trim());
    const retained = await Promise.all(['spent.json', 'intent.json', 'receipt.json'].map(n => readFile(join(stateDir, n), 'utf8')));
    const child = spawn(process.execPath, ['tools/test-support/lifecycle-process.mjs', stateDir], { cwd: root, env: dockerEnv, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('CHILD_SUPERVISOR_NOT_READY')), 10000);
        child.once('message', value => { clearTimeout(timer); value.started ? resolve() : reject(Error('CHILD_NOT_STARTED')); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(Error('CHILD_EARLY_EXIT')); });
      });
      if (lifecycle.ready) await lifecycle.ready();
      else {
        const until = performance.now() + 5000;
        while (performance.now() < until) {
          const top = (await docker(['top', name, '-eo', 'pid,comm'])).stdout.toString().trim().split('\n');
          if (top.length >= 3) break;
          await delay(50);
        }
        check('lifecycle actual detached descendant exists before kill', (await docker(['top', name, '-eo', 'pid,comm'])).stdout.toString().trim().split('\n').length >= 3);
      }
      child.kill('SIGKILL');
      assert.equal((await exited).signal, 'SIGKILL');
      check('actual supervisor SIGKILL leaves container requiring external recovery', (await status(stateDir)).running);
      // Deliberately injected adapter outage, NOT a dockerd restart/partition.
      await assert.rejects(recover(stateDir, { call: async () => { throw Error('INJECTED_DAEMON_UNAVAILABLE'); } }), /INJECTED_DAEMON_UNAVAILABLE/);
      assert.equal((await status(stateDir)).running, true);
      const outcome = await recover(stateDir);
      await recover(stateDir); // idempotent reconnect / recovery, never starts work
      check('targeted recovery kills job only and preserves spent immutable records', outcome.retry === false && !(await status(stateDir)).present);
      assert.deepEqual(await Promise.all(['spent.json', 'intent.json', 'receipt.json'].map(n => readFile(join(stateDir, n), 'utf8'))), retained);
      await assert.rejects(prepare(stateDir, { imageId: image, sourceSha }), /SPENT_OR_UNCERTAIN/);
      return { recovered: true };
    } finally {
      child.kill('SIGKILL'); await exited;
    }
  }
  let deadlineHit = false, killError;
  // External to the job; daemon SIGKILL tears down its PID namespace, including
  // setsid/detached descendants. Host-supervisor death is a documented blocker.
  const timer = setTimeout(() => { deadlineHit = true; docker(['kill', '--signal=KILL', name]).catch(e => { killError = e; }); }, deadline);
  let result;
  try { result = await docker(['start', '-a', name], { timeout: deadline + 10000, max: 256 * 1024, allowFailure: true }); }
  finally { clearTimeout(timer); }
  if (killError) throw killError;
  const state = json(await docker(['inspect', name]))[0].State;
  assert.equal(state.Running, false); assert.equal(state.Pid, 0);
  // Inspect enforcement/exit first, then release the stopped root filesystem.
  // Retaining every adversarial job can exhaust a vfs daemon's local disk.
  await docker(['rm', name]);
  // docker start -a returns zero even when the container exits nonzero. Inspect it.
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), state, deadlineHit };
}
const parsed = result => {
  assert.ok(result.stdout.trim(), `JOB_OUTPUT_MISSING: exit=${result.state.ExitCode} oom=${result.state.OOMKilled} deadline=${result.deadlineHit} ${result.stderr.slice(-1500)}`);
  return JSON.parse(result.stdout.trim());
};
try {
  assert.equal(process.versions.node.split('.')[0], '24');
  for (const key of ['MONGO_URI', 'MONGODB_URI', 'MONGO_URL', 'DATABASE_URL']) assert.equal(Object.hasOwn(process.env, key), false, `${key} must be unset`);
  await docker(['info']);
  sourceSha = (await command('git', ['rev-parse', 'HEAD'])).stdout.toString().trim();
  check('clean exact source checkout', (await command('git', ['status', '--porcelain', '--untracked-files=all'])).stdout.length === 0);
  const context = join(temp, 'context'); await mkdir(context);
  const archive = await command('git', ['archive', '--format=tar', sourceSha], { max: 16 * 1024 * 1024 });
  await command('tar', ['-xf', '-', '-C', context], { input: archive.stdout });
  // Registry images are public dependencies, not provisioned cloud resources.
  await docker(['pull', nodeImage], { timeout: 300000 }); await docker(['image', 'inspect', mongoImage]);
  await docker(['build', '--secret', `id=proxy_ca,src=${process.env.CODEX_PROXY_CERT ?? '/etc/ssl/certs/ca-certificates.crt'}`,
    '--build-arg', `NODE_IMAGE=${nodeImage}`, '--build-arg', `SOURCE_SHA=${sourceSha}`,
    '-f', join(context, 'tools/operator-publication/isolation/Dockerfile'), '-t', `${prefix}:proof`, context], { timeout: 300000 });
  imageId = json(await docker(['image', 'inspect', `${prefix}:proof`]))[0].Id;
  const measured = parsed(await job('measure')); assert.equal(measured.sourceSha, sourceSha);
  check('image content measured including locked dependencies', /^[a-f0-9]{64}$/.test(measured.hash));
  check('generator OS controls and denied network/DNS/credential/socket access', parsed(await job('probe', { args: ['10001'] })).code === 'OS_BOUNDARIES_VERIFIED');
  const generated = parsed(await job('generate'));
  check('offline generator produced deterministic candidate', generated.provenance.gridHash === parsed(await job('generate')).provenance.gridHash);
  const oom = await job('memory'); check('cgroup memory OOM enforced', oom.state.OOMKilled && oom.state.ExitCode === 137);
  const cpu = parsed(await job('cpu')).cpu; check('cgroup CPU quota throttled busy process', Number(cpu.match(/nr_throttled (\d+)/)?.[1]) > 0);
  check('cgroup PID limit rejected process growth', Number(parsed(await job('pids')).events.match(/max (\d+)/)?.[1]) > 0);
  const tree = await job('tree', { deadline: 2500 });
  check('external deadline killed detached process tree', tree.deadlineHit && tree.state.ExitCode === 137 && parsed(tree).code === 'DETACHED_CHILD_STARTED');
  const bystander = `${prefix}-unrelated`; containers.push(bystander);
  await docker(['create', '--name', bystander, '--network=none', imageId, 'tree']);
  await job('tree', { lifecycle: {} });
  check('targeted recovery retained unrelated container', json(await docker(['inspect', bystander]))[0].State.Status === 'created');
  await docker(['rm', bystander]);

  const pairs = ['release', 'publish'].map(role => ({ role, ...generateKeyPairSync('ed25519') }));
  const keys = pairs.map(p => ({ role: p.role, keyId: `fixture-${p.role}`, publicKey: p.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }));
  const seal = (payload, role) => ({ keyId: `fixture-${role}`, payload, signature: sign(null, signingBytes(payload), pairs.find(p => p.role === role).privateKey).toString('base64') });
  const auth = role => ({ username: `fixture-${role}`, password: randomBytes(24).toString('hex') });
  const accounts = { admin: auth('admin'), writer: auth('writer'), reader: auth('reader') };
  const adminVol = await volume('admin', { 'accounts.json': accounts, key: randomBytes(48).toString('base64') }, 999);
  const socketVol = await volume('socket', {}, 999), dataVol = await volume('mongo-data', {}, 999);
  const writerVol = await volume('writer', { 'auth.json': accounts.writer });
  const readerVol = await volume('reader', { 'auth.json': accounts.reader });
  const mongo = `${prefix}-mongo`; containers.push(mongo);
  await docker(['run', '-d', '--name', mongo, '--network', 'none', '--user', '999:999', '--cap-drop=ALL', '--security-opt', 'no-new-privileges=true',
    '--memory', '512m', '--memory-swap', '512m', '--pids-limit', '128', '--cpus', '1', '--log-driver', 'none',
    '--mount', `type=volume,src=${socketVol},dst=/socket`, '--mount', `type=volume,src=${dataVol},dst=/data/db`,
    ...mount(adminVol, '/admin'), '--entrypoint', 'mongod', mongoImage, '--dbpath', '/data/db', '--bind_ip', '127.0.0.1',
    '--replSet', 'fcIsolated', '--auth', '--keyFile', '/admin/key', '--unixSocketPrefix', '/socket', '--filePermissions', '0777', '--wiredTigerCacheSizeGB', '0.25']);
  const adminMounts = [...mount(adminVol, '/admin'), ...mount(socketVol, '/socket')];
  const initialized = parsed(await job('admin', { uid: 999, args: ['init'], mounts: adminMounts }));
  assert.ok(initialized.target, JSON.stringify(initialized));
  const policy = { keys, imageId, target: initialized.target };
  const policyVol = await volume('policy', { 'policy.json': policy });
  const release = seal({ kind: 'isolated-fixture-release-v1', sourceSha, measurement: measured.hash, imageId }, 'release');
  const request = candidate => ({ release, candidate, approval: seal({ kind: 'isolated-fixture-approval-v1', approvalId: randomUUID(), date: candidate.date,
    candidateHash: digest(candidate), releaseHash: digest(release), targetHash: digest(policy.target) }, 'publish') });
  let requests = 0;
  const invoke = async (value, mode = 'write', fault, credential = writerVol) => {
    const reqVol = await volume(`request-${requests++}`, { 'request.json': value });
    return job(mode, { uid: 10002, args: fault ? [fault] : [], mounts: [...mount(policyVol, '/policy'), ...mount(reqVol, '/request'), ...mount(credential, '/writer'), ...mount(socketVol, '/socket')] });
  };
  const writerMounts = [...mount(writerVol, '/writer'), ...mount(socketVol, '/socket')];
  check('writer distinct UID and no IP/DNS egress', parsed(await job('probe', { uid: 10002, args: ['10002'], mounts: writerMounts })).code === 'OS_BOUNDARIES_VERIFIED');
  check('writer exact-collection privilege denials', parsed(await job('privileges', { uid: 10002, mounts: writerMounts })).code === 'PRIVILEGES_VERIFIED');
  check('reader cannot insert or mutate', parsed(await job('privileges', { uid: 10002, args: ['reader'], mounts: [...mount(readerVol, '/writer'), ...mount(socketVol, '/socket')] })).code === 'PRIVILEGES_VERIFIED');
  const original = request(generated), invalid = structuredClone(original); invalid.approval.signature = 'A'.repeat(86) + '==';
  check('invalid signature refused before claim', parsed(await invoke(invalid)).code === 'CERTIFICATE_INVALID');
  const changedSource = structuredClone(original); changedSource.release = seal({ ...release.payload, sourceSha: '0'.repeat(40) }, 'release');
  check('valid signature over untrusted source refused', parsed(await invoke(changedSource)).code === 'SOURCE_UNTRUSTED');
  const fake = request({ ...generated, seed: 'tampered' });
  check('signed malformed candidate refused', parsed(await invoke(fake)).code === 'APPROVAL_INVALID');
  check('unauthenticated socket access cannot publish', parsed(await job('unauthenticated', { uid: 10002, mounts: [...mount(socketVol, '/socket')] })).code === 'UNAUTHENTICATED_DENIED');
  // Real authenticated writer attempts with misleading index names/options.
  // Every rejection must precede any durable claim, maze insert or result audit.
  for (const indexCase of Object.keys(isolationIndexFixtures)) {
    const changed = parsed(await job('admin', { uid: 999, args: ['index-fixture', indexCase], mounts: adminMounts }));
    assert.equal(changed.code, 'FIXTURE_INDEX_CHANGED', JSON.stringify(changed));
    const refused = parsed(await invoke(original));
    const beforeClaim = parsed(await job('admin', { uid: 999, args: ['counts'], mounts: adminMounts }));
    check(`invalid date index ${indexCase} refused before claim/maze/audit`, refused.code === 'FIXTURE_UNAVAILABLE'
      && beforeClaim.mazes === 0 && beforeClaim.claims === 0 && beforeClaim.audit === 0);
    const restored = parsed(await job('admin', { uid: 999, args: ['index-fixture', 'restore'], mounts: adminMounts }));
    assert.equal(restored.code, 'FIXTURE_INDEX_CHANGED', JSON.stringify(restored));
  }
  const competitor = request(generated);
  const concurrent = (await Promise.all([invoke(original, 'write', 'write-ack'), invoke(competitor, 'write', 'write-ack')])).map(parsed);
  check('concurrent independent containers consume one global date', concurrent.filter(r => r.code === 'RECONCILED_VERIFIED').length === 1 && concurrent.filter(r => ['APPROVAL_OR_DATE_SPENT', 'CLAIM_UNCERTAIN'].includes(r.code)).length === 1);
  const winner = concurrent[0].code === 'RECONCILED_VERIFIED' ? original : competitor;
  check('replayed approval refused from fresh container', parsed(await invoke(winner)).code === 'APPROVAL_OR_DATE_SPENT');
  check('unknown write ACK reconciles using read-only identity', parsed(await invoke(winner, 'reconcile', undefined, readerVol)).code === 'VERIFIED_WINNER');
  const second = request(parsed(await job('generate', { args: ['2026-06-02'] })));
  check('unknown claim ACK prevents any write', parsed(await invoke(second, 'write', 'claim-ack')).code === 'CLAIM_UNCERTAIN');
  check('uncertain claimed date cannot be retried', parsed(await invoke(second)).code === 'APPROVAL_OR_DATE_SPENT');
  check('missing winner remains uncertain under read-only reconcile', parsed(await invoke(second, 'reconcile', undefined, readerVol)).code === 'NO_WINNER_UNCERTAIN');
  const crashed = request(parsed(await job('generate', { args: ['2026-06-03'] })));
  const crashRequest = await volume('crash-request', { 'request.json': crashed });
  await job('write', { uid: 10002, args: ['claim-hold'], mounts: [...mount(policyVol, '/policy'), ...mount(crashRequest, '/request'), ...mount(writerVol, '/writer'), ...mount(socketVol, '/socket')],
    lifecycle: { ready: async () => {
      const until = performance.now() + 10000;
      while (performance.now() < until) {
        if (parsed(await job('admin', { uid: 999, args: ['counts'], mounts: adminMounts })).claims === 3) return;
        await delay(100);
      }
      throw Error('CLAIM_HOLD_NOT_OBSERVED');
    } } });
  check('SIGKILL recovery retains central consumed claim and refuses publication replay', parsed(await invoke(crashed)).code === 'APPROVAL_OR_DATE_SPENT'
    && parsed(await invoke(crashed, 'reconcile', undefined, readerVol)).code === 'NO_WINNER_UNCERTAIN');
  const counts = parsed(await job('admin', { uid: 999, args: ['counts'], mounts: adminMounts }));
  check('global claims and durable intent remain without duplicate insert', counts.mazes === 1 && counts.claims === 3 && counts.audit === 1);
  await job('admin', { uid: 999, args: ['drift'], mounts: adminMounts });
  const third = request(parsed(await job('generate', { args: ['2026-06-04'] })));
  check('metadata fingerprint drift refuses new claim', parsed(await invoke(third)).code === 'TARGET_DRIFT');

  // Change a measured dependency in a derived image. Bootstrap refuses it before
  // dynamic importing generator or opening the DB. Production also rejects image ID.
  const badContext = join(temp, 'bad'); await mkdir(badContext);
  const mutation = JSON.stringify(['/usr/local/bin/node', '-e', "require('fs').appendFileSync('/app/lib/maze/engine.js','// tampered')"]);
  await writeFile(join(badContext, 'Dockerfile'), `FROM ${prefix}:proof\nUSER 0\nRUN ${mutation}\nUSER 10001:10001\n`);
  await docker(['build', '-t', `${prefix}:modified`, badContext], { timeout: 60000 });
  const modifiedId = json(await docker(['image', 'inspect', `${prefix}:modified`]))[0].Id;
  check('modified executable source refused by measured bootstrap', parsed(await job('generate', { image: modifiedId })).code === 'SOURCE_MODIFIED');
  evidence = { schemaVersion: 1, mode: 'disposable-container-proof', sourceSha, node: process.version,
    nodeImage, mongoImage, imageId, measurement: measured.hash, checks, counts,
    production: 'LIVE_APPLY_BLOCKED', hostLifecycle: { supervisorSIGKILL: 'observed; explicit parent recovery',
      daemonInterruption: 'NOT VERIFIED; adapter exception only', systemdDeadline: 'NOT VERIFIED',
      cgroupFence: 'NOT VERIFIED', reboot: 'NOT VERIFIED' },
    gaps: ['independent host-supervisor death deadline/fence/reboot proof', 'production Atlas TLS/topology/egress', 'owner roots and provenance', 'external DDL fence', 'rollback-resistant authority/audit', 'independent Systems/Security QA'] };
} finally {
  for (const name of containers.reverse()) await docker(['rm', '-f', name], { allowFailure: true }).catch(() => {});
  for (const name of volumes.reverse()) await docker(['volume', 'rm', name], { allowFailure: true }).catch(() => {});
  for (const tag of [`${prefix}:modified`, `${prefix}:proof`]) await docker(['image', 'rm', tag], { allowFailure: true }).catch(() => {});
  await rm(temp, { recursive: true, force: true });
  const remainingContainers = await docker(['ps', '-aq', '--filter', `name=${prefix}-`]);
  const remainingVolumes = await docker(['volume', 'ls', '-q', '--filter', `name=${prefix}-`]);
  assert.equal(remainingContainers.stdout.length + remainingVolumes.stdout.length, 0, 'DISPOSAL_INCOMPLETE');
  for (const name of lifecycleNames) assert.equal((await docker(['ps', '-aq', '--filter', `name=^/${name}$`])).stdout.length, 0, 'LIFECYCLE_DISPOSAL_INCOMPLETE');
}
await writeFile(reportPath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
process.stdout.write(`Evidence: ${reportPath}\n`);
