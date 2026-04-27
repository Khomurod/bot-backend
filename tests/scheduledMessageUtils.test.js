const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');

const {
  normalizeMediaItems,
  computeNextWeeklyOccurrence,
  describeWeeklySchedule,
} = require('../services/scheduledMessageUtils');

test('normalizeMediaItems accepts type or media_type and flattens nested arrays', () => {
  const normalized = normalizeMediaItems([
    { file_id: 'photo-1', type: 'photo' },
    [{ file_id: 'video-1', media_type: 'video' }],
    null,
    { nope: true },
    { file_id: 'bad-1', media_type: 'document' },
  ]);

  assert.deepEqual(normalized, [
    { file_id: 'photo-1', media_type: 'photo' },
    { file_id: 'video-1', media_type: 'video' },
  ]);
});

test('computeNextWeeklyOccurrence rolls to the next week after the scheduled time passes', () => {
  const now = DateTime.fromISO('2026-04-27T09:30:00', { zone: 'America/Chicago' });
  const next = computeNextWeeklyOccurrence({
    dayOfWeek: 1,
    timeOfDay: '09:00',
    timezone: 'America/Chicago',
    now,
  });

  assert.equal(next.toISO(), '2026-05-04T09:00:00.000-05:00');
});

test('describeWeeklySchedule formats weekday and Central time clearly', () => {
  assert.equal(
    describeWeeklySchedule(1, '09:00', 'America/Chicago'),
    'Every Monday at 9:00 AM America/Chicago'
  );
});
