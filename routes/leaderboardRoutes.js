import express from 'express';
import User from '../models/User.js';
import Maze from '../models/Maze.js';
import { createCatalog } from '../services/publication/catalog.js';
import { publicationPolicy as legacyPolicy } from '../services/publication/release-runtime.js';
import { trustedInstant } from '../services/publication/ingress.js';
import { verifiedRankings, utcWeek } from '../services/publication/rankings.js';
import { validateDate, utcDate } from '../lib/maze/dates.js';

export function createLeaderboardRouter({ now = () => new Date(), legacy = legacyPolicy } = {}) {
  const router = express.Router();
  const catalog = createCatalog({ MazeModel: Maze, legacy });
  router.get('/:timeframe', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const { timeframe } = req.params;
    if (!['daily', 'weekly', 'alltime'].includes(timeframe)) return res.status(404).json({ code: 'INVALID_TIMEFRAME', error: 'Unknown leaderboard.' });
    const params = new URL(req.originalUrl, 'http://localhost').searchParams;
    const parameter = timeframe === 'daily' ? 'date' : timeframe === 'weekly' ? 'start' : null;
    if ([...params.keys()].some(key => key !== parameter) || (parameter && params.getAll(parameter).length > 1)) {
      return res.status(400).json({ error: 'Invalid leaderboard query.', code: 'INVALID_QUERY' });
    }
    try {
      const sampled = trustedInstant(now());
      let dates;
      if (parameter) {
        const target = params.has(parameter) ? params.get(parameter) : utcDate(sampled);
        try { dates = timeframe === 'weekly' ? utcWeek(target) : [validateDate(target)]; }
        catch { return res.status(400).json({ error: 'A real YYYY-MM-DD date is required.', code: 'INVALID_DATE' }); }
        if (timeframe === 'daily' && !await catalog.published(target, sampled)) return res.status(404).json({
          error: 'No published maze is available for this date.', code: 'MAZE_NOT_PUBLISHED',
        });
      }
      const scores = await verifiedRankings({ UserModel: User, MazeModel: Maze, now: sampled,
        dates, daily: timeframe === 'daily', policy: legacy });
      return res.json(scores);
    } catch {
      return res.status(503).json({ error: 'Published rankings could not be verified. Retry shortly.', code: 'LEADERBOARD_UNAVAILABLE' });
    }
  });
  return router;
}
export default createLeaderboardRouter();
