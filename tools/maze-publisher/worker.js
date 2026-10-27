// Private computation child. No database, environment configuration or writer imports.
import { generateDaily } from '../../lib/maze/engine.js';
import { publisherInput } from '../../services/publication/ingress.js';
process.once('message', ({ input, at }) => {
  let response;
  try {
    const result = generateDaily(publisherInput(input, at));
    const { actions, path, interactions, ...solution } = result.analysis.solution;
    response = { ok: true, result: { ...result, analysis: { ...result.analysis, solution } } };
  } catch (error) {
    response = { ok: false, code: error.code === 'GENERATION_EXHAUSTED' ? error.code : 'GENERATOR_FAILED',
      ...(error.code === 'GENERATION_EXHAUSTED' ? { attempts: error.attempts } : {}) };
  }
  response.metrics = { peakRssBytes: process.resourceUsage().maxRSS * 1024, heapUsedBytes: process.memoryUsage().heapUsed };
  process.send(JSON.stringify(response), () => process.disconnect());
});
