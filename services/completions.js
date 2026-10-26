import mongoose from 'mongoose';
import User, { assertUserVersion } from '../models/User.js';
import RewardItem from '../models/RewardItem.js';

const fail = (status, message, code) => Object.assign(new Error(message), { status, code });

// All side effects share one MongoDB document and one version-checked write.
export async function completeAttempt(userId, { subProfileId, date, attemptId }, receivedAt = new Date()) {
  if (attemptId !== undefined && (typeof attemptId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(attemptId))) {
    throw fail(400, 'Invalid attempt identifier', 'INVALID_ATTEMPT');
  }
  let selectedIndex;
  for (let retry = 0; retry < 8; retry++) {
    const user = await User.findById(userId);
    if (!user) throw fail(404, 'User not found', 'NOT_FOUND');
    const sub = user.subProfiles.id(subProfileId);
    if (!sub) throw fail(404, 'Sub-profile not found', 'NOT_FOUND');
    const attempts = sub.attempts.get(date) || [];
    // Pin legacy requests to the initial latest attempt, even across write conflicts.
    if (selectedIndex === undefined) selectedIndex = attemptId === undefined
      ? attempts.length - 1 : attempts.findIndex(a => a.attemptId === attemptId);
    const attempt = attempts[selectedIndex];
    if (!attempt || (attemptId !== undefined && attempt.attemptId !== attemptId)) {
      throw fail(400, 'Maze attempt not found for this profile and date', 'INVALID_ATTEMPT');
    }
    if (attempt.result) return attempt.result;
    if (attempt.completed) {
      // Historical reward attribution cannot safely be reconstructed.
      throw fail(409, 'This older attempt is already saved. View your results in the maze collection.', 'LEGACY_COMPLETED');
    }
    // Saved snapshots above remain readable after a compatibility drain/rollback.
    // An adopted profile must never fall back to per-attempt awards.
    if (sub.collectibleWriterVersion !== undefined) {
      throw fail(409, 'This profile requires the compatible completion writer.', 'COMPATIBLE_WRITER_REQUIRED');
    }
    // Mongoose omits its version predicate for documents without __v.
    // Never complete such imported/corrupt records with an unguarded write.
    assertUserVersion(user);
    if (!attempt.started) throw fail(400, 'Attempt has no start time', 'INVALID_ATTEMPT');
    const started = new Date(attempt.started).getTime();
    if (!Number.isFinite(started) || started > receivedAt.getTime()) throw fail(400, 'Invalid attempt start time', 'INVALID_ATTEMPT');
    if (attempt.expiresAt && receivedAt >= attempt.expiresAt) throw fail(410, 'This attempt expired. Return to mazes to start again.', 'ATTEMPT_EXPIRED');
    const duration = ((receivedAt - started) / 1000).toFixed(3);
    if (Number(duration) < 3) throw fail(400, 'Too fast — possible cheat detected', 'TOO_FAST');
    const allRewards = await RewardItem.find({});
    const available = allRewards.filter(r => !sub.rewards.has(r.id));
    const reward = available.length ? available[Math.floor(Math.random() * available.length)].toObject() : null;
    const result = { message: 'Maze complete', time: duration, reward, today: receivedAt.toISOString().slice(0, 10), ...(attempt.attemptId ? { attemptId: attempt.attemptId } : {}) };
    attempt.completed = true;
    attempt.time = Number(duration);
    attempt.result = result;
    // Preserve existing ranking behavior: the most recent completed attempt per day.
    sub.progress.set(date, { completed: true, time: duration });
    if (reward) sub.rewards.set(reward.id, (sub.rewards.get(reward.id) || 0) + 1);
    try {
      await user.save();
      return result;
    } catch (error) {
      if (!(error instanceof mongoose.Error.VersionError)) throw error;
      // Reload the winning snapshot; never reuse a stale reward or inventory map.
    }
  }
  throw fail(503, 'Profile is busy. Retry saving the same attempt.', 'RETRY_SAVE');
}
