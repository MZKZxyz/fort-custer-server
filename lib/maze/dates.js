const DAY_MS = 86400000;
export const MAX_RANGE_DAYS = 366;

export function validateDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000-')) {
    throw new Error('INVALID_DATE');
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error('INVALID_DATE');
  }
  return date;
}

// Require an explicit instant: no local timezone or ambient clock is consulted.
export function utcDate(instant) {
  if (typeof instant === 'string') {
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(instant);
    if (!match || +match[2] > 23 || +match[3] > 59 || +match[4] > 59
        || +(match[6] ?? 0) > 23 || +(match[7] ?? 0) > 59) throw new Error('INVALID_INSTANT');
    validateDate(match[1]);
  } else if (!(instant instanceof Date) && !Number.isSafeInteger(instant)) {
    throw new Error('INVALID_INSTANT');
  }
  const parsed = new Date(instant);
  if (!Number.isFinite(parsed.getTime())) throw new Error('INVALID_INSTANT');
  return validateDate(parsed.toISOString().slice(0, 10));
}

export function inclusiveDates(start, end) {
  validateDate(start); validateDate(end);
  const first = Date.parse(`${start}T00:00:00Z`), last = Date.parse(`${end}T00:00:00Z`);
  const count = (last - first) / DAY_MS + 1;
  if (count < 1 || count > MAX_RANGE_DAYS) throw new Error('INVALID_DATE_RANGE');
  return Array.from({ length: count }, (_, i) => new Date(first + i * DAY_MS).toISOString().slice(0, 10));
}

// A future publisher admission policy only; this says nothing about record existence.
export function isDateAdmitted(date, instant) {
  return validateDate(date) <= utcDate(instant);
}
