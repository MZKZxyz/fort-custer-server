export const PROTOCOL = 'session-v2';
export const CAPABILITY = 'route-transcript-v1';
export const POLICY = Object.freeze({ prepareMs: 300000, playMs: 7200000,
  maxClockChecks: 16, maxGenerations: 8, maxKeysPerAttempt: 16,
  maxUncertaintyMs: 10, maxEnvelopeBytes: 4096, maxConcurrentValidation: 2 });

// No monitored clock authority is installed by this slice. Wall time supplies
// server timestamps but can never certify ranked timing by itself.
export const systemClock = Object.freeze({ sample: () => ({ at: Date.now(),
  epoch: 'unmonitored-wall-v1', healthy: false, uncertaintyMs: null, evidenceId: null }) });
export function sample(clock) {
  let value;
  try { value = clock.sample(); } catch { return null; }
  if (!value || !Number.isSafeInteger(value.at)) return null;
  return { at: value.at, epoch: typeof value.epoch === 'string' ? value.epoch.slice(0, 128) : null,
    healthy: value.healthy === true, uncertaintyMs: Number.isFinite(value.uncertaintyMs) && value.uncertaintyMs >= 0 ? value.uncertaintyMs : null,
    evidenceId: typeof value.evidenceId === 'string' ? value.evidenceId.slice(0, 128) : null };
}
export function timing(start, receipt, guard, checks, maxUncertaintyMs) {
  const elapsedMs = receipt.at - start.at;
  const evidence = [start, receipt, guard];
  const comparable = evidence.every(e => e?.epoch && e.epoch === start.epoch);
  const healthy = comparable && elapsedMs >= 0 && evidence.every(e => e.healthy && e.evidenceId
    && e.uncertaintyMs !== null && e.uncertaintyMs <= maxUncertaintyMs)
    && Object.values(checks).every(c => c.state === 'healthy');
  return { status: healthy ? 'official' : 'untimed', elapsedMs: healthy ? elapsedMs : null,
    reason: healthy ? null : 'TIMING_REVIEW_REQUIRED' };
}
