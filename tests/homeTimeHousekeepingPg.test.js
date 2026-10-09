'use strict';

/**
 * The home-time housekeeping tick's narrowed statements, against a real
 * PostgreSQL.
 *
 * Every five minutes the tick reads the settings, the open requests, and
 * whether a staff alert is due. Each of those now asks for the columns its
 * reader uses and nothing more, and the alert claim looks first with a
 * one-column query under the SAME predicate. What has to be proved against the
 * real database is that nothing a reader needed went missing — the narrow
 * claim renders the same alert as the whole row — and that the look and the
 * claim cannot disagree about what is due, `nowIso` and leases included.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { purgeDataLayer, POOL_PATH } = require('./helpers/purgeDataLayer');

const ALL_MIGRATIONS = allMigrationsSql();
const opts = { skip: skipWithoutPg() };
const NOW_ISO = '2026-10-09T15:00:00.000Z';
const SERVICES = ['../services/homeTimeReminderService', '../services/homeTimeInternalAlert', '../services/homeTimeApproval'];
const SENDER_COLUMNS = [
  'ai_reasoning', 'detected_intent', 'driver_name', 'home_from', 'id', 'internal_alert_attempts',
  'missing_fields', 'return_to_road_date', 'root_chat_id', 'root_message_id', 'telegram_group_id', 'unit_number',
];

/** A throwaway database with the REAL services bound to it — the tick lives in services/. */
async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const prior = require.cache[POOL_PATH];
  require.cache[POOL_PATH] = {
    id: POOL_PATH,
    filename: POOL_PATH,
    loaded: true,
    exports: { pool: h.pool, query: (text, values) => h.pool.query(text, values), ping: async () => true },
  };
  const reload = purgeDataLayer(SERVICES.map((s) => require.resolve(s)));
  t.after(() => {
    for (const p of reload) delete require.cache[p];
    if (prior) require.cache[POOL_PATH] = prior; else delete require.cache[POOL_PATH];
  });
  const group = await h.query(
    `INSERT INTO groups (telegram_group_id, group_name, group_type)
     VALUES (-1001234567890, 'WENZE UNIT # 96266', 'driver') RETURNING id`
  );
  /* eslint-disable global-require */
  return {
    h,
    groupId: group.rows[0].id,
    ht: require('../database/homeTime'),
    expiry: require('../database/homeTimeExpiry'),
    outbox: require('../database/homeTimeInternalAlertOutbox'),
    reminders: require('../services/homeTimeReminderService'),
    alerts: require('../services/homeTimeInternalAlert'),
  };
  /* eslint-enable global-require */
}

