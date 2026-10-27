import { parseArgs } from 'node:util';
import { generateInWorker } from '../../services/publication/executor.js';
import { parseCivilInstant } from '../../services/publication/ingress.js';
import { publicationDocument } from '../../services/publication/policy.js';

// Preview only. This entrypoint never imports mongoose, a model or the writer.
try {
  const { values } = parseArgs({ options: { date: { type: 'string' }, at: { type: 'string' },
    config: { type: 'string' }, seed: { type: 'string' }, version: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) process.stdout.write('Offline constrained publication preview; no apply mode.\n--date YYYY-MM-DD [--at civil-ISO-instant] [--config JSON] [--seed TEXT] [--version daily-dfs-v1]\n');
  else {
    const now = values.at === undefined ? new Date() : parseCivilInstant(values.at);
    const input = { date: values.date, ...(values.config === undefined ? {} : { config: JSON.parse(values.config) }),
      ...(values.seed === undefined ? {} : { seed: values.seed }), ...(values.version === undefined ? {} : { version: values.version }) };
    const { result, metrics } = await generateInWorker(input, now);
    process.stdout.write(JSON.stringify({ mode: 'offline-dry-run', document: publicationDocument(result, now),
      analysis: result.analysis, metrics }, null, 2) + '\n');
  }
} catch (error) {
  process.stderr.write(JSON.stringify({ code: error.code ?? 'INVALID_PREVIEW_INPUT',
    ...(error.attempts ? { attempts: error.attempts } : {}), ...(error.metrics ? { metrics: error.metrics } : {}) }) + '\n');
  process.exitCode = 1;
}
