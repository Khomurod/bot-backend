'use strict';

/**
 * What ONE home-time housekeeping tick costs the database.
 *
 * October 2026: the hosted database's monthly transfer allowance was nearly
 * spent, and this tick — every five minutes, economy mode or not — was about
 * 4 MB a day of it while doing nothing at all. Each tick read the whole
 * settings row TWICE (once per sweep), the whole 46-column row of every open
 * request to judge it on five dates, and ran the alert claim as an
 * `UPDATE … RETURNING r.*`, which describes all 46 columns even when it claims
 * nothing — which is nearly always.
 *
 * The real tick runs here — the run ledger, the cleanup sweep, the staff-alert
 * sweep and the manager-notice sweep — against a fake `pg` that records every
 * statement. Only Telegram is a stand-in.
 */
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-jwt-secret';

const test = require('node:test');
const assert = require('node:assert/strict');

const DAY = 86400000;
const sent = [];
let due = false;

const clean = (q) => q.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
const textOf = (q) => clean(typeof q === 'string' ? q : q?.text || '');

const SETTINGS_ROW = {
  id: 1, enabled: true, road_allowance_weeks: 4, home_allowance_days: 4, bonus_per_week: '100.00',
  reminder_first_hours: 12, reminder_second_hours: 12, completed_notify_group_id: '-100777',
  driver_clarification_enabled: false, internal_clarification_group_id: '-1009999', updated_at: new Date(),
};

/** Open, and not outdated: a legacy `pending` card with no dates, and a recent clarification. */
const OPEN_ROWS = [
  { id: 101, status: 'pending', home_from: null, home_to: null, return_to_road_date: null, requested_at: new Date(Date.now() - 40 * DAY) },
  { id: 102, status: 'awaiting_dates', home_from: null, home_to: null, return_to_road_date: null, requested_at: new Date(Date.now() - 2 * DAY) },
];

/** What the claim hands the sender when an alert IS due. */
const CLAIMED = {
  id: 501, internal_alert_attempts: 1, driver_name: 'Pascal F', unit_number: '96266',
  telegram_group_id: '-1001234567890', root_chat_id: '-1001234567890', root_message_id: '9001',
  detected_intent: 'home_time_request', home_from: null, return_to_road_date: null,
  missing_fields: 'home_start,return_to_road', ai_reasoning: 'no calendar dates were given',
};

function respond(text) {
  if (/FROM home_time_settings/.test(text)) return { rows: [{ ...SETTINGS_ROW }], rowCount: 1 };
  if (/^SELECT 1 FROM home_time_requests/.test(text)) return { rows: due ? [{ '?column?': 1 }] : [], rowCount: due ? 1 : 0 };
  if (/^UPDATE home_time_requests r\b/.test(text)) return { rows: due ? [{ ...CLAIMED }] : [], rowCount: due ? 1 : 0 };
  if (/FROM home_time_requests WHERE status = ANY/.test(text)) {
    return { rows: OPEN_ROWS.map((r) => ({ ...r })), rowCount: OPEN_ROWS.length };
  }
  return { rows: [], rowCount: 0 };
}

class FakePool {
  on() {}
  async query(q) { sent.push(textOf(q)); return respond(textOf(q)); }
  async connect() {
    return { query: async (q) => { sent.push(textOf(q)); return respond(textOf(q)); }, release() {} };
  }
}
require.cache[require.resolve('pg')] = { exports: { Pool: FakePool } };

// eslint-disable-next-line global-require
const service = require('../services/homeTimeReminderService');

const sends = [];
const telegram = {
  async sendMessage(chatId, text) { sends.push({ chatId, text }); return { message_id: 1 }; },
  async editMessageText() { return true; },
};
// `tick` needs the client `start` hands it; the timers it starts are stopped
// at once and never fire into these tests.
service.startHomeTimeReminderService(telegram);
service.stopHomeTimeReminderService();

const WHOLE_ROW = /RETURNING \*|SELECT \*|SELECT [a-z_]+\.\*|RETURNING [a-z_]+\.\*/i;
const listOf = (clause) => clause.split(',').map((c) => c.trim().replace(/^r\./, ''));
const selectList = (s) => listOf(s.replace(/^SELECT (.+?) FROM .*$/, '$1'));

