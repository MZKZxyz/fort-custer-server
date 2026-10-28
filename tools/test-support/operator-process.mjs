// Owned fixture process: no environment database selectors, no production target.
import { registerHooks } from 'node:module';
import mongoose from 'mongoose';
import Maze from '../../models/Maze.js';

process.once('message', async ({ uri, context, plan, approval, root, kind }) => {
  if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/fc_publication_synthetic_operator\?replicaSet=fcSynthetic$/.test(uri)) throw Error('UNSAFE_FIXTURE');
  if (kind === 'kill-worker') {
    registerHooks({ resolve(specifier, ctx, next) {
      if (specifier === 'node:child_process' && ctx.parentURL?.endsWith('/services/publication/executor.js')) {
        const code = "import {fork as real} from 'node:child_process'; export function fork(...args){const c=real(...args); setImmediate(()=>c.kill('SIGKILL')); return c;}";
        return { url: 'data:text/javascript,' + encodeURIComponent(code), shortCircuit: true };
      }
      return next(specifier, ctx);
    } });
  }
  try {
    // One sequential local fixture; same reviewed caps as the parent fixture.
    await mongoose.connect(uri, { autoCreate: false, autoIndex: false, retryReads: false, retryWrites: false,
      maxPoolSize: 1, waitQueueTimeoutMS: 2000, serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000, socketTimeoutMS: 3000 });
    const command = mongoose.connection.db.command.bind(mongoose.connection.db);
    mongoose.connection.db.command = async (value, ...args) => {
      if (value.insert && kind === 'crash-before-insert') process.kill(process.pid, 'SIGKILL');
      const result = await command(value, ...args);
      if (value.insert && kind === 'crash-after-insert') process.kill(process.pid, 'SIGKILL');
      return result;
    };
    const { RehearsalLedger } = await import('../operator-publication/ledger.mjs');
    const { operateDisposable } = await import('../operator-publication/rehearsal.mjs');
    const result = await operateDisposable({ model: Maze, context, plan, approval, ledger: new RehearsalLedger(root),
      clock: () => new Date('2026-06-01T13:00:00.000Z') });
    process.send(result);
  } finally { await mongoose.disconnect(); process.disconnect(); }
});