async function seedRequest(h, groupId, fields) {
  const cols = Object.keys(fields);
  const res = await h.query(
    `INSERT INTO home_time_requests (group_id, ${cols.join(', ')})
     VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
    [groupId, ...Object.values(fields)]
  );
  return res.rows[0].id;
}

/** A request whose staff alert is waiting to be sent. */
async function seedAlert(s, { nowIso = null } = {}) {
  const id = await seedRequest(s.h, s.groupId, {
    status: 'awaiting_dates', driver_name: 'Pascal F', unit_number: '96266',
    telegram_group_id: '-1001234567890', root_chat_id: '-1001234567890', root_message_id: '9001',
    detected_intent: 'home_time_request', missing_fields: 'return_to_road', home_from: '2026-10-20',
    ai_reasoning: 'Driver asked for home time from the 20th but gave no return date.',
  });
  await s.outbox.enqueueInternalAlert(id, { nowIso });
  return id;
}

test('the tick reads the two settings it uses, from the row the admin saves', opts, async (t) => {
  const { ht } = await setup(t);
  await ht.updateHomeTimeSettings({ enabled: true, internal_clarification_group_id: '-1009999' });
  assert.deepEqual(await ht.getHomeTimeSweepSettings(), { enabled: true, internal_clarification_group_id: '-1009999' });
  await ht.updateHomeTimeSettings({ enabled: false });
  assert.deepEqual(await ht.getHomeTimeSweepSettings(), { enabled: false, internal_clarification_group_id: '-1009999' });
});

test('open requests come back as the six columns the closing rule reads, open ones only, oldest first', opts, async (t) => {
  const s = await setup(t);
  const legacy = await seedRequest(s.h, s.groupId, { status: 'pending', requested_at: '2026-08-30T12:00:00Z' });
  const passed = await seedRequest(s.h, s.groupId, {
    status: 'pending', requested_at: '2026-09-09T12:00:00Z',
    home_from: '2026-09-12', home_to: '2026-09-15', return_to_road_date: '2026-09-16',
  });
  const recent = await seedRequest(s.h, s.groupId, { status: 'awaiting_dates', requested_at: '2026-10-07T12:00:00Z' });
  await seedRequest(s.h, s.groupId, { status: 'recorded', requested_at: '2026-08-01T12:00:00Z' });
  await seedRequest(s.h, s.groupId, { status: 'closed', requested_at: '2026-08-02T12:00:00Z' });

  const open = await s.expiry.listOpenHomeTimeRequests();

  assert.deepEqual(open.map((r) => r.id), [legacy, passed, recent]);
  for (const row of open) {
    assert.deepEqual(Object.keys(row).sort(),
      ['home_from', 'home_to', 'id', 'requested_at', 'return_to_road_date', 'status']);
  }

  // And those six are enough: the sweep closes the passed window and nothing else.
  const out = await s.reminders.runHomeTimeCleanupSweep(null, { nowIso: NOW_ISO });
  assert.deepEqual(out, { enabled: true, scanned: 3, closed: 1 });
  const statuses = await s.h.query('SELECT id, status FROM home_time_requests WHERE id = ANY($1) ORDER BY id',
    [[legacy, passed, recent]]);
  assert.deepEqual(statuses.rows.map((r) => r.status), ['pending', 'closed', 'awaiting_dates']);
});

test('nothing due: no claim is made, and nothing about the alert changes', opts, async (t) => {
  const s = await setup(t);
  const id = await seedAlert(s, { nowIso: '2099-01-01T00:00:00Z' });
  assert.deepEqual(await s.outbox.claimDueInternalAlerts(), []);
  const row = await s.outbox.getInternalAlertRow(id);
  assert.equal(Number(row.internal_alert_attempts), 0, 'no attempt was burned');
  assert.equal(row.internal_alert_claimed_until, null, 'and no lease taken');
});

test('a claimed alert carries exactly what the sender reads — and renders the same alert as the whole row', opts, async (t) => {
  const s = await setup(t);
  const id = await seedAlert(s);

  const [claimed] = await s.outbox.claimDueInternalAlerts();

  assert.deepEqual(Object.keys(claimed).sort(), SENDER_COLUMNS);
  assert.equal(claimed.id, id);
  assert.equal(Number(claimed.internal_alert_attempts), 1, 'the attempt is counted at claim time, as before');
  const whole = (await s.h.query('SELECT * FROM home_time_requests WHERE id = $1', [id])).rows[0];
  assert.equal(s.alerts.renderAlertForRequest(claimed), s.alerts.renderAlertForRequest(whole));
});

test('the look honours nowIso exactly as the claim does, to the second', opts, async (t) => {
  const s = await setup(t);
  const id = await seedAlert(s, { nowIso: '2099-01-01T00:00:00Z' });
  assert.deepEqual(await s.outbox.claimDueInternalAlerts({ nowIso: '2098-12-31T23:59:59Z' }), []);
  const due = await s.outbox.claimDueInternalAlerts({ nowIso: '2099-01-01T00:00:00Z' });
  assert.deepEqual(due.map((r) => r.id), [id], 'due AT its time — the look must read the same $1 as the claim');
});

test('a leased alert is no more due to the look than to the claim', opts, async (t) => {
  const s = await setup(t);
  const id = await seedAlert(s);
  assert.ok(await s.outbox.claimInternalAlertById(id), 'another worker holds it');
  assert.deepEqual(await s.outbox.claimDueInternalAlerts(), []);
  assert.equal(Number((await s.outbox.getInternalAlertRow(id)).internal_alert_attempts), 1, 'still one attempt');
});

test('the staff-alert sweep delivers a due alert end to end on the narrow reads', opts, async (t) => {
  const s = await setup(t);
  await s.ht.updateHomeTimeSettings({ enabled: true, internal_clarification_group_id: '-1009999' });
  const id = await seedAlert(s);
  const sends = [];
  const telegram = { async sendMessage(chatId, text) { sends.push({ chatId, text }); return { message_id: 1 }; } };

  const res = await s.alerts.runInternalAlertSweep(telegram);

  assert.deepEqual(res, { configured: true, claimed: 1, sent: 1, failed: 0 });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].chatId, '-1009999');
  assert.match(sends[0].text, /Pascal F — Unit 96266/);
  assert.match(sends[0].text, new RegExp(`Request #${id}`));
  assert.equal((await s.outbox.getInternalAlertRow(id)).internal_alert_state, 'delivered');
});
