import { canonicalConfig, generationIdentity } from '../../lib/maze/engine.js';
import { validateDate, utcDate } from '../../lib/maze/dates.js';

export const fail = code => Object.assign(new Error(code), { code });

export function plainKeys(value, allowed, code = 'INVALID_PUBLISH_INPUT') {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw fail(code);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !descriptor.enumerable
        || !Object.hasOwn(descriptor, 'value')) throw fail(code);
  }
}

// Only a server-sampled Date or integer epoch may authorize publication/admission.
export function trustedInstant(value) {
  if (!(value instanceof Date) && !Number.isSafeInteger(value)) throw fail('INVALID_TRUSTED_INSTANT');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw fail('INVALID_TRUSTED_INSTANT');
  utcDate(date);
  return date;
}

// Offline operator parsing only: contemporary civil offsets -12:00 through +14:00.
// Unknown local offset -00:00 is refused. This never supplies an API's trusted clock.
export function parseCivilInstant(value) {
  if (typeof value !== 'string') throw fail('INVALID_CIVIL_INSTANT');
  const match = /(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match || match[1] === '-00:00') throw fail('INVALID_CIVIL_INSTANT');
  if (match[1] !== 'Z') {
    const minutes = +match[3] * 60 + +match[4];
    if (+match[4] > 59 || minutes % 15 !== 0 || minutes > (match[2] === '+' ? 840 : 720)) throw fail('INVALID_CIVIL_INSTANT');
  }
  try { utcDate(value); } catch { throw fail('INVALID_CIVIL_INSTANT'); }
  return new Date(value);
}

export function publisherInput(input, now) {
  plainKeys(input, ['date', 'version', 'seed', 'config']);
  validateDate(input.date);
  if (input.date > utcDate(trustedInstant(now))) throw fail('FUTURE_PUBLICATION_REFUSED');
  const config = Object.hasOwn(input, 'config') ? input.config : {};
  plainKeys(config, ['width', 'height', 'minDistance', 'endpointAttempts', 'fireAttempts', 'maxAttempts', 'maxStates', 'tileRules'], 'INVALID_CONFIG');
  if (Object.hasOwn(input, 'seed') && (typeof input.seed !== 'string' || !input.seed.length)) throw fail('INVALID_SEED');
  if (Object.hasOwn(input, 'version') && typeof input.version !== 'string') throw fail('UNSUPPORTED_ALGORITHM_VERSION');
  const canonical = canonicalConfig(config);
  const identity = generationIdentity({ ...input, config: canonical });
  return { date: identity.date, version: identity.algorithmVersion, seed: identity.seed, config: canonical };
}

export function monthDates(month) {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) throw fail('INVALID_MONTH');
  try { validateDate(`${month}-01`); } catch { throw fail('INVALID_MONTH'); }
  const dates = [];
  for (let day = 1; day <= 31; day++) {
    const date = `${month}-${String(day).padStart(2, '0')}`;
    try { validateDate(date); dates.push(date); } catch { break; }
  }
  return dates;
}
