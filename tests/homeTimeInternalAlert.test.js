/**
 * Home-Time internal clarification alert — message contents and the DURABLE
 * delivery contract.
 *
 * When the bot is silent in driver groups this alert is the ONLY thing telling
 * staff a driver needs their dates confirmed, so losing one is a real
 * operational failure. These tests mock the outbox to pin the service's
 * behaviour; tests/homeTimeInternalAlertOutboxPg.test.js proves the outbox's own
 * atomicity against a real PostgreSQL.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const GROUP = {
  id: 7,
  telegram_group_id: '-1001234567890',
  group_type: 'driver',
  group_name: 'WENZE UNIT # 96266 (COMPANY DRIVER)',
};

const REQUEST = {
  id: 501,
  driver_name: 'Pascal F',
  unit_number: '96266',
  detected_intent: 'home_time_request',
  home_from: null,
  return_to_road_date: null,
  missing_fields: 'home_start,return_to_road',
  ai_reasoning: 'Driver asked for home time but gave no calendar dates.',
  internal_alert_attempts: 1,
};

const MESSAGE = {
  message_id: 9001,
  text: "My home time after tomorrow and I'm going to stay for the whole week",
};

const SETTINGS = { enabled: true, internal_clarification_group_id: '-1009999' };

/**
 * Load the alert service with the outbox + Telegram mocked.
 *
 * The fake outbox models the real state machine closely enough to be meaningful:
 * a row is claimable only while pending and unleased, and delivery is terminal.
 */
function loadAlert({
  sendFails = false, settings = SETTINGS, rows = null, due = null,
} = {}) {
  const alertPath = path.resolve(__dirname, '../services/homeTimeInternalAlert.js');
  const outboxPath = path.resolve(__dirname, '../database/homeTimeInternalAlertOutbox.js');
  const htPath = path.resolve(__dirname, '../database/homeTime.js');
  const htmlPath = path.resolve(__dirname, '../services/telegramHtml.js');
  delete require.cache[alertPath];

  const state = rows || new Map([[REQUEST.id, { ...REQUEST, internal_alert_state: null }]]);
  const calls = {
    enqueued: [], claimed: [], delivered: [], failed: [], released: [],
  };

  require.cache[outboxPath] = {
    exports: {
      async enqueueInternalAlert(id) {
        calls.enqueued.push(id);
        const r = state.get(id);
        if (r && !r.internal_alert_sent_at) r.internal_alert_state = 'pending';
        return r || null;
      },
      async claimInternalAlertById(id) {
        const r = state.get(id);
        if (!r || r.internal_alert_state !== 'pending' || r.leased) return null;
        r.leased = true;
        r.internal_alert_attempts = (r.internal_alert_attempts || 0) + 1;
        calls.claimed.push(id);
        return { ...r };
      },
      async claimDueInternalAlerts() {
        const list = due || [];
        list.forEach((r) => calls.claimed.push(r.id));
        return list;
      },
      async markInternalAlertDelivered(id) {
        const r = state.get(id);
        if (r) { r.internal_alert_state = 'delivered'; r.internal_alert_sent_at = 'now'; r.leased = false; }
        calls.delivered.push(id);
        return r || { id };
      },
      async markInternalAlertFailed(id, opts) {
        const r = state.get(id);
        if (r) { r.internal_alert_state = 'pending'; r.leased = false; }
        calls.failed.push({ id, ...opts });
        return r || { id, internal_alert_state: 'pending' };
      },
      async releaseInternalAlertClaim(id) { calls.released.push(id); return { id }; },
      async countPendingInternalAlerts() {
        return [...state.values()].filter((r) => r.internal_alert_state === 'pending').length;
      },
    },
  };
  require.cache[htPath] = { exports: { async getHomeTimeSettings() { return settings; } } };
  require.cache[htmlPath] = { exports: { safeSend: (fn) => fn() } };

  const sends = [];
  const telegram = {
    async sendMessage(chatId, text, options) {
      if (sendFails) throw new Error('telegram down');
      sends.push({ chatId, text, options });
      return { message_id: 1 };
    },
  };
  return {
    svc: require(alertPath), telegram, sends, calls, state,
  };
}

// ── message links ──

test('supergroup message link drops the -100 prefix', () => {
  const { svc } = loadAlert();
  assert.equal(
    svc.buildMessageLink({ telegramGroupId: '-1001234567890', messageId: 42 }),
    'https://t.me/c/1234567890/42',
  );
});

test('a public group with a username links by username', () => {
  const { svc } = loadAlert();
  assert.equal(
    svc.buildMessageLink({ telegramGroupId: '-1001234567890', groupUsername: '@wenzeunit', messageId: 42 }),
    'https://t.me/wenzeunit/42',
  );
});

test('an underivable link is null rather than a broken URL', () => {
  const { svc } = loadAlert();
  assert.equal(svc.buildMessageLink({ telegramGroupId: '-4477', messageId: 42 }), null);
  assert.equal(svc.buildMessageLink({ telegramGroupId: '-1001234567890', messageId: null }), null);
  assert.equal(svc.buildMessageLink({}), null);
});

