/**
 * Pure request-parsing helpers for the Home-Time admin API
 * (server/routes/homeTimeRouteHelpers). The settings validator matters most:
 * it is the only thing standing between the admin panel and the settings row,
 * including the two switches that decide whether the bot talks to drivers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseDateOnly, normalizeNotifyGroupId, buildSettingsPatch,
} = require('../server/routes/homeTimeRouteHelpers');

// ── existing helpers ──

test('parseDateOnly accepts only a calendar date', () => {
  assert.equal(parseDateOnly('2026-08-02'), '2026-08-02');
  assert.equal(parseDateOnly('2026-08-02T10:00:00Z'), null);
  assert.equal(parseDateOnly('nonsense'), null);
  assert.equal(parseDateOnly(''), null);
  assert.equal(parseDateOnly(null), null);
});

test('normalizeNotifyGroupId accepts chat ids, clears on empty, rejects junk', () => {
  assert.equal(normalizeNotifyGroupId('-1001234567890'), '-1001234567890');
  assert.equal(normalizeNotifyGroupId('  -1001234567890  '), '-1001234567890');
  assert.equal(normalizeNotifyGroupId('123'), '123');
  assert.equal(normalizeNotifyGroupId(''), '');
  assert.equal(normalizeNotifyGroupId(null), '');
  assert.equal(normalizeNotifyGroupId('@somegroup'), null);
  assert.equal(normalizeNotifyGroupId('-100abc'), null);
});

// ── settings patch: only what was sent ──

test('an empty body produces an empty patch (a partial save clobbers nothing)', () => {
  const { patch, error } = buildSettingsPatch({});
  assert.equal(error, undefined);
  assert.deepEqual(patch, {});
});

test('absent keys are never written', () => {
  const { patch } = buildSettingsPatch({ enabled: true });
  assert.deepEqual(Object.keys(patch), ['enabled']);
});

// ── the two new controls ──

test('driver_clarification_enabled is coerced to a boolean', () => {
  assert.equal(buildSettingsPatch({ driver_clarification_enabled: true }).patch.driver_clarification_enabled, true);
  assert.equal(buildSettingsPatch({ driver_clarification_enabled: false }).patch.driver_clarification_enabled, false);
  assert.equal(buildSettingsPatch({ driver_clarification_enabled: 0 }).patch.driver_clarification_enabled, false);
});

test('driver_clarification_enabled is independent of the overall tracking switch', () => {
  const { patch } = buildSettingsPatch({ enabled: true, driver_clarification_enabled: false });
  assert.equal(patch.enabled, true);
  assert.equal(patch.driver_clarification_enabled, false);
});

test('internal_clarification_group_id accepts a Telegram chat id', () => {
  const { patch } = buildSettingsPatch({ internal_clarification_group_id: '-1009999' });
  assert.equal(patch.internal_clarification_group_id, '-1009999');
});

test('internal_clarification_group_id can be cleared with an empty string', () => {
  const { patch } = buildSettingsPatch({ internal_clarification_group_id: '' });
  assert.equal(patch.internal_clarification_group_id, null);
});

test('an invalid internal_clarification_group_id is rejected, not silently stored', () => {
  const { patch, error } = buildSettingsPatch({ internal_clarification_group_id: '@staffgroup' });
  assert.equal(patch, undefined);
  assert.match(error, /internal_clarification_group_id must be a numeric Telegram chat id/);
});

test('an invalid completed_notify_group_id is still rejected', () => {
  const { error } = buildSettingsPatch({ completed_notify_group_id: 'not-a-chat' });
  assert.match(error, /completed_notify_group_id must be a numeric Telegram chat id/);
});

// ── numeric bounds (unchanged behaviour) ──

test('numeric ranges are enforced with their exact messages', () => {
  const cases = [
    [{ road_allowance_weeks: 0 }, /road_allowance_weeks must be 1-52/],
    [{ road_allowance_weeks: 53 }, /road_allowance_weeks must be 1-52/],
    [{ home_allowance_days: 0 }, /home_allowance_days must be 1-60/],
    [{ home_allowance_days: 61 }, /home_allowance_days must be 1-60/],
    [{ reminder_first_hours: 0 }, /reminder_first_hours must be 1-168 hours/],
    [{ reminder_second_hours: 169 }, /reminder_second_hours must be 1-168 hours/],
    [{ bonus_per_week: -1 }, /bonus_per_week must be 0 or more/],
  ];
  for (const [body, expected] of cases) {
    const { error } = buildSettingsPatch(body);
    assert.match(error || '', expected, JSON.stringify(body));
  }
});

test('valid numeric values are parsed and kept', () => {
  const { patch, error } = buildSettingsPatch({
    road_allowance_weeks: '4', home_allowance_days: '4',
    reminder_first_hours: '12', reminder_second_hours: '24', bonus_per_week: '100',
  });
  assert.equal(error, undefined);
  assert.deepEqual(patch, {
    road_allowance_weeks: 4,
    home_allowance_days: 4,
    reminder_first_hours: 12,
    reminder_second_hours: 24,
    bonus_per_week: 100,
  });
});

test('the first invalid field wins and nothing is written', () => {
  const { patch, error } = buildSettingsPatch({
    enabled: true, road_allowance_weeks: 99, internal_clarification_group_id: '@bad',
  });
  assert.equal(patch, undefined);
  assert.match(error, /road_allowance_weeks/);
});

test('a full valid save carries both new controls through', () => {
  const { patch, error } = buildSettingsPatch({
    enabled: true,
    driver_clarification_enabled: false,
    internal_clarification_group_id: '-1008888',
    completed_notify_group_id: '-1009999',
    road_allowance_weeks: 4,
  });
  assert.equal(error, undefined);
  assert.deepEqual(patch, {
    enabled: true,
    driver_clarification_enabled: false,
    road_allowance_weeks: 4,
    completed_notify_group_id: '-1009999',
    internal_clarification_group_id: '-1008888',
  });
});
