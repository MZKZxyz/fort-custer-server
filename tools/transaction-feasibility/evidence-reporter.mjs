// Node test reporter with an explicit privacy allowlist. No paths, stacks, URIs,
// process IDs, account identifiers, environment values or raw database logs.
export default async function* report(events) {
  const tests = [];
  for await (const event of events) {
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      tests.push({ name: event.data.name, outcome: event.data.skip ? 'skip' : event.data.todo ? 'todo'
        : event.type === 'test:pass' ? 'pass' : 'fail' });
    }
  }
  yield JSON.stringify({ schemaVersion: 1, tests: tests.length,
    passed: tests.filter(t => t.outcome === 'pass').length,
    failed: tests.filter(t => t.outcome === 'fail').length,
    skipped: tests.filter(t => t.outcome === 'skip').length,
    todo: tests.filter(t => t.outcome === 'todo').length, results: tests }, null, 2) + '\n';
}
