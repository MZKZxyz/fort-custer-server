// Optional local optimized-client → actual index.js → owned MongoDB smoke.
// Requires the client's existing Playwright installation; no server dependency added.
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdtemp, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import express from 'express';
import { replicaSet } from '../transaction-feasibility/replica-set.mjs';
import { freshFixture } from './fresh-fixtures.mjs';
import { generateDaily } from '../../lib/maze/engine.js';
import { publicationDocument } from '../../services/publication/policy.js';

for (const key of ['MONGO_URI', 'MONGODB_URI', 'MONGO_URL', 'DATABASE_URL']) {
  if (Object.hasOwn(process.env, key)) throw Error('EXTERNAL_DATABASE_CONFIGURATION_REFUSED');
}
const { values } = parseArgs({ options: { client: { type: 'string' } } });
if (!values.client) throw Error('EXPLICIT_LOCAL_CLIENT_REQUIRED');
const clientRoot = resolve(values.client), require = createRequire(join(clientRoot, 'package.json'));
const { chromium } = require('@playwright/test');
const sourceRoot = fileURLToPath(new URL('../..', import.meta.url));
let rs, root, child, host, browser;
const message = value => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('SYNTHETIC_APP_TIMEOUT')), 12000);
  child.once('message', response => { clearTimeout(timer); resolve(response); }); child.send(value);
});
const check = (value, code) => { if (!value) throw Error(code); };
try {
  rs = await replicaSet();
  for (const name of ['mazes', 'users', 'rewarditems']) await rs.db.createCollection(name);
  await rs.db.collection('mazes').createIndex({ date: 1 }, { unique: true });
  await rs.db.collection('mazes').createIndex({ publicationEra: 1, date: 1, publishedAt: 1 });
  await rs.db.collection('users').createIndex({ email: 1 }, { unique: true });
  await rs.db.collection('rewarditems').createIndex({ id: 1 }, { unique: true });
  const date = '2026-06-01', release = freshFixture(), generated = generateDaily({ date });
  const candidate = publicationDocument(generated, new Date('2026-06-01T12:00:00.000Z'));
  Object.assign(candidate.provenance, { releaseId: release.releaseId, releaseDecisionHash: release.approval.decisionHash });
  await rs.db.collection('mazes').insertOne({ date: '2025-05-26', seed: 'synthetic-excluded', grid: [['S', 'E']], width: 2, height: 1 });
  root = await mkdtemp(join(tmpdir(), 'fc-fresh-browser-'));
  for (const file of ['app.js', 'index.js', 'package.json', 'models', 'routes', 'services', 'lib', 'middleware', 'config']) {
    await cp(join(sourceRoot, file), join(root, file), { recursive: true });
  }
  await symlink(join(sourceRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
  await writeFile(join(root, 'config/fresh-release.json'), JSON.stringify(release));
  child = fork(new URL('./release-app.mjs', import.meta.url), [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH, TZ: 'UTC' },
  });
  const startup = await message({ root, uri: rs.uri, at: '2026-06-01T13:00:00.000Z' });
  check(startup.port && startup.connectCalls === 1 && !startup.ddl.length && !startup.writes.length, 'SYNTHETIC_STARTUP_FAILED');
  const apiBase = `http://127.0.0.1:${startup.port}`;
  const api = async (path, body, token) => {
    const response = await fetch(apiBase + '/api/' + path, { method: body ? 'POST' : 'GET', headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const email = 'synthetic-browser@example.invalid', password = 'synthetic-password';
  check((await api('users/register', { email, password })).status === 201, 'REGISTRATION_FAILED');
  const token = (await api('users/login', { email, password })).data.token;
  const subProfileId = (await api('users/subprofile', { name: 'Synthetic Browser' }, token)).data[0]._id;
  const oldDate = '2025-05-26', oldId = '12345678-1234-1234-1234-123456789abc';
  const oldReceipt = { message: 'Maze complete', time: '12.345', reward: null, today: oldDate, attemptId: oldId };
  await rs.db.collection('users').updateOne({ email }, { $set: {
    [`subProfiles.0.progress.${oldDate}`]: { completed: true, time: '12.345' },
    [`subProfiles.0.attempts.${oldDate}`]: [{ attemptId: oldId, completed: true, started: new Date('2025-05-26T00:00:00Z'), result: oldReceipt }],
  } });
  const app = express(); app.use(express.json());
  app.use('/api', async (req, res) => {
    const response = await fetch(apiBase + req.originalUrl, { method: req.method, headers: {
      ...(req.get('Authorization') ? { Authorization: req.get('Authorization') } : {}),
      ...(req.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    }, ...(req.method === 'POST' ? { body: JSON.stringify(req.body) } : {}) });
    res.status(response.status).type('json').send(await response.text());
  });
  app.use(express.static(join(clientRoot, 'build')));
  app.use(async (_req, res) => res.type('html').send(await readFile(join(clientRoot, 'build/index.html'))));
  host = app.listen(0, '127.0.0.1'); await new Promise(resolve => host.once('listening', resolve));
  const base = `http://127.0.0.1:${host.address().port}`;
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.addInitScript(({ token, subProfileId }) => {
    localStorage.setItem('token', token); localStorage.setItem('activeSubProfile', JSON.stringify({ _id: subProfileId, name: 'Synthetic Browser' }));
    localStorage.setItem('mazeDirectionButtons', 'true');
  }, { token, subProfileId });
  await page.goto(base + '/mazes');
  await page.getByText('Daily Maze Archive', { exact: true }).waitFor();
  const today = page.getByRole('button', { name: "Play today's maze" });
  check(await today.isDisabled(), 'EMPTY_TODAY_WAS_PLAYABLE');
  await rs.db.collection('mazes').insertOne(candidate); // owned synthetic publication
  await page.reload(); await today.waitFor(); check(await today.isEnabled(), 'PUBLISHED_TODAY_UNAVAILABLE');
  await today.click(); await page.getByRole('button', { name: 'Right', exact: true }).waitFor();
  await message({ op: 'clock', at: '2026-06-01T13:00:10.000Z' });
  // Each input advances one canonical atomic move, including stationary fire inputs.
  const key = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
  let lost = false;
  await page.route('**/api/maze/complete', async route => {
    if (!lost) { lost = true; await route.fetch(); return route.abort('connectionreset'); }
    return route.continue();
  });
  for (const action of generated.analysis.solution.actions) { await page.keyboard.press(key[action]); await page.waitForTimeout(110); }
  await page.getByRole('button', { name: 'Retry saving' }).waitFor();
  const saved = await rs.db.collection('users').findOne({ email });
  check(saved.subProfiles[0].attempts[date].length === 1, 'EXTRA_ATTEMPT_AFTER_LOST_ACK');
  await page.reload();
  await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
  await page.getByText(/You finished in/).waitFor();
  check((await rs.db.collection('users').findOne({ email })).subProfiles[0].attempts[date].length === 1, 'RECOVERY_CREATED_ATTEMPT');
  const own = await api(`maze/archive?month=2026-06&subProfileId=${subProfileId}`, undefined, token);
  check(own.data.items.length === 1 && own.data.items[0].progress.completed, 'PRIVATE_PROGRESS_MISSING');
  check((await api('leaderboard/daily?date=' + date)).data.length === 1, 'DAILY_RESULT_MISSING');
  check((await api('maze/start', { date: '2025-05-26', subProfileId }, token)).data.code === 'MAZE_NOT_PUBLISHED', 'LEGACY_START_ALLOWED');
  check((await api('leaderboard/weekly?start=2025-05-26')).data.length === 0, 'OLD_WEEK_RANKED');
  const alltime = (await api('leaderboard/alltime')).data;
  check(alltime.length === 1 && alltime[0].completedMazes === 1 && alltime[0].time === '10.000', 'ALLTIME_COUNTED_OLD_RESULT');
  await page.goto(base + '/leaderboard?date=' + date);
  await page.getByRole('cell', { name: 'Synthetic Browser', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Weekly', exact: true }).click();
  await page.getByText('No legacy saved results yet.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Alltime', exact: true }).click();
  await page.getByRole('cell', { name: 'Synthetic Browser', exact: true }).waitFor();
  const oldBefore = await rs.db.collection('users').findOne({ email });
  check(JSON.stringify((await api('maze/complete', { date: oldDate, subProfileId, attemptId: oldId }, token)).data) === JSON.stringify(oldReceipt), 'OLD_UUID_RECOVERY_FAILED');
  check(JSON.stringify(await rs.db.collection('users').findOne({ email })) === JSON.stringify(oldBefore), 'OLD_UUID_RECOVERY_MUTATED_DATA');
  const final = await message({ op: 'stats' }); check(!final.ddl.length, 'APP_DDL_OBSERVED');
  console.log(JSON.stringify({ passed: true, checks: ['empty-today', 'late-publication', 'stored-grid-playthrough',
    'lost-completion-ack', 'reload-UUID-recovery', 'owner-progress', 'daily-result', 'old-date-denial', 'old-week-empty', 'fresh-only-alltime', 'aggregate-client-controls', 'old-UUID-recovery', 'zero-app-DDL'],
    browser: browser.version(), mazeDocuments: await rs.db.collection('mazes').countDocuments({}) }));
} finally {
  await browser?.close();
  host?.closeAllConnections(); if (host) await new Promise(resolve => host.close(resolve));
  if (child && child.exitCode === null && child.signalCode === null) {
    const exit = new Promise(resolve => child.once('exit', resolve)); child.disconnect(); await exit;
  }
  if (root) await rm(root, { recursive: true, force: true });
  await rs?.close();
}
