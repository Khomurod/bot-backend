const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pickStoredLoadForContext,
  isNowWithinOverallLoadSpan,
} = require('../services/recentLoadSelection');

test('pickStoredLoadForContext prefers row whose window contains now', () => {
  const now = new Date('2026-04-29T18:00:00.000Z');
  const older = {
    id: 1,
    created_at: '2026-04-28T10:00:00.000Z',
    pickup_window_start: new Date('2026-04-20T10:00:00.000Z'),
    delivery_window_end: new Date('2026-04-25T23:00:00.000Z'),
  };
  const current = {
    id: 2,
    created_at: '2026-04-29T12:00:00.000Z',
    pickup_window_start: new Date('2026-04-29T14:00:00.000Z'),
    delivery_window_end: new Date('2026-04-30T12:00:00.000Z'),
  };

  const picked = pickStoredLoadForContext([older, current], now);
  assert.equal(picked.id, current.id);
});

test('pickStoredLoadForContext falls back to newest when no window matches', () => {
  const now = new Date('2026-05-10T18:00:00.000Z');
  const a = {
    id: 1,
    created_at: '2026-04-28T10:00:00.000Z',
    pickup_window_start: null,
    delivery_window_end: null,
  };
  const b = {
    id: 2,
    created_at: '2026-04-29T12:00:00.000Z',
    pickup_window_start: null,
    delivery_window_end: null,
  };

  const picked = pickStoredLoadForContext([a, b], now);
  assert.equal(picked.id, b.id);
});

test('isNowWithinOverallLoadSpan uses pickup start through delivery end', () => {
  const row = {
    pickup_window_start: new Date('2026-04-29T10:00:00.000Z'),
    delivery_window_end: new Date('2026-04-30T10:00:00.000Z'),
  };
  assert.equal(
    isNowWithinOverallLoadSpan(row, new Date('2026-04-29T15:00:00.000Z')),
    true
  );
  assert.equal(
    isNowWithinOverallLoadSpan(row, new Date('2026-05-01T15:00:00.000Z')),
    false
  );
});
