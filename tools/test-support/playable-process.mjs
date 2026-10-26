// Test-only application process. No environment database URI is consumed.
import express from 'express';
import mongoose from 'mongoose';
import { PlayableRepository } from '../../services/playable/repository.js';
import { PlayableService } from '../../services/playable/service.js';
import { createPlayableRouter } from '../../routes/playableRoutes.js';
let client, server;
process.once('message', async ({ uri, secret, at, crash }) => {
  if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/fc_synthetic\?replicaSet=fcSynthetic$/.test(uri)) throw new Error('Unsafe test database');
  client = new mongoose.mongo.MongoClient(uri);
  await client.connect();
  const repo = new PlayableRepository(client, client.db(), { hook: async stage => {
    if (stage === crash) process.kill(process.pid, 'SIGKILL');
  } });
  const service = new PlayableService(repo, { admissionEnabled: true,
    clock: { sample: () => ({ at, epoch: 'test-epoch', healthy: true, uncertaintyMs: 1, evidenceId: 'synthetic-monitor' }) } });
  const app = express(); app.use('/api/v2', createPlayableRouter({ service, secret, enabled: true }));
  server = app.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
});
process.on('disconnect', async () => { server?.close(); await client?.close(); process.exit(); });
