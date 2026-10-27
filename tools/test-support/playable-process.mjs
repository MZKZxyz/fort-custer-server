// Test-only application process. No environment database URI is consumed.
import express from 'express';
import mongoose from 'mongoose';
import { PlayableRepository } from '../../services/playable/repository.js';
import { PlayableService } from '../../services/playable/service.js';
import { createPlayableRouter } from '../../routes/playableRoutes.js';
import { fixturePublications } from './legacy-publications.mjs';
let client, server;
process.once('message', async ({ uri, secret, at, crash, compatible = false, epochId, ackEventId }) => {
  if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/fc_synthetic\?replicaSet=fcSynthetic$/.test(uri)) throw new Error('Unsafe test database');
  if (compatible) { process.env.JWT_SECRET = secret; await mongoose.connect(uri); client = mongoose.connection.getClient(); }
  else { client = new mongoose.mongo.MongoClient(uri); await client.connect(); }
  const repo = new PlayableRepository(client, client.db(), { hook: async stage => {
    if (stage === crash) process.kill(process.pid, 'SIGKILL');
  } });
  const clock = { sample: () => ({ at, epoch: 'test-epoch', healthy: true, uncertaintyMs: 1, evidenceId: 'synthetic-monitor' }) };
  const app = express();
  if (compatible) {
    const { createCompatibleBundle } = await import('../../services/collectibles/bundle.js');
    const publicationPolicy = fixturePublications(['2025-05-26', '2025-05-27'].map(date => [date, [['S', 'E']]]));
    const bundle = createCompatibleBundle({ repository: repo, epochId, secret, clock, choose: () => 0, admissionEnabled: true, publicationPolicy });
    if (ackEventId) { await bundle.rewards.acknowledge(ackEventId); process.send({ acked: true }); return; }
    app.use('/api/v2', bundle.v2); app.use(express.json()); app.use('/users', bundle.users); app.use('/maze', bundle.maze);
  } else {
    const service = new PlayableService(repo, { admissionEnabled: true, clock });
    app.use('/api/v2', createPlayableRouter({ service, secret, enabled: true }));
  }
  server = app.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
});
process.on('disconnect', async () => { server?.close(); await client?.close(); process.exit(); });
