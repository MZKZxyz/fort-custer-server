import { registerHooks } from 'node:module';
const allowed = new Set(['node:crypto', 'node:util', 'node:fs', 'node:path', 'node:url', 'node:os']);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('node:') && !allowed.has(specifier)
      || !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('file:') && !specifier.startsWith('node:')) {
    throw new Error('OFFLINE_IMPORT_REFUSED');
  }
  return nextResolve(specifier, context);
} });
globalThis.fetch = () => { throw new Error('OFFLINE_FETCH_REFUSED'); };
globalThis.WebSocket = class { constructor() { throw new Error('OFFLINE_SOCKET_REFUSED'); } };
