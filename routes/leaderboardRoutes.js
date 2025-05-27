import express from 'express';
import User from '../models/User.js';
const router = express.Router();

// helpers
const MEMORIAL_DAY = '2025-05-26';
const LABOR_DAY    = '2025-09-01';

const isWithinSummer = (dateStr) =>
  dateStr >= MEMORIAL_DAY && dateStr <= LABOR_DAY;

const getWeekRange = (startStr) => {
  const start = new Date(startStr);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
};

router.get('/:timeframe', async (req, res) => {
  const { timeframe } = req.params;
  const { date, start } = req.query;
  let targetDates = [];

  // Determine targetDates based on timeframe
  if (timeframe === 'daily') {
    const target = date || new Date().toISOString().slice(0, 10);
    if (!isWithinSummer(target)) {
      return res.status(400).json({ error: 'Date out of seasonal range' });
    }
    targetDates = [target];
  }

  if (timeframe === 'weekly') {
    // normalize to Sunday
    const raw = start || new Date().toISOString().slice(0, 10);
    const dt  = new Date(raw);
    dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay());
    let weekStart = dt.toISOString().slice(0, 10);

    // clamp
    if (weekStart < MEMORIAL_DAY) weekStart = MEMORIAL_DAY;
    if (weekStart > LABOR_DAY)    weekStart = LABOR_DAY;

    targetDates = getWeekRange(weekStart);
  }

  try {
    const users     = await User.find();
    const scoresMap = {};

    users.forEach((user) => {
      user.subProfiles.forEach((profile) => {
        let totalTime      = 0;
        let bestTime       = Infinity;
        let completedMazes = 0;

        // Aggregate progress
        for (const [dateKey, data] of profile.progress.entries()) {
          if (!data.completed || !data.time) continue;
          if (timeframe !== 'alltime' && !targetDates.includes(dateKey)) continue;

          completedMazes++;
          const t = parseFloat(data.time);
          if (timeframe === 'daily') {
            if (t < bestTime) bestTime = t;
          } else {
            totalTime += t;
          }
        }

        const finalTime = timeframe === 'daily' ? bestTime : totalTime;
        const valid     =
          (timeframe === 'daily' && bestTime < Infinity) ||
          (timeframe !== 'daily' && totalTime > 0);

        if (valid) {
          scoresMap[profile._id] = {
            name:           profile.name,
            subProfileId:   profile._id,
            time:           finalTime.toFixed(3),
            completedMazes,                // New field
          };
        }
      });
    });

    // Convert to array, default sort by time ascending (client can re-sort)
    const scores = Object.values(scoresMap)
      .sort((a, b) => parseFloat(a.time) - parseFloat(b.time))
      .slice(0, 25);

    res.json(scores);
  } catch (err) {
    console.error('Leaderboard fetch failed:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
