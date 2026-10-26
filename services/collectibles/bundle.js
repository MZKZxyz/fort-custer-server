import { SharedRewards } from './shared-rewards.js';
import { CompatibleLifecycle } from './lifecycle.js';
import { CompatibleLegacyCompletion } from './legacy-completion.js';
import { PlayableService } from '../playable/service.js';
import { createUserRouter } from '../../routes/userRoutes.js';
import { createMazeRouter } from '../../routes/mazeRoutes.js';
import { createPlayableRouter } from '../../routes/playableRoutes.js';

// One assembly boundary: compatible lifecycle, v1 and v2 always share one service.
// The production installer still refuses activation; this creates no collections.
export function createCompatibleBundle({ repository, epochId, secret, clock, choose, admissionEnabled = false }) {
  const rewards = new SharedRewards(repository, { epochId, choose });
  const lifecycle = new CompatibleLifecycle(rewards);
  const legacy = new CompatibleLegacyCompletion(rewards);
  const playable = new PlayableService(repository, { clock, rewards, admissionEnabled });
  return { rewards, lifecycle, legacy, playable,
    users: createUserRouter({ lifecycle }),
    maze: createMazeRouter({ compatible: true, complete: legacy.complete.bind(legacy) }),
    v2: createPlayableRouter({ service: playable, secret, enabled: true }) };
}
