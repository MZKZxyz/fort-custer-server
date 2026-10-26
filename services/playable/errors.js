export class PlayableError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}
export const fail = (code, status) => { throw new PlayableError(code, status); };
export function matched(write) { if (write.matchedCount !== 1) fail('SESSION_CHANGED'); }
export function errorBody(error) {
  const known = error instanceof PlayableError;
  const code = known ? error.code : 'SAVE_UNAVAILABLE';
  return { status: known ? error.status : 503, body: { error: code,
    ...((known ? error.status : 503) === 503 ? { retrySameOperation: true, outcome: 'unresolved' } : {}) } };
}
