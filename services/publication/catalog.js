import { isPublished, publicationFilter, publicationEra, legacyPolicy, PUBLICATION_ERA } from './policy.js';
import { monthDates, trustedInstant, fail } from './ingress.js';
import { utcDate } from '../../lib/maze/dates.js';

export const EDGE_SCAN_LIMIT = 32;
// Internal integrity checks need content bytes; only date/era/progress leave this service.
const fields = 'date seed grid width height publicationEra publishedAt provenance';
const nextBoundary = now => new Date(Date.parse(`${utcDate(now)}T00:00:00Z`) + 86400000).toISOString();

export function createCatalog({ MazeModel, legacy = legacyPolicy }) {
  const read = query => MazeModel.findOne(query).select(fields).maxTimeMS(2000).lean();
  const published = async (date, now) => {
    const maze = await read({ date });
    return isPublished(maze, now, legacy) ? maze : null;
  };
  async function scanEdge(query, now, direction, hint) {
    // Stream one indexed candidate at a time; never load/revalidate all history.
    const cursor = MazeModel.find(query).select(fields)
      .sort({ date: direction }).hint(hint).limit(EDGE_SCAN_LIMIT).maxTimeMS(2000)
      .lean().cursor({ batchSize: 1 });
    let examined = 0;
    try {
      for await (const maze of cursor) {
        examined++;
        if (isPublished(maze, now, legacy)) return maze.date;
      }
    } finally { await cursor.close(); }
    if (examined === EDGE_SCAN_LIMIT) throw fail('CATALOG_INTEGRITY_LIMIT');
    return null;
  }
  async function edge(now, direction) {
    const dateBound = { $gte: '0001-01-01', $lte: utcDate(now) };
    const modern = await scanEdge({ date: dateBound, publicationEra: PUBLICATION_ERA,
      publishedAt: { $type: 'date', $lte: now }, provenance: { $type: 'object' } }, now, direction,
    { publicationEra: 1, date: 1, publishedAt: 1 });
    const historical = legacy.dates.length ? await scanEdge({ date: { ...dateBound, $in: legacy.dates },
      publicationEra: { $exists: false }, publishedAt: { $exists: false }, provenance: { $exists: false } },
    now, direction, { date: 1 }) : null;
    return [modern, historical].filter(Boolean).sort((a, b) => direction * a.localeCompare(b))[0] ?? null;
  }
  return { published, async month(month, sampledNow, progress) {
    const now = trustedInstant(sampledNow), today = utcDate(now), dates = monthDates(month);
    const filter = publicationFilter(now, legacy);
    const rows = await MazeModel.find({ $and: [filter, { date: { $in: dates } }] })
      .select(fields).sort({ date: 1 }).hint({ date: 1 }).limit(31).maxTimeMS(2000).lean();
    const project = maze => ({ date: maze.date, publicationEra: publicationEra(maze),
      ...(progress ? { progress: { completed: progress[maze.date]?.completed === true } } : {}) });
    const items = rows.filter(maze => isPublished(maze, now, legacy)).map(project);
    // Sequential, bounded reads avoid multiplying cursor memory and database pressure.
    const firstPublishedDate = await edge(now, 1), lastPublishedDate = await edge(now, -1);
    const todayRow = await published(today, now);
    return { today, serverNow: now.toISOString(), nextDayAt: nextBoundary(now), month,
      firstPublishedDate, lastPublishedDate,
      todayMaze: todayRow ? { ...project(todayRow), available: true } : { date: today, available: false }, items };
  } };
}
