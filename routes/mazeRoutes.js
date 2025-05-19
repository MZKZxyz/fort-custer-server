import express from 'express';
import User from '../models/User.js';
import Maze from '../models/Maze.js'; // make sure this is imported
import RewardItem from '../models/RewardItem.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

// POST /maze/start
router.post('/start', protect, async (req, res) => {
  const { subProfileId, date } = req.body;
  const today = new Date().toISOString().split('T')[0];
  const now = new Date();

  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const sub = user.subProfiles.id(subProfileId);
    if (!sub) return res.status(404).json({ error: 'Sub-profile not found' });

    const maze = await Maze.findOne({ date });
    if (!maze) return res.status(404).json({ error: `Maze not found for ${date}` });

    // Ensure date key exists
    if (!sub.attempts.has(date)) {
      sub.attempts.set(date, []);
    }

    // Add new attempt
    const attempt = { started: now, completed: false };
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
      attemptIndex: sub.attempts.get(date).length - 1, // optional
    });
  } catch (err) {
    console.error('Maze start error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});


// POST /maze/complete
router.post('/complete', protect, async (req, res) => {
  const { subProfileId, date } = req.body;

  const safeDate = new Date(date).toISOString().slice(0, 10);
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  try {
    const user = await User.findById(req.user.id);
    const sub = user.subProfiles.id(subProfileId);
    if (!sub) return res.status(404).json({ error: 'Sub-profile not found' });

    const attempts = sub.attempts.get(safeDate);
    if (!attempts || !attempts.length) {
      return res.status(400).json({ error: 'No maze attempt found for this date' });
    }

    const latest = attempts[attempts.length - 1];
    if (!latest.started) {
      return res.status(400).json({ error: 'Attempt has no start time' });
    }

    const duration = ((now - new Date(latest.started)) / 1000).toFixed(3);
    if (duration < 3) {
      return res.status(400).json({ error: 'Too fast — possible cheat detected' });
    }

    latest.completed = true;
    latest.time = duration;
    sub.progress.set(safeDate, { completed: true, time: duration });

    // Determine available rewards
    const allRewards = await RewardItem.find({});
    const available = allRewards.filter(r => !sub.rewards.has(r.id));
    const reward = available.length > 0
      ? available[Math.floor(Math.random() * available.length)]
      : null;

    if (reward) {
      const prevQty = sub.rewards.get(reward.id) || 0;
      sub.rewards.set(reward.id, prevQty + 1);
    }

    await user.save();

    res.status(200).json({
      message: 'Maze complete',
      time: duration,
      reward,
      today,
    });
  } catch (err) {
    console.error('Maze completion error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /maze/rewards?subProfileId=abc123
router.get('/rewards', protect, async (req, res) => {
  const { subProfileId } = req.query;

  try {
    const user = await User.findById(req.user.id);
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

export default router;
