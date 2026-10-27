// Parent-only fault injection. Real computation children retain the exact worker
// executable, minimal environment, permissions, limits and generator sources.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { EventEmitter } from 'node:events';
import { generateDaily } from '../../lib/maze/engine.js';

const now = new Date('2028-03-01T00:00:00Z'), input = { date: '2028-02-29' };
const control = { error: null, reads: 0, children: [], read: null, fork: null };
globalThis.__publicationMonitorFixture = control;
const readSource = `import { readFile as realRead } from 'node:fs/promises';
export function readFile(...args) {
  const c = globalThis.__publicationMonitorFixture; c.reads++;
  if (c.read) return c.read(...args);
  if (c.error) return Promise.reject(Object.assign(new Error('synthetic monitor failure'), { code: c.error }));
  return realRead(...args);
}`;
const forkSource = `import { fork as realFork } from 'node:child_process';
export function fork(...args) {
  const c = globalThis.__publicationMonitorFixture, child = c.fork ? c.fork(...args) : realFork(...args);
  const record = { child, closed: false, signal: null }; c.children.push(record);
  child.once('exit', (code, signal) => { record.signal = signal; });
  child.once('close', () => { record.closed = true; });
  return child;
}`;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/services/publication/executor.js')) {
    const source = specifier === 'node:fs/promises' ? readSource : specifier === 'node:child_process' ? forkSource : null;
    if (source) return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
  }
  return next(specifier, context);
} });
const { generateInWorker } = await import('../../services/publication/executor.js');
const closedAndKilled = () => {
  const record = control.children.at(-1);
  assert.equal(record.closed, true); assert.equal(record.signal, 'SIGKILL');
};
async function healthy() {
  control.error = null;
  const before = control.reads, r = await generateInWorker(input, now);
  assert.equal(r.result.gridHash, generateDaily(input).gridHash);
  assert.ok(control.reads > before); assert.equal(control.children.at(-1).closed, true);
}

async function direct() {
  const failures = [];
  for (const code of ['ENOENT', 'ENOENT', 'EACCES']) {
    control.error = code;
    const pending = generateInWorker(input, now);
    await assert.rejects(generateInWorker(input, now), { code: 'GENERATOR_BUSY' });
    await assert.rejects(pending, { code: 'WORKER_RSS_MONITOR_UNAVAILABLE' });
    closedAndKilled(); failures.push(code);
    await healthy();
  }
  return { failures, healthyAfterEach: 3, closedChildren: control.children.filter(c => c.closed).length };
}

async function publisher(uri) {
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\/fc_publication_synthetic_monitor\?replicaSet=fcSynthetic$/);
  const [{ default: mongoose }, { default: Maze }, { publishMaze }] = await Promise.all([
    import('mongoose'), import('../../models/Maze.js'), import('../../services/publication/publisher.js'),
  ]);
  try {
    // Same bounded loopback budgets as the publication fixture: socket timeout
    // exceeds its 2s command budget; these are not live connection settings.
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000, socketTimeoutMS: 3000 });
    await Maze.init();
    const failures = [];
    for (const [code, date] of [['ENOENT', '2028-02-28'], ['EACCES', '2028-02-29']]) {
      control.error = code;
      const before = await Maze.collection.find({}).toArray();
      await assert.rejects(publishMaze({ model: Maze, input: { date }, now }), { code: 'WORKER_RSS_MONITOR_UNAVAILABLE' });
      closedAndKilled();
      assert.equal(await Maze.countDocuments({ date }), 0);
      assert.deepEqual(await Maze.collection.find({}).toArray(), before);
      failures.push({ code, inserted: 0 });
      control.error = null;
      const recovered = await publishMaze({ model: Maze, input: { date }, now });
      assert.equal(recovered.created, true); assert.equal(await Maze.countDocuments({ date }), 1);
    }
    return { failures, healthyPublications: await Maze.countDocuments({}), allChildrenClosed: control.children.every(c => c.closed) };
  } finally { await mongoose.disconnect(); }
}

