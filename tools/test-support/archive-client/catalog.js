import { isDate, isMonth } from './dates.js';

export function validateCatalog(data, requestedMonth) {
  const fail = () => { throw new Error('INVALID_CATALOG'); };
  if (!data || !isDate(data.today) || !isMonth(data.month)
      || (requestedMonth && data.month !== requestedMonth)
      || !Number.isFinite(Date.parse(data.serverNow))
      || new Date(data.serverNow).toISOString().slice(0, 10) !== data.today
      || Date.parse(data.nextDayAt) !== Date.parse(`${data.today}T00:00:00Z`) + 86400000
      || data.todayMaze?.date !== data.today || typeof data.todayMaze.available !== 'boolean'
      || !Array.isArray(data.items) || data.items.length > 31) fail();
  const itemValid = item => isDate(item?.date) && item.date <= data.today
    && ['legacy', 'year-round-v1'].includes(item.publicationEra)
    && (item.progress === undefined || typeof item.progress?.completed === 'boolean');
  if (data.items.some((item, i) => !itemValid(item) || !item.date.startsWith(`${data.month}-`)
      || (i > 0 && data.items[i - 1].date >= item.date))) fail();
  if (data.todayMaze.available && !itemValid(data.todayMaze)) fail();
  const first = data.firstPublishedDate, last = data.lastPublishedDate;
  if ((first === null) !== (last === null)
      || (first !== null && (!isDate(first) || !isDate(last) || first > last || last > data.today))
      || (first === null && (data.items.length || data.todayMaze.available))
      || data.items.some(item => item.date < first || item.date > last)) fail();
  return data;
}
export function catalogProblem(error) {
  const status = error?.response?.status, code = error?.response?.data?.code;
  if (status === 401 || status === 403) return { kind: 'auth', message: 'Sign in again to load your completion status.' };
  if (code === 'PROFILE_NOT_FOUND' || code === 'INVALID_PROFILE_ID') {
    return { kind: 'profile', message: 'Choose an available profile to continue.' };
  }
  return { kind: 'unavailable', message: 'Archive temporarily unavailable. Published dates could not be loaded. Please retry.' };
}
export function catalogFresh(result) {
  if (!result || result.status !== 'ready') return false;
  const elapsed = performance.now() - result.startedAt;
  return elapsed >= 0 && elapsed < 60000
    && elapsed < Date.parse(result.data.nextDayAt) - Date.parse(result.data.serverNow);
}
