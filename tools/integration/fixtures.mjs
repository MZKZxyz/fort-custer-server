// Frozen synthetic inputs. No production data, credentials or signing keys.
export const date = '2025-05-26';
export const alternateDate = '2025-05-27';
export const grid = ['######', '#SXFE#', '#    #', '######'].map(row => [...row]);
export const transcript = { version: 'route-transcript-v1', commands:
  ['up', 'down', 'right', 'right', 'up', 'left', 'up', 'right', 'right', 'right'].map((dir, i) => ({ seq: i + 1, dir })) };
export const shortTranscript = { version: 'route-transcript-v1', commands:
  ['right', 'right', 'right', 'right'].map((dir, i) => ({ seq: i + 1, dir })) };
export const catalog = [{ id: 'integration-compass', name: 'Synthetic Compass', image: '🧭',
  description: 'Disposable integration fixture', category: 'artifact', rarity: 'common' }];
export const epochId = 'synthetic-integration-only-v1';