// ── contents ──

test('the alert contains everything staff need to act', () => {
  const { svc } = loadAlert();
  const text = svc.buildInternalAlertText({
    requestId: 501,
    driverName: 'Pascal F',
    unitNumber: '96266',
    groupName: GROUP.group_name,
    messageText: MESSAGE.text,
    messageLink: 'https://t.me/c/1234567890/9001',
    detectedIntent: 'home_time_request',
    homeStartDate: null,
    returnToRoadDate: null,
    missingFields: ['home_start', 'return_to_road'],
    reason: 'Driver asked for home time but gave no calendar dates.',
  });

  assert.match(text, /Pascal F/, 'driver name');
  assert.match(text, /96266/, 'unit number');
  assert.match(text, /WENZE UNIT # 96266/, 'source driver group');
  assert.match(text, /My home time after tomorrow/, 'original message text');
  assert.match(text, /https:\/\/t\.me\/c\/1234567890\/9001/, 'link to the original message');
  assert.match(text, /home_time_request/, 'detected intention');
  assert.match(text, /none yet/, 'dates already identified');
  assert.match(text, /arrive-home date and return-to-road date/, 'dates still missing');
  assert.match(text, /gave no calendar dates/, 'classification reason');
  assert.match(text, /confirm the exact arrive-home and return-to-road dates/i, 'ask staff to clarify');
  assert.match(text, /Request #501/);
});

test('the alert tags both approvers', () => {
  const { svc } = loadAlert();
  const text = svc.buildInternalAlertText({ requestId: 1 });
  assert.match(text, /@tomr_robins0n/);
  assert.match(text, /@SaffieBNett/);
});

test('already-known dates are shown and only the real gap is listed as missing', () => {
  const { svc } = loadAlert();
  const text = svc.buildInternalAlertText({
    homeStartDate: '2026-08-02',
    returnToRoadDate: null,
    missingFields: ['return_to_road'],
  });
  assert.match(text, /arrives home <b>2026-08-02<\/b>/);
  assert.match(text, /Still missing:<\/b> return-to-road date/);
  assert.doesNotMatch(text, /arrive-home date/);
});

test('driver-supplied text is HTML-escaped, never injected', () => {
  const { svc } = loadAlert();
  const text = svc.buildInternalAlertText({
    driverName: '<b>evil</b>',
    messageText: '<script>alert(1)</script> & home time',
  });
  assert.doesNotMatch(text, /<script>/);
  assert.match(text, /&lt;script&gt;/);
  assert.match(text, /&lt;b&gt;evil&lt;\/b&gt;/);
  assert.match(text, /&amp; home time/);
});

test('a very long driver message is truncated', () => {
  const { svc } = loadAlert();
  const text = svc.buildInternalAlertText({ messageText: 'x'.repeat(5000) });
  assert.ok(text.length < 2000, `expected truncation, got ${text.length} chars`);
});

test('renderAlertForRequest works from a bare DB row (what the retry worker has)', () => {
  const { svc } = loadAlert();
  const text = svc.renderAlertForRequest({
    id: 77,
    driver_name: 'Pascal F',
    unit_number: '96266',
    group_name: GROUP.group_name,
    root_chat_id: '-1001234567890',
    root_message_id: 9001,
    missing_fields: 'return_to_road',
    detected_intent: 'home_time_request',
    ai_reasoning: 'needs the return date',
  });
  assert.match(text, /Pascal F/);
  assert.match(text, /WENZE UNIT # 96266/);
  assert.match(text, /https:\/\/t\.me\/c\/1234567890\/9001/, 'link rebuilt from the stored root ids');
  assert.match(text, /Request #77/);
});

// ── first delivery ──

test('SUCCESS: enqueued, claimed, sent to the internal group, marked delivered', async () => {
  const {
    svc, telegram, sends, calls,
  } = loadAlert();
  const res = await svc.notifyInternalClarification(telegram, {
    request: REQUEST, group: GROUP, message: MESSAGE, settings: SETTINGS,
  });
  assert.equal(res.sent, true);
  assert.deepEqual(calls.enqueued, [REQUEST.id], 'durably enqueued BEFORE sending');
  assert.deepEqual(calls.claimed, [REQUEST.id]);
  assert.deepEqual(calls.delivered, [REQUEST.id]);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].chatId, '-1009999');
  assert.equal(sends[0].options.parse_mode, 'HTML');
});

test('the alert never goes to the driver group', async () => {
  const { svc, telegram, sends } = loadAlert();
  await svc.notifyInternalClarification(telegram, {
    request: REQUEST, group: GROUP, message: MESSAGE, settings: SETTINGS,
  });
  assert.equal(sends.length, 1);
  assert.notEqual(sends[0].chatId, GROUP.telegram_group_id);
});

// ── failure, retry, duplicates ──

test('TEMPORARY FAILURE: the alert is marked failed for backoff, not delivered', async () => {
  const {
    svc, telegram, sends, calls,
  } = loadAlert({ sendFails: true });
  const res = await svc.notifyInternalClarification(telegram, {
    request: REQUEST, group: GROUP, message: MESSAGE, settings: SETTINGS,
  });
  assert.equal(res.sent, false);
  assert.equal(res.reason, 'send_failed');
  assert.equal(sends.length, 0);
  assert.equal(calls.delivered.length, 0, 'must NOT be marked delivered');
  assert.equal(calls.failed.length, 1);
  assert.match(calls.failed[0].error, /telegram down/);
});

test('RETRY AFTER FAILURE: the worker delivers it on the next sweep', async () => {
  // First attempt fails and leaves the row pending.
  const first = loadAlert({ sendFails: true });
  await first.svc.notifyInternalClarification(first.telegram, {
    request: REQUEST, group: GROUP, message: MESSAGE, settings: SETTINGS,
  });
  assert.equal(first.state.get(REQUEST.id).internal_alert_state, 'pending');

  // Next sweep claims the same row and Telegram is healthy again.
  const retry = loadAlert({ due: [{ ...REQUEST, internal_alert_state: 'pending', internal_alert_attempts: 2 }] });
  const res = await retry.svc.runInternalAlertSweep(retry.telegram);
  assert.equal(res.sent, 1);
  assert.equal(res.failed, 0);
  assert.equal(retry.sends.length, 1);
  assert.deepEqual(retry.calls.delivered, [REQUEST.id]);
});

test('DUPLICATE PREVENTION: a second call cannot claim a delivered alert', async () => {
  const { svc, telegram, sends } = loadAlert();
  await svc.notifyInternalClarification(telegram, {
    request: REQUEST, group: GROUP, message: MESSAGE, settings: SETTINGS,
  });
  const second = await svc.notifyInternalClarification(telegram, {
    request: REQUEST, group: GROUP, message: MESSAGE, settings: SETTINGS,
  });
  assert.equal(second.sent, false);
  assert.equal(second.reason, 'already_sent');
  assert.equal(sends.length, 1, 'exactly one alert ever reaches Telegram');
});

test('DUPLICATE PREVENTION: concurrent callers produce exactly one alert', async () => {
  const { svc, telegram, sends } = loadAlert();
  const results = await Promise.all(Array.from({ length: 5 }, () => svc.notifyInternalClarification(telegram, {
    request: REQUEST, group: GROUP, message: MESSAGE, settings: SETTINGS,
  })));
  assert.equal(sends.length, 1, 'exactly one alert for five concurrent attempts');
  assert.equal(results.filter((r) => r.sent).length, 1);
});

// ── missing configuration ──

test('MISSING GROUP: the alert stays PENDING (not lost) and nothing is claimed', async () => {
  const {
    svc, telegram, sends, calls, state,
  } = loadAlert({ settings: { enabled: true } });
  const res = await svc.notifyInternalClarification(telegram, {
    request: REQUEST, group: GROUP, message: MESSAGE, settings: { enabled: true },
  });
  assert.equal(res.sent, false);
  assert.equal(res.reason, 'not_configured');
  assert.equal(sends.length, 0);
  assert.deepEqual(calls.enqueued, [REQUEST.id], 'still enqueued so it can deliver later');
  assert.equal(calls.claimed.length, 0, 'no attempt is burned when there is nowhere to send');
  assert.equal(state.get(REQUEST.id).internal_alert_state, 'pending');
});

test('MISSING GROUP: the sweep claims nothing and reports why', async () => {
  const { svc, telegram, calls } = loadAlert({
    settings: { enabled: true },
    due: [{ ...REQUEST, internal_alert_state: 'pending' }],
  });
  const res = await svc.runInternalAlertSweep(telegram);
  assert.equal(res.configured, false);
  assert.equal(res.reason, 'not_configured');
  assert.equal(res.claimed, 0);
  assert.equal(calls.claimed.length, 0);
});

test('ONCE CONFIGURED: a previously pending alert is delivered by the sweep', async () => {
  const { svc, telegram, sends, calls } = loadAlert({
    settings: SETTINGS, // group now set
    due: [{ ...REQUEST, internal_alert_state: 'pending', internal_alert_attempts: 1 }],
  });
  const res = await svc.runInternalAlertSweep(telegram);
  assert.equal(res.configured, true);
  assert.equal(res.sent, 1);
  assert.equal(sends.length, 1);
  assert.deepEqual(calls.delivered, [REQUEST.id]);
});

test('the sweep does nothing while overall tracking is disabled', async () => {
  const { svc, telegram, calls } = loadAlert({
    settings: { enabled: false, internal_clarification_group_id: '-1009999' },
    due: [{ ...REQUEST, internal_alert_state: 'pending' }],
  });
  const res = await svc.runInternalAlertSweep(telegram);
  assert.equal(res.reason, 'tracking_disabled');
  assert.equal(calls.claimed.length, 0);
});

test('never throws, even on garbage input', async () => {
  const { svc, telegram } = loadAlert();
  assert.deepEqual(await svc.notifyInternalClarification(telegram, {}), { sent: false, reason: 'no_request' });
  assert.deepEqual(await svc.notifyInternalClarification(null, {}), { sent: false, reason: 'no_request' });
});
