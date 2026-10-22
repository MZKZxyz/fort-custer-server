import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { generate } from './generator.js';
import { analyze } from './analyzer.js';
import { batch, metadata, summarize } from './batch.js';

const help = `Offline maze analyzer (Node 24). Never imports the API or connects to MongoDB.
node tools/maze-analyzer/cli.js --seed sprint4-42
node tools/maze-analyzer/cli.js --grid fixture.json
node tools/maze-analyzer/cli.js --batch 10000 --prefix sprint4 --format jsonl
Options: --start 0 --width 13 --height 17 --min-distance 25 --max-states 100000
Formats: json (single or batch report), jsonl (streamed batch), csv (streamed batch).
JSON grid input: array of strings/rows, or {"grid": [...]}. Exactly one S and E required.
Exit: 0 completed (including reported failures), 1 invalid invocation/input. Check report issues.
`;
async function write(value) { if (!process.stdout.write(value)) await once(process.stdout, 'drain'); }
try {
  const { values } = parseArgs({ options: {
    seed: { type: 'string' }, grid: { type: 'string' }, batch: { type: 'string' },
    prefix: { type: 'string', default: 'sprint4' }, start: { type: 'string', default: '0' },
    width: { type: 'string', default: '13' }, height: { type: 'string', default: '17' },
    'min-distance': { type: 'string', default: '25' }, 'max-states': { type: 'string', default: '100000' },
    format: { type: 'string', default: 'json' }, help: { type: 'boolean' },
  } });
  if (values.help) { await write(help); } else {
    if ([values.seed, values.grid, values.batch].filter(x => x !== undefined).length !== 1) throw new Error('Choose exactly one of --seed, --grid, --batch');
    if (!['json', 'jsonl', 'csv'].includes(values.format)) throw new Error('Unknown format');
    const integer = (key, min, max) => {
      if (!/^\d+$/.test(values[key])) throw new Error(`Invalid --${key}`);
      const n = Number(values[key]);
      if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid --${key}`);
      return n;
    };
    const options = { width: integer('width', 3, 101), height: integer('height', 3, 101),
      minDistance: integer('min-distance', 1, 1000000), maxStates: integer('max-states', 1, 1000000) };
    if (options.width % 2 !== 1 || options.height % 2 !== 1) throw new Error('Dimensions must be odd');
    const meta = metadata(options);
    if (values.batch !== undefined) {
      Object.assign(options, { prefix: values.prefix, start: integer('start', 0, Number.MAX_SAFE_INTEGER), count: integer('batch', 1, 100000) });
      const records = () => batch(options);
      if (values.format === 'json') {
        // JSON arrays are streamed as well; retain only constant-space summary counters.
        await write(`{"metadata":${JSON.stringify(meta)},"records":[`);
        let first = true;
        const iterator = records();
        const summary = summarize([]);
        let moveSum = 0;
        for (const record of iterator) {
          await write(`${first ? '' : ','}${JSON.stringify(record)}`); first = false;
          summary.total++;
          if (record.solution?.solvable === true) {
            summary.solved++; const n = record.solution.minimumMoves; moveSum += n;
            summary.minimumMoves = summary.minimumMoves === null ? n : Math.min(summary.minimumMoves, n);
            summary.maximumMoves = summary.maximumMoves === null ? n : Math.max(summary.maximumMoves, n);
          }
          for (const issue of record.issues) summary.issueCounts[issue] = (summary.issueCounts[issue] || 0) + 1;
        }
        summary.meanMoves = summary.solved ? moveSum / summary.solved : null;
        await write(`],"summary":${JSON.stringify(summary)}}\n`);
      } else {
        if (values.format === 'jsonl') await write(`${JSON.stringify({ metadata: meta })}\n`);
        else await write('seed,status,minimumMoves,score,issues,error\n');
        for (const record of records()) {
          if (values.format === 'jsonl') await write(`${JSON.stringify(record)}\n`);
          else {
            const row = [record.seed, record.solution?.status, record.solution?.minimumMoves,
              record.heuristics?.score, record.issues.join('|'), record.error];
            await write(row.map(v => `"${String(v ?? '').replaceAll('"', '""')}"`).join(',') + '\n');
          }
        }
      }
    } else {
      if (values.format !== 'json') throw new Error('Single analysis supports --format json');
      const input = values.grid ? JSON.parse(readFileSync(values.grid, 'utf8')) : generate(values.seed, options);
      const grid = input.grid ?? input;
      await write(JSON.stringify({ metadata: meta, seed: values.seed ?? null, grid, ...analyze(grid, options) }, null, 2) + '\n');
    }
  }
} catch (error) {
  process.stderr.write(`${error.message}\nUse --help for usage.\n`); process.exitCode = 1;
}
