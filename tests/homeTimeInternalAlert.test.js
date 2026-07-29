/**
 * Home-Time internal clarification alert.
 *
 * When the bot is silent in driver groups, this alert is the ONLY thing telling
 * staff a driver needs their dates confirmed. So it must: contain everything a
 * human needs, tag the approvers, link back to the original message when it can,
 * and — critically — go out exactly once per request no matter how many ticks,
 * retries or restarts happen.
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
};

const MESSAGE = {
  message_id: 9001,
  text: "My home time after tomorrow and I'm going to stay for the whole week",
};

const SETTINGS = { internal_clarification_group_id: '-1009999' };

/**
 * Load the alert module with the DB claim helpers and Telegram mocked.
 * `claimed` controls whether THIS caller wins the atomic claim.
 */
function loadAlert({ claimed = true, sendFails = false } = {}) {
  const alertPath = path.resolve(__dirname, '../services/homeTimeInternalAlert.js');
  const htPath = path.resolve(__dirname, '../database/homeTime.js');
  const htmlPath = path.resolve(__dirname, '../services/telegramHtml.js');
  delete require.cache[alertPath];

  const claims = [];
  const releases = [];
  require.cache[htPath] = {
    exports: {
      async claimInternalClarificationAlert(id) {
        claims.push(id);
        return claimed ? { ...REQUEST, id, internal_alert_sent_at: 'now' } : null;
      },
      async releaseInternalClarificationAlert(id) {
        releases.push(id);
        return { id };
      },
    },
  };
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
    svc: require(alertPath), telegram, sends, claims, releases,
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
  const long = 'x'.repeat(5000);
  const text = svc.buildInternalAlertText({ messageText: long });
  assert.ok(text.length < 2000, `expected truncation, got ${text.length} chars`);
});

// ── sending + duplicate prevention ──

test('the alert is sent to the configured internal group with HTML parse mode', async () => {
  const {
    svc, telegram, sends,
  } = loadAlert();
  const res = await svc.notifyInternalClarification(telegram, {
    request: REQUEST, group: GROUP, message: MESSAGE, settings: SETTINGS,
  });
  assert.equal(res.sent, true);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].chatId, '-1009999');
  assert.equal(sends[0].options.parse_mode, 'HTML');
  assert.match(sends[0].text, /Pascal F/);
});

test('the alert never goes to the driver group', async () => {
  const { svc, telegram, sends } = loadAlert();
  await svc.notifyInternalClarification(telegram, {
    request: REQUEST, group: GROUP, message: MESSAGE, settings: SETTINGS,
  });
  assert.equal(sends.length, 1);
  assert.notEqual(sends[0].chatId, GROUP.telegram_group_id);
});

test('DUPLICATE PREVENTION: losing the atomic claim sends nothing', async () => {
  const { svc, telegram, sends } = loadAlert({ claimed: false });
  const res = await svc.notifyInternalClarification(telegram, {
    request: REQUEST, group: GROUP, message: MESSAGE, settings: SETTINGS,
  });
  assert.equal(res.sent, false);
  assert.equal(res.reason, 'already_sent');
  assert.equal(sends.length, 0);
});

test('DUPLICATE PREVENTION: concurrent callers produce exactly one alert', async () => {
  // First caller wins the claim, every later caller loses it — the real DB
  // guard is `WHERE internal_alert_sent_at IS NULL`.
  const alertPath = path.resolve(__dirname, '../services/homeTimeInternalAlert.js');
  const htPath = path.resolve(__dirname, '../database/homeTime.js');
  const htmlPath = path.resolve(__dirname, '../services/telegramHtml.js');
  delete require.cache[alertPath];
  let alerted = false;
  require.cache[htPath] = {
    exports: {
      async claimInternalClarificationAlert(id) {
        if (alerted) return null;
        alerted = true;
        return { ...REQUEST, id };
      },
      async releaseInternalClarificationAlert() { alerted = false; return {}; },
    },
  };
  require.cache[htmlPath] = { exports: { safeSend: (fn) => fn() } };
  const svc = require(alertPath);

  const sends = [];
  const telegram = { async sendMessage(chatId, text) { sends.push({ chatId, text }); return { message_id: 1 }; } };

  const results = await Promise.all(Array.from({ length: 5 }, () => svc.notifyInternalClarification(telegram, {
    request: REQUEST, group: GROUP, message: MESSAGE, settings: SETTINGS,
  })));

  assert.equal(sends.length, 1, 'exactly one alert for five concurrent attempts');
  assert.equal(results.filter((r) => r.sent).length, 1);
});

test('MISSING GROUP: no alert, no claim, and the request is still kept', async () => {
  const { svc, telegram, sends, claims } = loadAlert();
  const res = await svc.notifyInternalClarification(telegram, {
    request: REQUEST, group: GROUP, message: MESSAGE, settings: {},
  });
  assert.equal(res.sent, false);
  assert.equal(res.reason, 'not_configured');
  assert.equal(sends.length, 0);
  assert.equal(claims.length, 0, 'the claim must not be burned when nothing can be sent');
});

test('a failed send RELEASES the claim so a later pass can retry', async () => {
  const { svc, telegram, releases } = loadAlert({ sendFails: true });
  const res = await svc.notifyInternalClarification(telegram, {
    request: REQUEST, group: GROUP, message: MESSAGE, settings: SETTINGS,
  });
  assert.equal(res.sent, false);
  assert.equal(res.reason, 'send_failed');
  assert.deepEqual(releases, [REQUEST.id]);
});

test('never throws, even on garbage input', async () => {
  const { svc, telegram } = loadAlert();
  assert.deepEqual(await svc.notifyInternalClarification(telegram, {}), { sent: false, reason: 'no_request' });
  assert.deepEqual(await svc.notifyInternalClarification(null, {}), { sent: false, reason: 'no_request' });
});
