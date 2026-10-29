// Synthetic command adapter/phase fixture, not an OS or Docker enforcement proof.
import { appendFile, writeFile } from 'node:fs/promises';
import { cleanupSteps, commandFailure, failureReport, runWithCleanup } from '../operator-publication/isolation/proof-outcome.mjs';

const [scenario, evidence, trace] = process.argv.slice(2);
const id = 'a'.repeat(64);
const secret = 'synthetic-private-canary';
const sensitive = `mongodb://fixture:${secret}@fixture.invalid/ private-key=${secret} grid=${secret} signature=${secret}`;
const record = value => appendFile(trace, JSON.stringify(value) + '\n');
try {
  await runWithCleanup(async () => {
    await record({ phase: 'primary' });
    if (['primary', 'combined'].includes(scenario)) throw commandFailure('docker', ['start', '-a', id], {
      exitCode: 31, stderr: `QA_PRIMARY_PROVISION_FAILURE ${sensitive} ${'x'.repeat(10000)}` });
    if (scenario === 'unknown') throw Object.assign(Error(sensitive), { code: secret, cause: Error(sensitive) });
    if (scenario === 'falsy') throw undefined;
  }, async () => {
    const steps = [async () => {
      await record({ phase: 'cleanup', args: ['rm', '-f', id] });
      if (['cleanup', 'combined'].includes(scenario)) throw commandFailure('docker', ['rm', '-f', id], {
        exitCode: 32, stderr: `QA_SECONDARY_CLEANUP_FAILURE ${sensitive} ${'x'.repeat(10000)}` });
    }, async () => {
      await record({ phase: 'verify' });
      if (['cleanup', 'combined'].includes(scenario)) throw Object.assign(Error(`DISPOSAL_INCOMPLETE ${sensitive}`), { code: 'ERR_ASSERTION' });
    }];
    if (scenario === 'overflow') for (let i = 0; i < 20; i++) steps.push(async () => {
      await record({ phase: 'additional-cleanup', i });
      throw commandFailure('docker', ['rm', '-f', id], { exitCode: 32, stderr: `QA_SECONDARY_CLEANUP_FAILURE ${sensitive}` });
    });
    await cleanupSteps(steps);
  });
  await writeFile(evidence, JSON.stringify({ synthetic: true }), { flag: 'wx', mode: 0o600 });
} catch (error) {
  process.stderr.write(failureReport(error) + '\n');
  process.exitCode = 1;
}
