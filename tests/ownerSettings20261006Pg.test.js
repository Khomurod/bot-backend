'use strict';

/**
 * The owner's 2026-10-06 decisions, against the real schema: driver messages
 * recorded (and the switch that turns it off), recruiting hours Monday–Friday
 * 07:00–17:00 Central with Wenze's own replies still off, and finance
 * documents read by AI.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { evaluateHours } = require('../lib/recruiting/workingHours');

const ALL_MIGRATIONS = allMigrationsSql();

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  return h;
}

test('driver message capture is ON by the owner\'s decision, and can be switched off', { skip: skipWithoutPg() }, async (t) => {
  const h = await setup(t);
  const { chatCaptureSettings: store, chatLogs } = h.loadDataLayer(['chatCaptureSettings', 'chatLogs']);
  assert.equal((await store.getChatCaptureSettings()).enabled, true);

  const off = await store.setChatCaptureEnabled(false, { updatedBy: 'admin' });
  assert.equal(off.enabled, false);
  assert.equal((await store.getChatCaptureSettings()).enabled, false, 'the cache was invalidated');

  await h.query(
    `INSERT INTO groups (id, telegram_group_id, group_name, group_type, active)
     VALUES (7, -9007, 'WENZE UNIT # 310 TEST DRIVER', 'driver', TRUE)`
  );
  await chatLogs.logChatMessage(7, 501, 'Test Driver', 'hello', 9);
  const row = await h.query('SELECT group_id, message_text FROM chat_logs');
  assert.deepEqual(row.rows, [{ group_id: 7, message_text: 'hello' }]);
});

test('recruiting hours are Mon–Fri 07:00–17:00 Central, and Wenze does not converse', { skip: skipWithoutPg() }, async (t) => {
  const h = await setup(t);
  const res = await h.query(
    'SELECT timezone, windows, ai_after_hours_enabled, updated_by FROM recruiting_hours_settings WHERE id = 1'
  );
  const s = res.rows[0];
  assert.equal(s.timezone, 'America/Chicago');
  assert.equal(s.ai_after_hours_enabled, false);
  assert.match(s.updated_by, /owner decision 2026-10-06/);
  // Tuesday 10:00 Central is open; Tuesday 18:00 and Saturday 10:00 are not.
  const at = (iso) => evaluateHours({ timezone: s.timezone, windows: s.windows }, iso).open;
  assert.equal(at('2026-10-06T15:00:00Z'), true);
  assert.equal(at('2026-10-06T23:00:00Z'), false);
  assert.equal(at('2026-10-10T15:00:00Z'), false);
  assert.equal(at('2026-10-06T11:30:00Z'), false, '06:30 Central is before opening');
  assert.equal(at('2026-10-06T12:30:00Z'), true, '07:30 Central is open');
});

test('finance documents may be read by AI', { skip: skipWithoutPg() }, async (t) => {
  const h = await setup(t);
  const res = await h.query('SELECT ai_reading_enabled FROM finance_settings WHERE id = 1');
  assert.equal(res.rows[0].ai_reading_enabled, true);
});

test('re-applying every migration changes nothing', { skip: skipWithoutPg() }, async (t) => {
  const h = await setup(t);
  await h.query(ALL_MIGRATIONS);
  const n = await h.query('SELECT COUNT(*)::int AS n FROM driver_chat_capture_settings');
  assert.equal(n.rows[0].n, 1);
});
