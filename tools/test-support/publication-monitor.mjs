// Parent-only fault injection. Real computation children retain the exact worker
// executable, minimal environment, permissions, limits and generator sources.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { EventEmitter } from 'node:events';
import { readFile as nativeReadFile } from 'node:fs/promises';
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
  for (const code of ['ENOENT', 'ESRCH', 'EACCES', 'EPERM', 'EIO']) {
    control.error = code;
    const pending = generateInWorker(input, now);
    await assert.rejects(generateInWorker(input, now), { code: 'GENERATOR_BUSY' });
    await assert.rejects(pending, { code: 'WORKER_RSS_MONITOR_UNAVAILABLE' });
    closedAndKilled(); failures.push(code);
    await healthy();
  }
  return { failures, healthyAfterEach: failures.length, closedChildren: control.children.filter(c => c.closed).length };
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
    for (const [i, code] of ['ENOENT', 'ESRCH', 'EACCES', 'EPERM', 'EIO'].entries()) {
      const date = `2028-02-${20 + i}`;
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
    const reconciled = [];
    for (const [i, kind] of ['os-exit-before-event', 'os-esrch-before-event'].entries()) {
      const date = `2028-02-${25 + i}`, expected = generateDaily({ date });
      const before = await Maze.collection.find({}).toArray();
      const report = await lifecycle(kind, async () => {
        const published = await publishMaze({ model: Maze, input: { date }, now });
        assert.equal(published.created, true); assert.deepEqual(published.diagnostics, []);
        assert.equal(published.maze.provenance.gridHash, expected.gridHash);
        assert.deepEqual(published.maze.grid, expected.maze.grid);
        const stored = await Maze.collection.findOne({ date });
        const retry = await publishMaze({ model: Maze, input: { date }, now });
        assert.equal(retry.created, false); assert.deepEqual(retry.maze, stored);
        assert.equal(await Maze.countDocuments({ date }), 1);
        assert.deepEqual(await Maze.collection.find({ date: { $ne: date } }).toArray(), before);
        return { result: { gridHash: published.maze.provenance.gridHash } };
      }, { date });
      reconciled.push({ kind, inserted: 1, recovered: report.recovered, beforeExit: report.beforeExit });
    }
    return { failures, reconciled, healthyPublications: await Maze.countDocuments({}), allChildrenClosed: control.children.every(c => c.closed) };
  } finally { await mongoose.disconnect(); }
}

async function lifecycle(kind, run = () => generateInWorker(input, now), expectedInput = input) {
  let child, reads = 0, sends = 0, sentResponse = false, beforeExit = false, ended = false, probes = 0;
  const result = generateDaily(expectedInput);
  const disappeared = ['os-exit-before-event', 'os-esrch-before-event', 'gone-eacces-before-event'].includes(kind);
  const realKill = process.kill;
  process.kill = (pid, signal) => {
    if (pid === child?.pid && signal === 0) {
      probes++;
      if (kind === 'active-unprobeable') throw Object.assign(Error('probe permission failure'), { code: 'EPERM' });
    }
    return realKill(pid, signal);
  };
  const response = () => {
    if (sentResponse) return;
    sentResponse = true;
    child.emit('message', JSON.stringify({ ok: true, result, metrics: { peakRssBytes: 1024 } }));
  };
  const exit = () => {
    if (ended) return; ended = true;
    response(); child.exitCode = 0; child.emit('exit', 0, null);
    setImmediate(() => child.emit('close', 0));
  };
  control.fork = () => {
    child = new EventEmitter(); child.pid = disappeared ? 2 ** 30 : process.pid;
    child.exitCode = null; child.signalCode = null;
    child.kill = signal => {
      child.signalCode = signal;
      setImmediate(() => { if (ended) return; ended = true; child.emit('exit', null, signal); child.emit('close', null); });
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
    // A genuine Linux filesystem read rejection, without synthesizing its errno.
    if (kind === 'active-fs-read-failure') return nativeReadFile(new URL('.', import.meta.url));
    const activeErrors = { 'active-enoent': 'ENOENT', 'active-esrch': 'ESRCH', 'active-eacces': 'EACCES',
      'active-eperm': 'EPERM', 'active-eio': 'EIO', 'active-unprobeable': 'ESRCH' };
    if (activeErrors[kind]) return Promise.reject(Object.assign(Error('active monitor failure'), { code: activeErrors[kind] }));
    if (disappeared) {
      // An impossible Linux pid gives a real ESRCH before the simulated libuv
      // exit notification; no real process is signalled or terminated here.
      assert.equal(child.exitCode, null); assert.equal(child.signalCode, null); beforeExit = true;
      response(); setTimeout(exit, 20);
      const code = kind === 'os-esrch-before-event' ? 'ESRCH' : kind === 'gone-eacces-before-event' ? 'EACCES' : 'ENOENT';
      return Promise.reject(Object.assign(Error('reaped process'), { code }));
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
      if (['exit-enoent', 'exit-esrch'].includes(kind)) setTimeout(() => reject(Object.assign(Error('exit cleanup'), { code: kind === 'exit-esrch' ? 'ESRCH' : 'ENOENT' })), 5);
    });
  };
  const refused = kind.startsWith('active-') || ['no-active-sample', 'gone-eacces-before-event'].includes(kind);
  if (refused) await assert.rejects(run(), { code: 'WORKER_RSS_MONITOR_UNAVAILABLE' });
  else assert.equal((await run()).result.gridHash, result.gridHash);
  assert.equal(control.children.at(-1).closed, true);
  if (kind === 'no-active-sample') assert.equal(sends, 0);
  else if (refused) closedAndKilled();
  else assert.equal(control.children.at(-1).signal, null);
  // Restore real reads/forks and prove a late cleanup callback cannot poison the slot.
  if (disappeared) assert.equal(beforeExit, true);
  if (['os-exit-before-event', 'os-esrch-before-event', 'active-unprobeable'].includes(kind)) assert.ok(probes > 0);
  if (['active-eacces', 'active-eperm', 'active-eio', 'active-fs-read-failure', 'gone-eacces-before-event'].includes(kind)) assert.equal(probes, 0);
  control.read = null; control.fork = null; process.kill = realKill;
  await healthy();
  return { kind, refused, sends, reads, probes, beforeExit, recovered: true };
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
