// Disposable test supervisor. The ONLY database connection is created here.
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import jwt from 'jsonwebtoken';
import { replicaSet } from '../transaction-feasibility/replica-set.mjs';
import { PlayableRepository, COLLECTIONS, hash } from '../../services/playable/repository.js';
import { date, alternateDate, grid, transcript, shortTranscript, catalog, epochId } from './fixtures.mjs';

const databaseVariables = ['MONGO_URI', 'MONGODB_URI', 'DATABASE_URL', 'MONGO_URL'];
export function validateOptions(options = {}, env = process.env) {
  if (databaseVariables.some(key => env[key] !== undefined) || Object.keys(options).some(key => !['workers', 'clientOrigins'].includes(key))) {
    throw Error('INTEGRATION_EXTERNAL_CONFIGURATION_REFUSED');
  }
  const workers = options.workers ?? 1, clientOrigins = options.clientOrigins ?? [];
  if (![1, 2].includes(workers) || !Array.isArray(clientOrigins) || clientOrigins.length > 8
    || clientOrigins.some(origin => {
      try { const url = new URL(origin); return url.origin !== origin || url.protocol !== 'http:'
        || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname); } catch { return true; }
    })) throw Error('INTEGRATION_OPTIONS_REFUSED');
  return { workers, clientOrigins };
}
function channel(child) {
  let next = 0; const pending = new Map();
  child.on('message', message => {
    const entry = pending.get(message.id); if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(Error(message.error)); else entry.resolve(message.value);
  });
  child.on('exit', () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('INTEGRATION_WORKER_EXITED')); } pending.clear(); });
  child.on('error', () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('INTEGRATION_WORKER_EXITED')); } pending.clear(); });
  return (op, args = {}) => new Promise((resolve, reject) => {
    if (!child.connected) return reject(Error('INTEGRATION_WORKER_EXITED'));
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('INTEGRATION_WORKER_TIMEOUT')); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.send({ id, op, args }, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(Error('INTEGRATION_WORKER_EXITED')); } });
  });
}
export async function launch(options = {}) {
  const { workers, clientOrigins } = validateOptions(options);
  if (Number(process.versions.node.split('.')[0]) !== 24) throw Error('INTEGRATION_NODE_24_REQUIRED');
  let rs, closing; const apps = [], secret = randomBytes(32).toString('hex');
  async function stopApp(app) {
    if (!app || app.child.exitCode !== null || app.child.signalCode !== null) return;
    const exited = new Promise(resolve => app.child.once('exit', resolve));
    await app.call('close').catch(() => {});
    if (app.child.exitCode === null && app.child.signalCode === null) app.child.kill('SIGTERM');
    await exited;
  }
  const close = () => closing ??= (async () => { await Promise.all(apps.map(stopApp)); await rs?.close(); })();
  async function startApp(index, port) {
    const child = fork(new URL('./worker.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const call = channel(child); apps[index] = { child, call, port };
    const ready = await call('start', { uri: rs.uri, secret, epochId, port, clientOrigins });
    apps[index].port = ready.port; return ready;
  }
  const origin = index => `http://127.0.0.1:${apps[index].port}`;
  try {
    rs = await replicaSet();
    if ((await rs.db.admin().serverInfo()).version !== '8.0.16') throw Error('INTEGRATION_MONGODB_8_0_16_REQUIRED');
    const repo = new PlayableRepository(rs.client, rs.db); await repo.provision();
    await rs.db.collection('mazes').insertMany([date, alternateDate].map(value => ({ date: value,
      seed: 'synthetic-integration-v1', grid, width: grid[0].length, height: grid.length })));
    await rs.db.collection('rewarditems').insertMany(catalog.map(item => ({ ...item })));
    await repo.c('writerEpochs').insertOne({ _id: epochId, version: 'shared-date-v1', state: 'active', revision: 0,
      cutoverAt: Date.parse(`${date}T00:00:00Z`), legacyDateCeiling: alternateDate, evidenceRef: 'synthetic-owned-database-only' });
    for (let i = 0; i < workers; i++) await startApp(i);
    const metadata = { schemaVersion: 1, kind: 'fort-custer-local-integration-v1', testOnly: true,
      contractVersion: 'fc-session-v2-integration-1', baseURL: origin(0), origins: apps.map((_, i) => origin(i)),
      fixture: { date, alternateDate, gridHash: hash(grid), transcriptHash: hash(transcript),
        fixtureHash: hash({ date, alternateDate, grid, transcript, shortTranscript, catalog }) },
      timing: { status: 'untimed', officialCertified: false } };
    async function bootstrap() {
      const email = `synthetic-${randomBytes(8).toString('hex')}@example.invalid`, password = randomBytes(24).toString('hex');
      const post = async (path, body, token) => {
        const response = await fetch(origin(0) + path, { method: 'POST', headers: { 'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
        if (!response.ok) throw Error('INTEGRATION_BOOTSTRAP_FAILED'); return response.json();
      };
      await post('/api/users/register', { email, password });
      const signed = await post('/api/users/login', { email, password });
      const accountId = jwt.verify(signed.token, secret, { algorithms: ['HS256'] }).id;
      const profiles = await post('/api/users/subprofile', { name: 'Synthetic integration player' }, signed.token);
      const subProfileId = profiles[0]._id;
      if (!(await repo.c('profileOrigins').findOne({ accountId, profileId: subProfileId, epochId }))) throw Error('INTEGRATION_PROVENANCE_MISSING');
      // Runtime-only, private IPC. Never part of stdout or committed evidence.
      return { email, password, token: signed.token, accountId, subProfileId };
    }
    async function control(op, args = {}) {
      const index = args.worker ?? 0;
      if (!Number.isInteger(index) || index < 0 || index >= apps.length) throw Error('INTEGRATION_WORKER_REFUSED');
      if (['fault', 'fault-status', 'release', 'clock'].includes(op)) return apps[index].call(op, args);
      if (op === 'restart-app') {
        const port = apps[index].port; await stopApp(apps[index]); await startApp(index, port);
        return { baseURL: origin(index) };
      }
      if (op === 'restart-mongo') { await rs.restart(); return { restarted: true }; }
      if (op === 'snapshot') {
        // A read-only snapshot of synthetic state, intentionally excludes hashes,
        // credentials and signing secrets from the User document.
        return repo.tx(async session => {
          // A single MongoDB transaction/session cannot run parallel commands.
          const collections = {};
          for (const name of COLLECTIONS) collections[name] = await repo.c(name).find({}, { session }).toArray();
          return { collections, users: await rs.db.collection('users').find({}, { session,
            projection: { subProfiles: 1, __v: 1 } }).toArray() };
        });
      }
      if (op === 'majority-result') {
        return { present: !!await repo.c('results').findOne({ attemptId: args.attemptId }, { readConcern: { level: 'majority' } }) };
      }
      if (op === 'isolation') return { database: rs.db.databaseName, replicaSet: (await rs.db.admin().command({ hello: 1 })).setName,
        mongoPort: Number(new URL(rs.uri).port), version: (await rs.db.admin().serverInfo()).version };
      if (op === 'repair-catalog') {
        // Exact frozen fixture only; no caller-defined DB mutation surface.
        await rs.db.collection('rewarditems').updateOne({ id: catalog[0].id }, { $set: catalog[0] }); return { repaired: true };
      }
      if (op === 'invalidate-catalog') {
        await rs.db.collection('rewarditems').updateOne({ id: catalog[0].id }, { $unset: { name: '' } }); return { invalidated: true };
      }
      throw Error('INTEGRATION_CONTROL_REFUSED');
    }
    return { metadata, bootstrap, control, close };
  } catch (error) { await close(); throw error; }
}

// No exported URI/DB path/credential file and no HTTP admin or fault endpoints.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let fixture, starting, closing;
  const shutdown = () => closing ??= (async () => {
    const active = fixture ?? await starting?.catch(() => null);
    await active?.close(); if (process.connected) process.disconnect();
  })();
  process.once('SIGTERM', () => { void shutdown(); }); process.once('SIGINT', () => { void shutdown(); });
  process.once('disconnect', () => { void shutdown(); });
  try {
    const options = { clientOrigins: [] };
    for (let i = 2; i < process.argv.length; i += 2) {
      if (process.argv[i] === '--workers') options.workers = Number(process.argv[i + 1]);
      else if (process.argv[i] === '--client-origin') options.clientOrigins.push(process.argv[i + 1]);
      else throw Error('INTEGRATION_OPTIONS_REFUSED');
    }
    starting = launch(options); fixture = await starting;
    process.stdout.write(JSON.stringify({ type: 'ready', ...fixture.metadata }) + '\n');
    if (process.connected) process.send({ type: 'ready', metadata: fixture.metadata });
    process.on('message', async ({ id, op, args }) => {
      try {
        const value = op === 'bootstrap' ? await fixture.bootstrap() : op === 'close' ? { closed: true } : await fixture.control(op, args);
        if (process.connected) process.send({ id, value });
        if (op === 'close') await shutdown();
      } catch { if (process.connected) process.send({ id, error: 'INTEGRATION_OPERATION_FAILED' }); }
    });
  } catch {
    await fixture?.close(); process.stderr.write('INTEGRATION_START_FAILED\n'); process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
}
