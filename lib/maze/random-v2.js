import { createHash } from 'node:crypto';
export const rngVersion = 'sha256-xoshiro256ss-v2';
const mask = (1n << 64n) - 1n;
const rotl = (x, n) => ((x << n) | (x >> (64n - n))) & mask;
export function seededRandom(seed) {
  const digest = createHash('sha256').update('fort-custer/rng-v2\0').update(seed).digest();
  const s = Array.from({ length: 4 }, (_, i) => digest.readBigUInt64LE(i * 8));
  if (s.every(x => x === 0n)) s[0] = 1n;
  return () => {
    const result = (rotl((s[1] * 5n) & mask, 7n) * 9n) & mask;
    const t = (s[1] << 17n) & mask;
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3];
    s[2] ^= t; s[3] = rotl(s[3], 45n);
    return Number(result >> 11n) / 9007199254740992;
  };
}
