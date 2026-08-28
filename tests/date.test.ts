import assert from 'node:assert/strict';
import test from 'node:test';
import { combineDateTime } from '../src/lib/date';

test('UNC dates use standard time in January', () => {
  assert.equal(combineDateTime('2026-01-16', '11:59 PM'), '2026-01-16T23:59:00-05:00');
});

test('UNC dates use daylight time in August', () => {
  assert.equal(combineDateTime('2026-08-28', '11:59 PM'), '2026-08-28T23:59:00-04:00');
});

test('invalid calendar dates and DST gap times are rejected', () => {
  assert.throws(() => combineDateTime('2026-02-30', '5 PM'), /Invalid calendar date/);
  assert.throws(() => combineDateTime('2026-03-08', '2:30 AM'), /Local time does not exist/);
});
