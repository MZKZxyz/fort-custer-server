import mongoose from 'mongoose';
import { Store } from './store.mjs';

// Only the parent that spawned the temporary replica set supplies this URI over IPC.
let client, store, release;
process.on('message', async message => {
  if (message.resume) { release?.(); return; }
  const { call, uri, method, args = [], pause, crash, failStage, guards, commitAttempts } = message;
  try {
    if (uri) {
      if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/fc_synthetic\?replicaSet=fcSynthetic$/.test(uri)) throw new Error('Unsafe synthetic URI');
      client = new mongoose.mongo.MongoClient(uri, { appName: 'fc-feasibility-worker', serverSelectionTimeoutMS: 10000 });
      await client.connect();
    }
    let once = false, guardIndex = 0;
    store = new Store(client, {
      commitAttempts,
      guard: receipt => guards ? guards[Math.min(guardIndex++, guards.length - 1)] : receipt,
      hook: async stage => {
        if (stage === crash) process.kill(process.pid, 'SIGKILL');
        if (stage === failStage && !once) { once = true; throw Object.assign(new Error('Injected failure'), { code: 'INJECTED' }); }
        if (stage === pause && !once) {
          once = true;
          await new Promise(resolve => { release = resolve; process.send({ paused: stage, call }); });
          release = undefined;
        }
      },
    });
    const value = await store[method](...args);
    process.send({ call, value, stats: store.stats });
  } catch (error) {
    process.send({ call, error: { code: error.code, name: error.name, message: error.message }, stats: store?.stats });
  }
});
process.on('disconnect', () => { client?.close().finally(() => process.exit()); });
