import { assertImage } from './measure.mjs';
import { readFile, access, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import net from 'node:net';
import dns from 'node:dns/promises';

const output = value => process.stdout.write(JSON.stringify(value) + '\n');
try {
  const measured = await assertImage();
  const mode = process.argv[2];
  if (mode === 'measure') output(measured);
  else if (mode === 'generate') {
    const { generateDaily, canonicalConfig, algorithmVersion } = await import('../../../lib/maze/engine.js');
    const { publicationDocument } = await import('../../../services/publication/policy.js');
    const date = process.argv[3] ?? '2026-06-01';
    if (!/^2026-06-0[1-4]$/.test(date)) throw Error('FIXTURE_DATE_ONLY');
    const result = generateDaily({ date, seed: `fortcuster-${date}`, version: algorithmVersion, config: canonicalConfig() });
    output(publicationDocument(result, new Date(`${date}T13:00:00.000Z`)));
  } else if (mode === 'write' || mode === 'reconcile') {
    const { writeFixture, reconcileFixture } = await import('./protocol.mjs');
    const policy = JSON.parse(await readFile('/policy/policy.json', 'utf8'));
    const request = JSON.parse(await readFile('/request/request.json', 'utf8'));
    output({ code: await (mode === 'write' ? writeFixture : reconcileFixture)({ request, policy, measured, fault: process.argv[3] }) });
  } else if (mode === 'unauthenticated') {
    const assert = (await import('node:assert/strict')).default;
    const { client, database } = await import('./protocol.mjs');
    const connection = await client();
    try {
      await assert.rejects(connection.db(database).command({ insert: 'mazes', documents: [{ date: '2099-01-01' }] }), { code: 13 });
      output({ code: 'UNAUTHENTICATED_DENIED' });
    } finally { await connection.close(); }
  } else if (mode === 'privileges') {
    const assert = (await import('node:assert/strict')).default;
    const { client, database } = await import('./protocol.mjs');
    const connection = await client(JSON.parse(await readFile('/writer/auth.json', 'utf8')));
    try {
      const db = connection.db(database);
      for (const command of [
        { update: 'mazes', updates: [{ q: { date: '2099-01-01' }, u: { $set: { seed: 'forbidden' } } }] },
        { delete: 'mazes', deletes: [{ q: { date: '2099-01-01' }, limit: 1 }] },
        { createIndexes: 'mazes', indexes: [{ key: { forbidden: 1 }, name: 'forbidden' }] },
        { collMod: 'mazes', validationLevel: 'off' },
        { find: 'players', filter: {}, limit: 1 },
        { delete: 'claims', deletes: [{ q: {}, limit: 0 }] },
        { update: 'audit', updates: [{ q: {}, u: { $set: { forbidden: true } } }] },
      ]) await assert.rejects(db.command(command), { code: 13 });
      if (process.argv[3] === 'reader') await assert.rejects(db.command({ insert: 'mazes', documents: [{ date: '2099-01-01' }] }), { code: 13 });
      output({ code: 'PRIVILEGES_VERIFIED' });
    } finally { await connection.close(); }
  } else if (mode === 'probe') {
    const assert = (await import('node:assert/strict')).default;
    assert.equal(process.getuid(), Number(process.argv[3]));
    const status = await readFile('/proc/self/status', 'utf8');
    assert.match(status, /^NoNewPrivs:\s+1$/m); assert.match(status, /^Seccomp:\s+2$/m);
    assert.match(status, /^CapEff:\s+0+$/m);
    assert.deepEqual(await readdir('/sys/class/net'), ['lo']);
    assert.equal((await readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim(), '268435456');
    assert.equal((await readFile('/sys/fs/cgroup/memory.swap.max', 'utf8')).trim(), '0');
    assert.equal((await readFile('/sys/fs/cgroup/pids.max', 'utf8')).trim(), '32');
    assert.equal((await readFile('/sys/fs/cgroup/cpu.max', 'utf8')).trim(), '50000 100000');
    await assert.rejects(writeFile('/app/tamper', 'x'), { code: 'EROFS' });
    await assert.rejects(writeFile('/tmp/too-big', Buffer.alloc(9 * 1024 * 1024)), { code: 'ENOSPC' });
    await assert.rejects(access('/var/run/docker.sock'));
    await assert.rejects(access('/bin/sh'));
    if (process.getuid() === 10001) for (const path of ['/writer/auth.json', '/socket/mongodb-27017.sock', '/policy/policy.json']) await assert.rejects(access(path));
    const denied = host => new Promise((resolve, reject) => {
      const socket = net.connect({ host, port: 27017 });
      const timer = setTimeout(() => { socket.destroy(); reject(Error('NETWORK_PROBE_TIMEOUT')); }, 1500);
      socket.once('connect', () => { clearTimeout(timer); socket.destroy(); reject(Error('EGRESS_ALLOWED')); });
      socket.once('error', e => { clearTimeout(timer); resolve(e.code); });
    });
    const network = await Promise.all(['1.1.1.1', '127.0.0.1', '169.254.169.254', '::1'].map(denied));
    const resolver = new dns.Resolver({ timeout: 250, tries: 1 }); resolver.setServers(['1.1.1.1']);
    let dnsDenied = false;
    try { await resolver.resolve4('example.com'); } catch { dnsDenied = true; }
    assert.ok(dnsDenied);
    output({ code: 'OS_BOUNDARIES_VERIFIED', uid: process.getuid(), network, dnsDenied });
  } else if (mode === 'memory') {
    const held = []; for (;;) held.push(Buffer.alloc(16 * 1024 * 1024, 1));
  } else if (mode === 'cpu') {
    const end = performance.now() + 700; while (performance.now() < end) { /* deliberate quota overrun */ }
    output({ cpu: await readFile('/sys/fs/cgroup/cpu.stat', 'utf8') });
  } else if (mode === 'pids') {
    const children = [];
    for (let i = 0; i < 64; i++) {
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
      children.push(child);
      const ok = await new Promise(resolve => { child.once('spawn', () => resolve(true)); child.once('error', () => resolve(false)); });
      if (!ok) break;
    }
    output({ events: await readFile('/sys/fs/cgroup/pids.events', 'utf8') });
    for (const child of children) if (child.pid) child.kill('SIGKILL');
  } else if (mode === 'tree') {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
    output({ code: 'DETACHED_CHILD_STARTED' }); setInterval(() => {}, 1000);
  } else if (mode === 'admin') {
    const { admin } = await import('./fixture-admin.mjs'); output(await admin(process.argv[3]));
  } else throw Error('FIXTURE_MODE_INVALID');
} catch (error) {
  const allowed = ['SOURCE_MODIFIED', 'SOURCE_UNTRUSTED', 'CERTIFICATE_INVALID', 'APPROVAL_INVALID'];
  output({ code: allowed.includes(error.code ?? error.message) ? error.code ?? error.message : 'FIXTURE_REFUSED' });
  process.exitCode = 2;
}
