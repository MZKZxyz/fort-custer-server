import { fork } from 'node:child_process';
import { until } from './replica-set.mjs';

export class Worker {
  constructor(uri) {
    this.uri = uri; this.next = 0; this.calls = new Map(); this.pauses = new Map();
    this.child = fork(new URL('./worker.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    this.exited = new Promise(resolve => this.child.once('exit', (code, signal) => {
      this.dead = true;
      for (const done of this.calls.values()) done({ error: { code: 'WORKER_EXIT', signal } });
      this.calls.clear(); resolve({ code, signal });
    }));
    this.child.on('message', message => {
      if (message.paused) this.pauses.set(message.call, message.paused);
      else { this.calls.get(message.call)?.(message); this.calls.delete(message.call); }
    });
  }
  run(method, args, options = {}) {
    const call = ++this.next;
    const promise = new Promise(resolve => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL'); resolve({ error: { code: 'WORKER_TIMEOUT' } });
      }, 30000);
      this.calls.set(call, value => { clearTimeout(timer); resolve(value); });
      this.child.send({ call, uri: this.next === 1 ? this.uri : undefined, method, args, ...options });
    });
    promise.call = call;
    return promise;
  }
  async paused(promise) { return until(() => this.pauses.get(promise.call)); }
  resume() { this.child.send({ resume: true }); }
  async close() {
    if (!this.dead) this.child.kill('SIGKILL');
    await this.exited;
  }
}
