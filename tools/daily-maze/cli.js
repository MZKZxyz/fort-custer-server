import { parseArgs } from 'node:util';
import { generateDaily, GenerationError } from '../../lib/maze/engine.js';
import { inclusiveDates, validateDate } from '../../lib/maze/dates.js';

const help = `Offline daily maze preview (Node 24); JSON only, no database or network.
node tools/daily-maze/cli.js --date 2026-01-01
node tools/daily-maze/cli.js --range 2028-01-01:2028-12-31
Options: --seed TEXT (single date only), --version daily-dfs-v1,
  --width 13 --height 17 --min-distance 25 --max-attempts 10 --max-states 100000
Ranges are inclusive, at most 366 days. Future dates may be previewed offline.
Exit 0: every date accepted; 1: invalid input; 2: bounded generation exhaustion.
On failure stdout is empty; stderr contains diagnostics, never a partial maze report.
`;

try {
  const { values } = parseArgs({ options: {
    date: { type: 'string' }, range: { type: 'string' }, seed: { type: 'string' },
    version: { type: 'string' }, width: { type: 'string' }, height: { type: 'string' },
    'min-distance': { type: 'string' }, 'max-attempts': { type: 'string' },
    'max-states': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) process.stdout.write(help);
  else {
    if (Number(values.date !== undefined) + Number(values.range !== undefined) !== 1) throw new Error('CHOOSE_DATE_OR_RANGE');
    let dates;
    if (values.date !== undefined) dates = [validateDate(values.date)];
    else {
      const parts = values.range.split(':');
      if (parts.length !== 2 || values.seed !== undefined) throw new Error('INVALID_RANGE_OPTIONS');
      dates = inclusiveDates(...parts);
    }
    const config = {};
    for (const [flag, key] of [['width', 'width'], ['height', 'height'], ['min-distance', 'minDistance'],
      ['max-attempts', 'maxAttempts'], ['max-states', 'maxStates']]) {
      if (values[flag] === undefined) continue;
      if (!/^\d+$/.test(values[flag])) throw new Error('INVALID_INTEGER_OPTION');
      config[key] = Number(values[flag]);
    }
    // Buffer at most 366 bounded records; publish stdout only if the whole range succeeds.
    const records = dates.map(date => {
      const { maze, analysis, ...identity } = generateDaily({ date, version: values.version, seed: values.seed, config });
      const { actions, path, interactions, ...solution } = analysis.solution;
      return { ...identity, maze, exact: analysis.exact, solution, heuristics: analysis.heuristics, issues: analysis.issues };
    });
    process.stdout.write(JSON.stringify({ schemaVersion: 1, mode: 'offline-dry-run', records,
      summary: { dates: records.length, accepted: records.length,
        rejectedAttempts: records.reduce((sum, r) => sum + r.attempts.length - 1, 0) } }, null, 2) + '\n');
  }
} catch (error) {
  const exhausted = error instanceof GenerationError;
  process.stderr.write(JSON.stringify({ code: error.message,
    ...(exhausted ? { date: error.identity.date, identityHash: error.identity.identityHash, attempts: error.attempts } : {}) }) + '\n');
  process.exitCode = exhausted ? 2 : 1;
}
