import { isPublished, legacyPolicy } from './policy.js';
import { fail, trustedInstant } from './ingress.js';
import { utcDate, validateDate } from '../../lib/maze/dates.js';

// Finite work, never a partial top-25. Growing beyond these limits needs a
// reviewed ranking read model; do not silently truncate the player/date set.
export const RANKING_LIMITS = Object.freeze({ users: 1000, profiles: 1000,
  entriesPerProfile: 4096, totalEntries: 16384, dates: 4096, batch: 32, workMs: 5000 });
const fields = 'date seed grid width height publicationEra publishedAt provenance';

export function utcWeek(value) {
  validateDate(value);
  const start = new Date(`${value}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  return Array.from({ length: 7 }, (_, day) => {
    const date = new Date(start.getTime() + day * 86400000).toISOString().slice(0, 10);
    return validateDate(date);
  });
}

export async function verifiedRankings({ UserModel, MazeModel, now, dates, daily = false, policy = legacyPolicy }) {
  const sampled = trustedInstant(now), today = utcDate(sampled), started = performance.now();
  const budget = () => {
    const left = RANKING_LIMITS.workMs - (performance.now() - started);
    if (left < 1) throw fail('RANKING_WORK_LIMIT');
    return Math.max(1, Math.floor(Math.min(2000, left)));
  };
  const verified = new Set();
  const verifyDates = async sorted => {
    for (let i = 0; i < sorted.length; i += RANKING_LIMITS.batch) {
      const batch = sorted.slice(i, i + RANKING_LIMITS.batch);
      const mazes = await MazeModel.find({ date: { $in: batch } }).select(fields).hint({ date: 1 })
        .limit(batch.length).maxTimeMS(budget()).lean();
      for (const maze of mazes) { budget(); if (isPublished(maze, sampled, policy)) verified.add(maze.date); }
    }
  };
  if (dates) {
    await verifyDates(dates.filter(date => date <= today));
    if (!verified.size) return [];
  }
  const entries = { $objectToArray: { $ifNull: ['$subProfiles.progress', {}] } };
  const dateConditions = [{ $eq: ['$$entry.v.completed', true] }, { $lte: ['$$entry.k', today] },
    ...(dates ? [{ $in: ['$$entry.k', [...verified]] }] : [])];
  // Cap input documents before unwind, and profiles before progress projection.
  // facet retains sentinel counts even when users/profiles have no completions.
  // Project only public identity and bounded date/time scalars, never attempts,
  // receipts, passwords, rewards, emails, or entire User/Maze documents.
  const [page] = await UserModel.aggregate([
    { $limit: RANKING_LIMITS.users + 1 },
    { $facet: {
      users: [{ $count: 'count' }],
      profiles: [
        { $unwind: '$subProfiles' }, { $limit: RANKING_LIMITS.profiles + 1 },
        { $project: { _id: 0, name: '$subProfiles.name', subProfileId: '$subProfiles._id',
          progress: { $map: { input: { $slice: [{ $filter: { input: entries, as: 'entry', cond: { $and: dateConditions } } },
            RANKING_LIMITS.entriesPerProfile + 1] }, as: 'entry', in: { date: '$$entry.k',
            time: { $cond: [{ $in: [{ $type: '$$entry.v.time' }, ['string', 'double', 'int', 'long']] },
              { $let: { vars: { value: { $convert: { input: '$$entry.v.time', to: 'string', onError: '', onNull: '' } } },
                in: { $cond: [{ $lte: [{ $strLenBytes: '$$value' }, 32] }, '$$value', ''] } } }, ''] } } } },
        } },
      ],
    } },
  ]).option({ maxTimeMS: budget(), allowDiskUse: false });
  budget();
  if (!page || (page.users[0]?.count ?? 0) > RANKING_LIMITS.users || page.profiles.length > RANKING_LIMITS.profiles) throw fail('RANKING_WORK_LIMIT');
  const candidates = new Set(), profiles = [];
  let examined = 0;
  for (const profile of page.profiles) {
    if (profile.progress.length > RANKING_LIMITS.entriesPerProfile) throw fail('RANKING_WORK_LIMIT');
    const progress = [];
    for (const entry of profile.progress) {
      if (++examined > RANKING_LIMITS.totalEntries) throw fail('RANKING_WORK_LIMIT');
      try { validateDate(entry.date); } catch { continue; }
      // Original completion times are finite positive seconds. Never accept
      // parseFloat prefixes, coerced objects, infinities or nonnumeric data.
      if (!/^\d{1,12}(?:\.\d{1,9})?$/.test(entry.time)) continue;
      const time = Number(entry.time);
      if (!Number.isFinite(time) || time <= 0) continue;
      candidates.add(entry.date); progress.push({ date: entry.date, time });
      if (candidates.size > RANKING_LIMITS.dates) throw fail('RANKING_WORK_LIMIT');
    }
    profiles.push({ name: profile.name, subProfileId: profile.subProfileId, progress });
  }
  if (!dates) await verifyDates([...candidates].sort());
  budget();
  const scores = [];
  for (const profile of profiles) {
    const eligible = profile.progress.filter(entry => verified.has(entry.date));
    if (!eligible.length) continue;
    const time = daily ? Math.min(...eligible.map(entry => entry.time)) : eligible.reduce((sum, entry) => sum + entry.time, 0);
    scores.push({ name: profile.name, subProfileId: profile.subProfileId, time: time.toFixed(3), completedMazes: eligible.length });
  }
  return scores.sort((a, b) => Number(a.time) - Number(b.time)).slice(0, 25);
}
