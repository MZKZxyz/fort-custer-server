import express from 'express';
import { randomUUID } from 'node:crypto';
import { completeAttempt } from '../services/completions.js';
import mongoose from 'mongoose';
import User, { assertUserVersion } from '../models/User.js';
import Maze from '../models/Maze.js'; // make sure this is imported
import RewardItem from '../models/RewardItem.js';
import { protect } from '../middleware/authMiddleware.js';
import { createArchiveRouter } from './archiveRoutes.js';
import { createCatalog } from '../services/publication/catalog.js';
import { legacyPolicy } from '../services/publication/legacy-runtime.js';
import { trustedInstant } from '../services/publication/ingress.js';
import { validateDate, utcDate } from '../lib/maze/dates.js';

export function createMazeRouter({ complete = completeAttempt, compatible = false, now = () => new Date(), legacy = legacyPolicy } = {}) {
const router = express.Router();
const catalog = createCatalog({ MazeModel: Maze, legacy });
router.use(createArchiveRouter({ now, legacy }));
router.use(['/start', '/complete'], (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

// Reject invalid dates instead of normalizing overflow dates or throwing in handlers.
const validateAttempt = (req, res, next) => {
  const { subProfileId, date } = req.body || {};
  let valid = true;
  try { validateDate(date); } catch { valid = false; }
  if (!mongoose.isObjectIdOrHexString(subProfileId) || !valid) {
    return res.status(400).json({ error: 'A valid subProfileId and YYYY-MM-DD date are required',
      code: !mongoose.isObjectIdOrHexString(subProfileId) ? 'INVALID_PROFILE_ID' : 'INVALID_DATE' });
  }
  next();
};

// POST /maze/start
router.post('/start', protect, validateAttempt, async (req, res) => {
  const { subProfileId, date } = req.body;
  res.set('Cache-Control', 'private, no-store');

  try {
    const sampledNow = trustedInstant(now());
    const today = utcDate(sampledNow);
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const sub = user.subProfiles.id(subProfileId);
    if (!sub) return res.status(404).json({ error: 'Sub-profile not found' });
    const maze = await catalog.published(date, sampledNow);
    if (!maze) return res.status(404).json({ error: 'No published maze is available for this date.', code: 'MAZE_NOT_PUBLISHED' });
    if (!compatible && sub.collectibleWriterVersion !== undefined) return res.status(409).json({
      error: 'This profile requires the compatible completion writer.', code: 'COMPATIBLE_WRITER_REQUIRED',
    });

    assertUserVersion(user);

    // Ensure date key exists
    if (!sub.attempts.has(date)) {
      sub.attempts.set(date, []);
    }

    // Add new attempt
    const attempt = { attemptId: randomUUID(), started: sampledNow, completed: false };
    sub.attempts.get(date).push(attempt);
    user.markModified(`subProfiles.${user.subProfiles.indexOf(sub)}.attempts`);

    await user.save();

    res.status(200).json({
      maze: {
        grid: maze.grid,
        width: maze.width,
        height: maze.height,
      },
      seed: maze.seed,
      today,
      attemptId: attempt.attemptId,
      attemptIndex: sub.attempts.get(date).length - 1, // optional
    });
  } catch (err) {
    if (err instanceof mongoose.Error.VersionError) {
      return res.status(409).json({ error: 'Profile changed; reload before trying again' });
    }
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('Maze start error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});


// POST /maze/complete
router.post('/complete', protect, validateAttempt, async (req, res) => {
  try {
    const result = await complete(req.user.id, req.body);
    res.json(result);
  } catch (err) {
    if (!err.status) console.error('Maze completion error:', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not save your result. Retry with the same attempt.', code: err.code || 'SAVE_FAILED' });
  }
});

// GET /maze/rewards?subProfileId=abc123
router.get('/rewards', protect, async (req, res) => {
  const { subProfileId } = req.query;

  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const sub = user.subProfiles.id(subProfileId);
    if (!sub) return res.status(404).json({ error: 'Sub-profile not found' });

    const rewardIds = Array.from(sub.rewards.keys());
    const items = await RewardItem.find({ id: { $in: rewardIds } });

    // Include quantity in response
    const enriched = items.map(item => ({
      ...item.toObject(),
      quantity: sub.rewards.get(item.id) || 0,
    }));

    res.json(enriched);
  } catch (err) {
    console.error('Fetch rewards error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /maze/rewards/all
router.get('/rewards/all', async (req, res) => {
  try {
    const items = await RewardItem.find({});
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

return router;
}
export default createMazeRouter();
