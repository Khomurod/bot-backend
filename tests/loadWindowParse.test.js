const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseFlexibleLocalDateTime,
  inferWindowsFromAiDateTimeStrings,
} = require('../services/loadWindowParse');

test('parseFlexibleLocalDateTime parses MM/dd/yyyy HH:mm in Chicago zone', () => {
  const d = parseFlexibleLocalDateTime('04/29/2026 15:00');
  assert.ok(d instanceof Date);
  assert.ok(!Number.isNaN(d.getTime()));
});

test('inferWindowsFromAiDateTimeStrings fills end when single instant', () => {
  const w = inferWindowsFromAiDateTimeStrings('04/29/2026 15:00', '04/30/2026 08:00');
  assert.ok(w.pickup_window_start);
  assert.ok(w.pickup_window_end);
  assert.ok(w.delivery_window_start);
  assert.ok(w.delivery_window_end);
});
