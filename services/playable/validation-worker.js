import { parentPort, workerData } from 'node:worker_threads';
import { replayTranscript } from './transcript.js';
try {
  const result = replayTranscript(workerData.grid, workerData.manifest, workerData.transcript);
  parentPort.postMessage({ result: { transcriptHash: result.transcriptHash, commandCount: result.commandCount,
    pickups: result.pickups, cleared: result.cleared, blocked: result.blocked } });
} catch (error) { parentPort.postMessage({ error: { code: error.code, status: error.status } }); }
