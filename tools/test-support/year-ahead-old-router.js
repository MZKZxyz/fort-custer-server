import express from 'express';
import { randomUUID } from 'node:crypto';
import { completeAttempt } from '../../services/completions.js';
import mongoose from 'mongoose';
import User, { assertUserVersion } from '../../models/User.js';
import Maze from '../../models/Maze.js'; // make sure this is imported
import RewardItem from '../../models/RewardItem.js';
import { protect } from '../../middleware/authMiddleware.js';

export function createMazeRouter({ complete = completeAttempt, compatible = false } = {}) {
const router = express.Router();

// Reject invalid dates instead of normalizing overflow dates or throwing in handlers.
const validateAttempt = (req, res, next) => {
  const { subProfileId, date } = req.body || {};
  const parsed = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? new Date(`${date}T00:00:00Z`) : null;
  if (!mongoose.isObjectIdOrHexString(subProfileId) || !parsed ||
      !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    return res.status(400).json({ error: 'A valid subProfileId and YYYY-MM-DD date are required' });
  }
  next();
};

// POST /maze/start
router.post('/start', protect, validateAttempt, async (req, res) => {
  const { subProfileId, date } = req.body;
  const today = new Date().toISOString().split('T')[0];
  const now = new Date();

  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const sub = user.subProfiles.id(subProfileId);
    if (!sub) return res.status(404).json({ error: 'Sub-profile not found' });
    if (!compatible && sub.collectibleWriterVersion !== undefined) return res.status(409).json({
      error: 'This profile requires the compatible completion writer.', code: 'COMPATIBLE_WRITER_REQUIRED',
    });

    assertUserVersion(user);
    const maze = await Maze.findOne({ date });
    if (!maze) return res.status(404).json({ error: `Maze not found for ${date}` });

    // Ensure date key exists
    if (!sub.attempts.has(date)) {
      sub.attempts.set(date, []);
    }

    // Add new attempt
    const attempt = { attemptId: randomUUID(), started: now, completed: false };
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


// Frozen /start route excerpt from deployed server 8e3eac84f7081f3b1a51df317b35f782d64561db.
// Test fixture only: never mounted by app.js or index.js.
return router;
}
