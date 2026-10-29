// FIXED, SYNTHETIC ONLY, opt-in dedicated-host fixture. Never installed by tests.
// No image, state-root, command, target, date or credential selectors in this CLI.
import { readFile, writeFile, lstat, realpath, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { containerLabels, docker, prepare, receipt, recover, status, privateDirectory, readRecord } from './lifecycle.mjs';

const root = '/opt/fort-custer-proof';
const state = '/var/lib/fort-custer-proof/attempt';
const cgroup = '/sys/fs/cgroup/fc18aproof.slice';
const stop = message => { throw Error(message); };
async function protectedTree(path) {
  const stat = await lstat(path);
  if (stat.uid !== 0 || (stat.mode & 0o022) || stat.isSymbolicLink() || await realpath(path) !== path) stop('HOST_POLICY_UNPROTECTED');
  if (stat.isDirectory()) for (const entry of await readdir(path)) await protectedTree(`${path}/${entry}`);
}
async function policy() {
  if (process.getuid() !== 0 || process.argv.length !== 3) stop('FIXED_ROOT_FIXTURE_ONLY');
  for (const key of ['MONGO_URI', 'MONGODB_URI', 'MONGO_URL', 'DATABASE_URL']) if (Object.hasOwn(process.env, key)) stop('AMBIENT_TARGET_REFUSED');
  for (const path of ['/opt', '/etc', '/etc/fort-custer-proof', '/var', '/var/lib', '/var/lib/fort-custer-proof']) {
    const stat = await lstat(path);
    if (stat.uid !== 0 || (stat.mode & 0o022) || stat.isSymbolicLink() || await realpath(path) !== path) stop('HOST_PATH_UNPROTECTED');
  }
  await protectedTree(root);
  await privateDirectory('/etc/fort-custer-proof');
  const value = await readRecord('/etc/fort-custer-proof', 'policy.json');
  if (Object.keys(value).sort().join() !== ['disposableOnly', 'imageId', 'sourceSha'].sort().join()
      || value.disposableOnly !== true || !/^sha256:[a-f0-9]{64}$/.test(value.imageId) || !/^[a-f0-9]{40}$/.test(value.sourceSha)) stop('POLICY_INVALID');
  return value;
}
// This is the independent daemon-loss path. Never thaw on recovery or startup.
// Keep the active slice frozen across cleanup failures and delayed Docker starts.
async function fence() {
  if (await realpath(cgroup) !== cgroup) stop('CGROUP_PATH_INVALID');
  await writeFile(`${cgroup}/cgroup.freeze`, '1');
  await writeFile(`${cgroup}/cgroup.kill`, '1');
  const until = performance.now() + 5000;
  while (performance.now() < until) {
    const events = await readFile(`${cgroup}/cgroup.events`, 'utf8');
    if (/^frozen 1$/m.test(events) && /^populated 0$/m.test(events)) return;
    await delay(50);
  }
  stop('CGROUP_TERMINATION_UNCERTAIN');
}
try {
  const operation = process.argv[2];
  // The fixed fence precedes fallible policy/state/daemon work on every stop.
  if (['recover', 'boot-sweep'].includes(operation) && process.getuid() === 0) await fence();
  const config = await policy();
  await privateDirectory(state);
  if (operation === 'status') {
    process.stdout.write(JSON.stringify(await status(state)) + '\n');
  } else if (operation === 'recover' || operation === 'boot-sweep') {
    // Fence even if state is incomplete/corrupt or the daemon is down. No deletion
    // of a container is permitted until intent AND receipt pass validation.
    if ((await readdir(state)).length === 0) process.stdout.write('FENCED_EMPTY_DISPOSABLE_HOST; MANUAL_ARM_REQUIRED\n');
    else process.stdout.write(JSON.stringify(await recover(state, { fence })) + '\n');
  } else if (operation === 'run') {
    const gitEnv = { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1' };
    const git = args => execFileSync('/usr/bin/git', ['-C', root, ...args], { env: gitEnv, timeout: 5000, maxBuffer: 256 * 1024 }).toString().trim();
    if (git(['rev-parse', 'HEAD']) !== config.sourceSha || git(['status', '--porcelain', '--untracked-files=all'])) stop('SOURCE_DRIFT');
    const info = JSON.parse(await docker(['info', '--format', '{{json .}}']));
    if (info.CgroupVersion !== '2' || info.CgroupDriver !== 'systemd' || info.LiveRestoreEnabled !== false) stop('HOST_CGROUP_UNSUPPORTED');
    if ((await readFile(`${cgroup}/cgroup.freeze`, 'utf8')).trim() !== '0'
        || !/^populated 0$/m.test(await readFile(`${cgroup}/cgroup.events`, 'utf8'))) stop('HOST_FENCED_OR_BUSY');
    const intent = await prepare(state, { ...config, cgroupParent: 'fc18aproof.slice' });
    // Fixed workload from the accepted isolation image; deliberately never writes.
    // A host QA run is expected to time out or be killed, then recover only.
    const id = (await docker(['create', '--name', intent.name, '--restart=no', '--network=none', '--read-only', '--user=10001:10001',
      '--cap-drop=ALL', '--security-opt=no-new-privileges=true', '--memory=256m', '--memory-swap=256m', '--pids-limit=32', '--cpus=0.5',
      '--ulimit=nofile=64:64', '--log-driver=none', '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=8388608,mode=1777',
      '--cgroup-parent=fc18aproof.slice', ...Object.entries(containerLabels(intent)).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
      ...['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'].flatMap(k => ['--env', `${k}=`]),
      config.imageId, 'tree'])).trim();
    await receipt(state, id); // durable before any start
    await docker(['start', id]);
    // No application deadline substitutes for RuntimeMaxSec. PID 1 owns it.
    await new Promise(() => { setInterval(() => {}, 1000); });
  } else stop('OPERATION_INVALID');
} catch {
  process.stderr.write('STOP_READ_ONLY_RECONCILIATION; LIVE_APPLY_BLOCKED\n');
  process.exitCode = 2;
}
