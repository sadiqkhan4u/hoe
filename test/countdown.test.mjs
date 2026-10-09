import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLaunchAt, countdownParts } from '../dist/public/countdown.mjs';

test('unset launch date has no countdown', () => {
  for (const value of [undefined, null, '', '   ']) {
    assert.equal(parseLaunchAt(value), null);
    assert.equal(countdownParts(value, 0), null);
  }
});
test('explicit offsets normalize correctly including the chosen Christmas launch', () => {
  assert.equal(parseLaunchAt('2026-12-25T00:00:00-08:00'), '2026-12-25T08:00:00.000Z');
  assert.equal(parseLaunchAt('2028-02-29T12:30+05:30'), '2028-02-29T07:00:00.000Z');
});
test('invalid calendars, missing timezone and invalid offsets are rejected', () => {
  for (const value of [
    '2027-02-29T12:00:00Z', '2028-02-30T12:00:00Z', '2028-13-01T12:00:00Z',
    '2028-01-00T12:00:00Z', '2028-01-01T24:00:00Z', '2028-01-01T12:60:00Z',
    '2028-01-01T12:00:60Z', '2028-01-01T12:00:00', '2028-01-01T12:00:00+14:01',
    '2028-01-01T12:00:00+05:60', 'tomorrow'
  ]) assert.throws(() => parseLaunchAt(value), RangeError);
});
test('countdown returns exact days, hours, minutes and seconds', () => {
  const now = Date.parse('2028-01-01T00:00:00Z');
  assert.deepEqual(countdownParts('2028-01-03T03:04:05Z', now),
    { days: 2, hours: 3, minutes: 4, seconds: 5, complete: false });
});
test('expired deadlines clamp to zero without declaring the app live', () => {
  const deadline = '2028-01-01T00:00:00Z';
  const now = Date.parse(deadline);
  for (const clock of [now, now + 1000]) {
    assert.deepEqual(countdownParts(deadline, clock),
      { days: 0, hours: 0, minutes: 0, seconds: 0, complete: true });
  }
  assert.equal(countdownParts(deadline, now - 500).complete, false);
  assert.throws(() => countdownParts(deadline, NaN), TypeError);
});
