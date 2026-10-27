// Test subprocess guard: a preview may import only computation and CLI parsing.
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('node:') && !['node:crypto', 'node:util'].includes(specifier)
      || !specifier.startsWith('.') && !specifier.startsWith('/')
      && !specifier.startsWith('file:') && !specifier.startsWith('node:')) {
    throw new Error('OFFLINE_IMPORT_REFUSED');
  }
  return nextResolve(specifier, context);
} });
globalThis.fetch = () => { throw new Error('OFFLINE_FETCH_REFUSED'); };
globalThis.WebSocket = class { constructor() { throw new Error('OFFLINE_SOCKET_REFUSED'); } };
