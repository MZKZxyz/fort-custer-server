// Synthetic infrastructure only. Never accepts a caller-supplied URI or dbpath.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import mongoose from 'mongoose';

const { MongoClient } = mongoose.mongo;
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(fn, timeout = 20000) {
  const end = Date.now() + timeout;
  let error;
  do {
    try { const value = await fn(); if (value) return value; }
    catch (caught) { error = caught; }
    await delay(50);
  } while (Date.now() < end);
  throw error || new Error('Synthetic barrier timed out');
}

export async function replicaSet() {
  let child, client;
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const dir = await mkdtemp(join(tmpdir(), 'fc-transaction-'));
  const uri = `mongodb://127.0.0.1:${port}/fc_synthetic?replicaSet=fcSynthetic`;
  const start = async (init = false) => {
    child = spawn(process.env.MONGOD_BINARY || 'mongod', [
      '--dbpath', dir, '--bind_ip', '127.0.0.1', '--port', String(port),
      '--replSet', 'fcSynthetic', '--setParameter', 'enableTestCommands=1',
      '--logpath', join(dir, 'mongod.log'), '--logappend', '--wiredTigerCacheSizeGB', '0.25',
    ], { stdio: 'ignore' });
    let failure;
    child.on('error', error => { failure = error; });
    child.on('exit', code => { failure = new Error(`Synthetic mongod exited (${code})`); });
    const direct = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, {
      serverSelectionTimeoutMS: 250, connectTimeoutMS: 500,
    });
    try {
      await until(async () => {
        if (failure) throw failure;
        await direct.connect();
        return direct.db('admin').command({ ping: 1 });
      });
      if (init) await direct.db('admin').command({ replSetInitiate: {
        _id: 'fcSynthetic', members: [{ _id: 0, host: `127.0.0.1:${port}` }],
      } });
      await until(async () => (await direct.db('admin').command({ hello: 1 })).isWritablePrimary);
    } finally { await direct.close(); }
  };
  const stop = async (signal = 'SIGTERM') => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill(signal);
      await exited;
    }
  };
  const close = async () => {
    await client?.close();
    await stop();
    await rm(dir, { recursive: true, force: true });
  };
  try {
    await start(true);
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    return {
      uri, client, db: client.db(),
      restart: async () => { await stop('SIGKILL'); await start(); await client.db().command({ ping: 1 }); },
      fail: data => client.db('admin').command({ configureFailPoint: 'failCommand',
        mode: { times: 1 }, data }),
      failOff: () => client.db('admin').command({ configureFailPoint: 'failCommand', mode: 'off' }),
      stepDown: async () => {
        try { await client.db('admin').command({ replSetStepDown: 1, force: true }); }
        catch (error) { if (![11600, 11602, 189].includes(error.code) && error.name !== 'MongoNetworkError') throw error; }
        await until(async () => (await client.db('admin').command({ hello: 1 })).isWritablePrimary);
      },
      close,
    };
  } catch (error) { await close(); throw error; }
}