async function oneTick({ alertDue = false } = {}) {
  due = alertDue;
  sent.length = 0;
  sends.length = 0;
  await service.tick();
  return { statements: [...sent], listing: sent.map((s) => `  ${s.slice(0, 120)}`).join('\n') };
}

test('AN IDLE TICK reads no whole rows and sends no claim', async () => {
  const { statements, listing } = await oneTick();
  assert.deepEqual(statements.filter((s) => WHOLE_ROW.test(s)).map((s) => s.slice(0, 120)), [],
    `whole rows on an idle tick:\n${listing}`);
  assert.equal(statements.filter((s) => /^UPDATE home_time_requests r\b/.test(s)).length, 0,
    `nothing is due, so nothing is claimed:\n${listing}`);
  assert.equal(statements.filter((s) => /^SELECT 1 FROM home_time_requests/.test(s)).length, 1,
    `one cheap look instead:\n${listing}`);
  assert.equal(sends.length, 0);
});

test('the settings are read ONCE a tick, and only the two values the tick uses', async () => {
  const { statements, listing } = await oneTick();
  const reads = statements.filter((s) => /FROM home_time_settings/.test(s));
  assert.equal(reads.length, 1, `settings reads in one tick:\n${listing}`);
  assert.deepEqual(selectList(reads[0]), ['enabled', 'internal_clarification_group_id']);
});

test('each sweep uses the settings it is handed, and reads none of its own', async () => {
  sent.length = 0;
  const off = { enabled: false, internal_clarification_group_id: '-1009999' };
  assert.deepEqual(await service.runHomeTimeCleanupSweep(telegram, { settings: off }),
    { enabled: false, scanned: 0, closed: 0 });
  // eslint-disable-next-line global-require
  const { runInternalAlertSweep } = require('../services/homeTimeInternalAlert');
  assert.equal((await runInternalAlertSweep(telegram, { settings: off })).reason, 'tracking_disabled');
  assert.deepEqual(sent, [], 'nothing read, nothing claimed');
});

test('the open requests are read as the six columns the closing rule reads', async () => {
  const { statements, listing } = await oneTick();
  const open = statements.find((s) => /FROM home_time_requests WHERE status = ANY/.test(s));
  assert.ok(open, listing);
  assert.deepEqual(selectList(open).sort(),
    ['home_from', 'home_to', 'id', 'requested_at', 'return_to_road_date', 'status']);
});

test('A DUE ALERT: the look comes first, the claim uses the SAME predicate, and the sender gets only its columns', async () => {
  const { statements, listing } = await oneTick({ alertDue: true });
  const lookAt = statements.findIndex((s) => /^SELECT 1 FROM home_time_requests/.test(s));
  const claimAt = statements.findIndex((s) => /^UPDATE home_time_requests r\b/.test(s));
  assert.ok(lookAt >= 0 && claimAt > lookAt, `look, then claim:\n${listing}`);

  const predicate = statements[lookAt].replace(/^SELECT 1 FROM home_time_requests WHERE (.+) LIMIT 1$/, '$1');
  assert.ok(statements[claimAt].includes(predicate), 'one predicate, so the look and the claim cannot disagree');

  const returned = (statements[claimAt].match(/\bRETURNING (.+)$/) || [])[1] || '';
  assert.deepEqual(listOf(returned).sort(), [
    'ai_reasoning', 'detected_intent', 'driver_name', 'home_from', 'id', 'internal_alert_attempts',
    'missing_fields', 'return_to_road_date', 'root_chat_id', 'root_message_id', 'telegram_group_id', 'unit_number',
  ]);
  // And those columns are enough: the alert is sent, to the configured chat, naming the driver.
  assert.equal(sends.length, 1);
  assert.equal(sends[0].chatId, '-1009999');
  assert.match(sends[0].text, /Pascal F — Unit 96266/);
  assert.match(sends[0].text, /Request #501/);
});
