import { createHash } from 'node:crypto';

// Even test names are untrusted: file failures use paths, and dynamic titles can
// contain arbitrary private strings. Emit fixed categories and stable digests,
// never free-form titles, paths, exceptions, stdout/stderr or diagnostic fields.
export function safeName(value) {
  const name = typeof value === 'string' ? value : '';
  if (/^(?:[/.\\]|[A-Za-z]:[\\/]|file:)/.test(name)
      || /(?:^|[\\/])[^\s]*\.(?:[cm]?js|tsx?)(?::\d+)?$/.test(name)) return 'file-level failure';
  const group = name.match(/^T[1-8](?:\/T[1-8])?(?=\s)/)?.[0] || 'test';
  return `${group}:${createHash('sha256').update(name).digest('hex').slice(0, 20)}`;
}

export default async function* report(events) {
  const tests = [];
  for await (const event of events) {
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      tests.push({ name: safeName(event.data.name), outcome: event.data.skip ? 'skip' : event.data.todo ? 'todo'
        : event.type === 'test:pass' ? 'pass' : 'fail' });
    }
  }
  yield JSON.stringify({ schemaVersion: 2, tests: tests.length,
    passed: tests.filter(t => t.outcome === 'pass').length,
    failed: tests.filter(t => t.outcome === 'fail').length,
    skipped: tests.filter(t => t.outcome === 'skip').length,
    todo: tests.filter(t => t.outcome === 'todo').length, results: tests }, null, 2) + '\n';
}
