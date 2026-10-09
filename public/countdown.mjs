const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

export function parseLaunchAt(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError('Launch date must be a timestamp.');
  const text = value.trim();
  if (!text) return null;
  const match = ISO.exec(text);
  if (!match) throw new RangeError('Launch date must include an explicit timezone.');
  const [, ys, mos, ds, hs, mins, ss = '0', , zone, , zhs = '0', zms = '0'] = match;
  const [y, mo, d, h, min, s, zh, zm] = [ys, mos, ds, hs, mins, ss, zhs, zms].map(Number);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (mo < 1 || mo > 12 || d < 1 || d > days[mo - 1] || h > 23 || min > 59 || s > 59 ||
      (zone !== 'Z' && (zh > 14 || zm > 59 || (zh === 14 && zm !== 0)))) {
    throw new RangeError('Launch date contains an invalid date, time, or UTC offset.');
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new RangeError('Invalid launch date.');
  return new Date(timestamp).toISOString();
}

export function countdownParts(launchAt, now = Date.now()) {
  const iso = parseLaunchAt(launchAt);
  if (iso === null) return null;
  if (typeof now !== 'number' || !Number.isFinite(now)) throw new TypeError('Current time must be finite.');
  const difference = Date.parse(iso) - now;
  const total = Math.floor(Math.max(0, difference) / 1000);
  return {
    days: Math.floor(total / 86400), hours: Math.floor(total / 3600) % 24,
    minutes: Math.floor(total / 60) % 60, seconds: total % 60, complete: difference <= 0
  };
}
