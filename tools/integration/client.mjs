// Node/Playwright helper; credentials stay in memory, never in ready metadata.
import { fork } from 'node:child_process';
import { validateOptions } from './launch.mjs';
export async function spawnIntegration(options = {}) {
  const { workers, clientOrigins } = validateOptions(options);
  const child = fork(new URL('./launch.mjs', import.meta.url), ['--workers', String(workers),
    ...clientOrigins.flatMap(origin => ['--client-origin', origin])], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  // Drain private process streams without forwarding errors, tokens or paths.
  child.stdout.resume(); child.stderr.resume();
  let next = 0; const pending = new Map();
  let ready, rejectReady;
  const startup = new Promise((resolve, reject) => { ready = resolve; rejectReady = reject; });
  const timer = setTimeout(() => { rejectReady(Error('INTEGRATION_START_TIMEOUT')); child.kill('SIGTERM'); }, 45000);
  child.on('message', message => {
    if (message.type === 'ready') { clearTimeout(timer); ready(message.metadata); return; }
    const entry = pending.get(message.id); if (!entry) return;
    clearTimeout(entry.timer); pending.delete(message.id);
    if (message.error) entry.reject(Error(message.error)); else entry.resolve(message.value);
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.once('exit', () => {
    clearTimeout(timer); rejectReady(Error('INTEGRATION_START_FAILED'));
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('INTEGRATION_EXITED')); } pending.clear();
  });
  child.once('error', () => { clearTimeout(timer); rejectReady(Error('INTEGRATION_START_FAILED')); });
  const call = (op, args = {}) => new Promise((resolve, reject) => {
    if (!child.connected) return reject(Error('INTEGRATION_EXITED'));
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('INTEGRATION_OPERATION_TIMEOUT')); }, 30000);
    pending.set(id, { resolve, reject, timer });
    child.send({ id, op, args }, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(Error('INTEGRATION_EXITED')); } });
  });
  const metadata = await startup;
  return { metadata, bootstrap: () => call('bootstrap'), control: call,
    close: async () => { await call('close').catch(() => {}); await exited; } };
}
