import assert from 'node:assert/strict';
import { spawnIntegration } from './client.mjs';
import { date, transcript } from './fixtures.mjs';
const env = await spawnIntegration();
try {
  const identity = await env.bootstrap();
  const request = async (path, body, revision) => {
    const response = await fetch(env.metadata.baseURL + '/api/v2' + path, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/json',
        'X-Fort-Custer-Protocol': 'session-v2', 'X-Fort-Custer-Capabilities': 'route-transcript-v1',
        ...(revision ? { 'If-Match': `"${revision}"` } : {}) },
      ...(body ? { body: JSON.stringify({ subProfileId: identity.subProfileId, ...body }) } : {}) });
    assert.equal(response.status, 200); return response.json();
  };
  assert.equal((await request('/capabilities')).admission, true);
  const prepared = await request('/sessions', { date, createKey: 'smoke-create-0001' });
  const started = await request(`/sessions/${prepared.attemptId}/ready`, { key: 'smoke-ready-0001', nonce: prepared.nonce,
    gridHash: prepared.gridHash, rulesVersion: prepared.manifest.rulesVersion }, prepared.revision);
  const receipt = await request(`/sessions/${started.attemptId}/complete`, { completionKey: 'smoke-complete-0001', transcript }, started.revision);
  assert.equal(receipt.timing.status, 'untimed'); assert.equal(receipt.collectible.status, 'awarded');
  assert.deepEqual(await request(`/sessions/${started.attemptId}/recover`, {}), receipt);
  process.stdout.write(JSON.stringify({ kind: 'integration-smoke', passed: true, timing: 'untimed', collectible: 'awarded' }) + '\n');
} finally { await env.close(); }
