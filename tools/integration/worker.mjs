// Private child of launch.mjs. Never exported as an application entrypoint.
import { AsyncLocalStorage } from 'node:async_hooks';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { PlayableRepository } from '../../services/playable/repository.js';
import { PlayableError } from '../../services/playable/errors.js';
import { systemClock } from '../../services/playable/policy.js';

let server, repo, fault, clockAt = null, release;
const requests = new AsyncLocalStorage();
const reply = (id, value) => process.connected && process.send({ id, value });
async function close() {
  release?.(); server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
}
process.on('disconnect', () => { void close().finally(() => process.exit()); });
process.on('message', async ({ id, op, args = {} }) => {
  try {
    if (op === 'start') {
      if (repo || !/^mongodb:\/\/127\.0\.0\.1:\d+\/fc_synthetic\?replicaSet=fcSynthetic$/.test(args.uri)) throw Error();
      // Real route modules call dotenv.config() at import time. Never read a
      // developer .env or reuse its JWT secret/database/config in this child.
      dotenv.config = () => ({ parsed: {} });
      process.env.JWT_SECRET = args.secret;
      await mongoose.connect(args.uri);
      repo = new PlayableRepository(mongoose.connection.getClient(), mongoose.connection.db, { hook: async stage => {
        const req = requests.getStore();
        if (!fault || fault.hit || stage !== fault.stage || req?.path !== fault.path) return;
        fault.hit = true;
        if (fault.action === 'drop') req.res.destroy();
        else if (fault.action === 'crash') process.kill(process.pid, 'SIGKILL');
        else if (fault.action === 'fail') throw new PlayableError('SAVE_UNAVAILABLE', 503);
        else if (fault.action === 'pause') await new Promise(resolve => { release = resolve; });
      } });
      const [{ createCompatibleBundle }, { default: User }, { default: Maze }, { default: RewardItem }] = await Promise.all([
        import('../../services/collectibles/bundle.js'), import('../../models/User.js'),
        import('../../models/Maze.js'), import('../../models/RewardItem.js'),
      ]);
      await Promise.all([User.init(), Maze.init(), RewardItem.init()]);
      const bundle = createCompatibleBundle({ repository: repo, epochId: args.epochId, secret: args.secret,
        admissionEnabled: true, clock: { sample: () => ({ ...systemClock.sample(), ...(clockAt === null ? {} : { at: clockAt }) }) } });
      const app = express(); app.disable('x-powered-by');
      app.use((req, res, next) => {
        if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return res.sendStatus(403);
        const ownOrigin = `http://127.0.0.1:${server?.address()?.port}`;
        if (req.get('Origin') && !args.clientOrigins.includes(req.get('Origin')) && req.get('Origin') !== ownOrigin) return res.sendStatus(403);
        requests.run({ path: req.path, res }, next);
      });
      app.use(cors({ origin: (origin, done) => done(null, args.clientOrigins.includes(origin)
        || origin === `http://127.0.0.1:${server?.address()?.port}`), methods: ['GET', 'POST', 'PUT', 'DELETE'],
        allowedHeaders: ['Authorization', 'Content-Type', 'If-Match', 'X-Fort-Custer-Protocol', 'X-Fort-Custer-Capabilities'],
        exposedHeaders: ['Retry-After', 'Cache-Control'] }));
      app.use('/api/v2', bundle.v2); app.use(express.json());
      app.use('/api/users', bundle.users); app.use('/api/maze', bundle.maze);
      server = app.listen(args.port ?? 0, '127.0.0.1');
      await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
      reply(id, { port: server.address().port });
    } else if (op === 'fault') {
      if (!['afterCommit', 'finish:admitted', 'finish:committed', 'grant:inventory'].includes(args.stage)
        || !['drop', 'crash', 'fail', 'pause'].includes(args.action)
        || !/^\/api\/v2\/sessions(?:\/[a-f0-9-]{36}\/(?:ready|complete|abandon))?$/.test(args.path)) throw Error();
      release?.(); release = null; fault = { ...args, hit: false }; reply(id, { armed: true });
    } else if (op === 'fault-status') reply(id, { hit: fault?.hit === true });
    else if (op === 'release') { release?.(); release = null; reply(id, { released: true }); }
    else if (op === 'clock') {
      if (args.at !== null && !Number.isSafeInteger(args.at)) throw Error();
      clockAt = args.at; reply(id, { unmonitored: true });
    } else if (op === 'close') { await close(); reply(id, { closed: true }); process.disconnect(); }
    else throw Error();
  } catch { if (process.connected) process.send({ id, error: 'INTEGRATION_WORKER_OPERATION_FAILED' }); }
});
