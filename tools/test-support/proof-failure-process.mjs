// Synthetic command adapter/phase fixture, not an OS or Docker enforcement proof.
import { appendFile, writeFile } from 'node:fs/promises';
import { cleanupSteps, commandFailure, failureReport, runWithCleanup } from '../operator-publication/isolation/proof-outcome.mjs';

const [scenario, evidence, trace] = process.argv.slice(2);
const id = 'a'.repeat(64);
const secret = 'synthetic-private-canary';
const sensitive = `mongodb://fixture:${secret}@fixture.invalid/ private-key=${secret} grid=${secret} signature=${secret}`;
const record = value => appendFile(trace, JSON.stringify(value) + '\n');
const hostileMode = scenario.match(/^hostile-(primary|cleanup|combined|overflow)-(.+)$/);
let trapCalls = 0;
function hostile(kind) {
  const trap = () => { trapCalls++; throw Error(sensitive); };
  if (kind === 'code-getter') return { get code() { return trap(); } };
  if (kind === 'message-getter') return { code: 'ERR_ASSERTION', get message() { return trap(); } };
  if (kind === 'proxy') return new Proxy({}, { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
  if (kind === 'revoked-proxy') { const value = Proxy.revocable({}, {}); value.revoke(); return value.proxy; }
  if (kind === 'nested-proxy') return { message: new Proxy({}, { get: trap, getPrototypeOf: trap }) };
  if (kind === 'unprintable') return { message: { toString: trap, [Symbol.toPrimitive]: trap } };
  if (kind === 'symbol') return Symbol(sensitive);
  if (kind === 'prototype-proxy') return Object.create(new Proxy({}, { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap }));
  if (kind === 'branded') {
    const value = commandFailure('docker', ['start', id], { exitCode: 31, stderr: 'QA_PRIMARY_PROVISION_FAILURE' });
    Object.defineProperty(value, 'detail', { get: trap }); Object.defineProperty(value, 'message', { get: trap });
    return value;
  }
  throw Error('UNKNOWN_FIXTURE');
}
try {
  await runWithCleanup(async () => {
    await record({ phase: 'primary' });
    if (['primary', 'combined'].includes(scenario)) throw commandFailure('docker', ['start', '-a', id], {
      exitCode: 31, stderr: `QA_PRIMARY_PROVISION_FAILURE ${sensitive} ${'x'.repeat(10000)}` });
    if (scenario === 'unknown') throw Object.assign(Error(sensitive), { code: secret, cause: Error(sensitive) });
    if (scenario === 'falsy') throw undefined;
    if (hostileMode && ['primary', 'combined'].includes(hostileMode[1])) throw hostile(hostileMode[1] === 'combined' ? 'code-getter' : hostileMode[2]);
  }, async () => {
    const steps = [async () => {
      await record({ phase: 'cleanup', args: ['rm', '-f', id] });
      if (['cleanup', 'combined'].includes(scenario)) throw commandFailure('docker', ['rm', '-f', id], {
        exitCode: 32, stderr: `QA_SECONDARY_CLEANUP_FAILURE ${sensitive} ${'x'.repeat(10000)}` });
      if (hostileMode && ['cleanup', 'combined'].includes(hostileMode[1])) throw hostile(hostileMode[2]);
    }, async () => {
      await record({ phase: 'verify' });
      if (['cleanup', 'combined'].includes(scenario)) throw Object.assign(Error(`DISPOSAL_INCOMPLETE ${sensitive}`), { code: 'ERR_ASSERTION' });
    }];
    if (scenario === 'overflow') for (let i = 0; i < 20; i++) steps.push(async () => {
      await record({ phase: 'additional-cleanup', i });
      throw commandFailure('docker', ['rm', '-f', id], { exitCode: 32, stderr: `QA_SECONDARY_CLEANUP_FAILURE ${sensitive}` });
    });
    if (hostileMode?.[1] === 'overflow') steps.splice(1, 0, ...Array.from({ length: 25 }, (_, i) => async () => {
      await record({ phase: 'additional-cleanup', i }); throw hostile(hostileMode[2]);
    }));
    await cleanupSteps(steps);
  });
  await writeFile(evidence, JSON.stringify({ synthetic: true }), { flag: 'wx', mode: 0o600 });
} catch (error) {
  process.stderr.write(failureReport(error) + '\n');
  process.exitCode = 1;
} finally {
  if (hostileMode) await record({ phase: 'format-traps', calls: trapCalls });
}
