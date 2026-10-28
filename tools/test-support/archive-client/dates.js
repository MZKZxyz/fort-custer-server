// Civil date identities are UTC strings, never local Date arithmetic.
export function isDate(value) {
  return typeof value === 'string' && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
export const isMonth = value => typeof value === 'string'
  && /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value);
export function monthDates(month) {
  if (!isMonth(month)) return [];
  const end = new Date(`${month}-01T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  return Array.from({ length: end.getUTCDate() }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}
export function shiftMonth(month, delta) {
  if (!isMonth(month)) return null;
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + delta);
  const result = date.toISOString().slice(0, 7);
  return isMonth(result) ? result : null;
}
export const dateLabel = value => isDate(value)
  ? new Date(`${value}T00:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  }) : 'No date selected';
export const monthLabel = value => isMonth(value)
  ? new Date(`${value}-01T00:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', timeZone: 'UTC',
  }) : '';
