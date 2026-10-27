import express from 'express';
import mongoose from 'mongoose';
import Maze from '../models/Maze.js';
import User from '../models/User.js';
import { protect } from '../middleware/authMiddleware.js';
import { createCatalog } from '../services/publication/catalog.js';
import { monthDates, trustedInstant } from '../services/publication/ingress.js';
import { legacyPolicy } from '../services/publication/policy.js';
import { utcDate } from '../lib/maze/dates.js';

export function createArchiveRouter({ now = () => new Date(), legacy = legacyPolicy } = {}) {
  const router = express.Router(), catalog = createCatalog({ MazeModel: Maze, legacy });
  router.get('/archive', (req, res, next) => {
    req.archiveStarted = performance.now();
    res.set('Cache-Control', 'private, no-store');
    res.vary('Authorization');
    // Inspect the raw URL to reject duplicate, bracketed or unknown scalar parameters
    // independently of the application's Express query-parser setting.
    const params = new URL(req.originalUrl, 'http://localhost').searchParams;
    if ([...params.keys()].some(key => !['month', 'subProfileId'].includes(key))
        || params.getAll('month').length > 1 || params.getAll('subProfileId').length > 1) {
      return res.status(400).json({ error: 'Invalid archive query.', code: 'INVALID_QUERY' });
    }
    req.archiveParams = params;
    if (params.has('subProfileId')) return protect(req, res, next);
    next();
  }, async (req, res) => {
    try {
      const sampled = trustedInstant(now()), params = req.archiveParams;
      const month = params.has('month') ? params.get('month') : utcDate(sampled).slice(0, 7);
      let requestedDates;
      try { requestedDates = monthDates(month); } catch { return res.status(400).json({ error: 'A real YYYY-MM month is required.', code: 'INVALID_MONTH' }); }
      let progress;
      if (params.has('subProfileId')) {
        const id = params.get('subProfileId');
        if (!mongoose.isObjectIdOrHexString(id)) return res.status(400).json({ error: 'Invalid profile identifier.', code: 'INVALID_PROFILE_ID' });
        if (!mongoose.isObjectIdOrHexString(req.user?.id)) return res.status(401).json({ error: 'Invalid token' });
        // Only the owned subdocument's requested month/today booleans leave MongoDB.
        const selectedProgress = Object.fromEntries([...new Set([...requestedDates, utcDate(sampled)])]
          .map(date => [date, { completed: { $eq: [`$progress.${date}.completed`, true] } }]));
        const [user] = await User.aggregate([
          { $match: { _id: new mongoose.Types.ObjectId(req.user.id), 'subProfiles._id': new mongoose.Types.ObjectId(id) } },
          { $project: { _id: 0, progress: { $arrayElemAt: [{ $map: {
            input: { $filter: { input: '$subProfiles', as: 'profile', cond: { $eq: ['$$profile._id', new mongoose.Types.ObjectId(id)] } } },
            as: 'profile', in: '$$profile.progress',
          } }, 0] } } },
          { $project: { _id: 0, progress: selectedProgress } },
        ]).option({ maxTimeMS: 2000 });
        if (!user) return res.status(404).json({ error: 'Profile not found.', code: 'PROFILE_NOT_FOUND' });
        progress = user.progress ?? {};
      }
      const result = await catalog.month(month, sampled, progress);
      if (!params.has('subProfileId') && !req.get('Authorization')) {
        const ttl = Math.min(60, Math.floor((Date.parse(result.nextDayAt) - sampled.getTime()
          - (performance.now() - req.archiveStarted)) / 1000));
        if (ttl > 0) res.set('Cache-Control', `public, max-age=${ttl}`);
      }
      res.json(result);
    } catch {
      res.set('Cache-Control', 'private, no-store');
      res.status(503).json({ error: 'Published dates could not be loaded. Retry shortly.', code: 'ARCHIVE_UNAVAILABLE' });
    }
  });
  return router;
}