async function lifecycle(kind) {
  let child, reads = 0, sends = 0, sentResponse = false;
  const result = generateDaily(input);
  const response = () => {
    if (sentResponse) return;
    sentResponse = true;
    child.emit('message', JSON.stringify({ ok: true, result, metrics: { peakRssBytes: 1024 } }));
  };
  const exit = () => {
    response(); child.exitCode = 0; child.emit('exit', 0, null);
    setImmediate(() => child.emit('close', 0));
  };
  control.fork = () => {
    child = new EventEmitter(); child.pid = kind === 'os-exit-before-event' ? 2 ** 30 : process.pid;
    child.exitCode = null; child.signalCode = null;
    child.kill = signal => {
      child.signalCode = signal;
      setImmediate(() => { child.emit('exit', null, signal); child.emit('close', null); });
      return true;
    };
    child.send = (value, callback) => {
      sends++; callback(null);
      if (kind === 'fast-exit') setImmediate(exit);
      else if (kind === 'active-missing-rss') response(); // A reply is not proof of exit.
    };
    return child;
  };
  control.read = () => {
    reads++;
    if (kind === 'no-active-sample') { exit(); return new Promise(() => {}); }
    if (reads === 1) return Promise.resolve('State:\tR (running)\nVmHWM:\t1 kB\n');
    if (kind === 'active-enoent' || kind === 'active-eacces') {
      return Promise.reject(Object.assign(Error('active monitor failure'), { code: kind === 'active-enoent' ? 'ENOENT' : 'EACCES' }));
    }
    if (kind === 'os-exit-before-event') {
      // An impossible Linux pid gives a real ESRCH before the simulated libuv
      // exit notification; no real process is signalled or terminated here.
      response(); setTimeout(exit, 20);
      return Promise.reject(Object.assign(Error('reaped process'), { code: 'ENOENT' }));
    }
    if (kind === 'active-missing-rss') return Promise.resolve('State:\tR (running)\n');
    if (kind === 'exiting-mm-release') {
      // Linux can release the memory map before changing R to Z or delivering
      // exit. Missing VM fields alone must not invent a confirmed exit.
      response(); setTimeout(exit, 3); return Promise.resolve('State:\tR (running)\n');
    }
    if (kind === 'zombie-exit') {
      response(); setImmediate(exit); return Promise.resolve('State:\tZ (zombie)\n');
    }
    // Read begins while alive, then the same process exits before the read
    // completes. A late ENOENT (or never-completing read) cannot delay settlement.
    exit();
    return new Promise((resolve, reject) => {
      if (kind === 'exit-enoent') setTimeout(() => reject(Object.assign(Error('exit cleanup'), { code: 'ENOENT' })), 5);
    });
  };
  const refused = ['active-enoent', 'active-eacces', 'active-missing-rss', 'no-active-sample'].includes(kind);
  if (refused) await assert.rejects(generateInWorker(input, now), { code: 'WORKER_RSS_MONITOR_UNAVAILABLE' });
  else assert.equal((await generateInWorker(input, now)).result.gridHash, result.gridHash);
  assert.equal(control.children.at(-1).closed, true);
  if (kind === 'no-active-sample') assert.equal(sends, 0);
  else if (refused) closedAndKilled();
  else assert.equal(control.children.at(-1).signal, null);
  // Restore real reads/forks and prove a late cleanup callback cannot poison the slot.
  control.read = null; control.fork = null;
  await healthy();
  return { kind, refused, sends, reads, recovered: true };
}

if (process.argv[2] === 'publisher') {
  process.once('message', async ({ uri }) => {
    try { const report = await publisher(uri); process.send({ report }, () => process.disconnect()); }
    catch (error) { console.error(error); process.exitCode = 1; process.disconnect(); }
  });
} else {
  const report = process.argv[2] === 'direct' ? await direct() : await lifecycle(process.argv[2]);
  console.log(JSON.stringify(report));
}
