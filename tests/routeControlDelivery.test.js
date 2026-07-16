/**
 * Route Control driver-group delivery (sendDriverGroupRouteMessage): the plain
 * text send, the screenshot photo send, photo+text splitting, the truthful
 * text fallback when a photo send fails, and after-send tracking activation.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadService, loadServiceWith } = require('./helpers/routeControlHarness');

const service = loadService();

// ── sendDriverGroupRouteMessage ──

function loadServiceForSend({ assignment, profile = null, telegramExtra = {} } = {}) {
  const captured = { chatId: null, body: null, extra: null, recorded: null, event: null };
  const svc = loadServiceWith({
    '../database/db.js': {
      async getDriverProfileByGroupId() { return profile; },
    },
    '../database/routeControl.js': {
      async getRouteAssignment() { return assignment; },
      async recordDriverGroupMessageSent(id, opts) { captured.recorded = { id, opts }; return { id }; },
      async insertRouteMonitorEvent(e) { captured.event = e; return e; },
    },
  });
  const telegram = {
    async sendMessage(chatId, body, extra) {
      captured.chatId = chatId; captured.body = body; captured.extra = extra;
      return { message_id: 4242, ...telegramExtra };
    },
  };
  return { svc, telegram, captured };
}

test('sendDriverGroupRouteMessage sends to the driver group and records history', async () => {
  const { svc, telegram, captured } = loadServiceForSend({
    assignment: {
      id: 5, group_id: 7, telegram_group_id: -100200,
      original_url: 'https://maps.google.com/dir?a=1', origin_text: 'A', destination_text: 'B', waypoints: [],
    },
    profile: { telegram_user_id: 999, full_name: 'Bob Driver', group_name: 'G' },
  });
  const res = await svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram, sentBy: 'admin' });

  assert.equal(captured.chatId, -100200); // correct group — never a wrong chat id
  assert.equal(res.messageId, 4242);
  assert.equal(res.mentionConfidence, 'high');
  assert.equal(captured.extra.parse_mode, 'HTML');
  assert.match(captured.body, /tg:\/\/user\?id=999/);
  assert.equal(captured.recorded.id, 5);
  assert.equal(captured.recorded.opts.telegramMessageId, 4242);
  assert.equal(captured.recorded.opts.sentBy, 'admin');
  assert.equal(captured.event.eventType, 'driver_group_message_sent');
});

test('sendDriverGroupRouteMessage tags by @username when no id is known', async () => {
  const { svc, telegram, captured } = loadServiceForSend({
    assignment: { id: 5, group_id: 7, telegram_group_id: -100200, original_url: '(manual entry)', waypoints: [] },
    profile: { telegram_user_id: null, telegram_username: 'jd', full_name: 'Jane', group_name: 'G' },
  });
  const res = await svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram });
  assert.equal(res.mentionConfidence, 'medium');
  assert.match(captured.body, /@jd/);
});

test('sendDriverGroupRouteMessage uses the plain name when no Telegram account is known', async () => {
  const { svc, telegram, captured } = loadServiceForSend({
    assignment: { id: 5, group_id: 7, telegram_group_id: -100200, original_url: '(manual entry)', waypoints: [] },
    profile: { telegram_user_id: null, telegram_username: null, full_name: 'Jane Doe', group_name: 'G' },
  });
  const res = await svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram });
  assert.equal(res.mentionConfidence, 'low');
  assert.match(captured.body, /<b>Driver:<\/b> Jane Doe/);
});

test('sendDriverGroupRouteMessage escapes a custom message and still sends it', async () => {
  const { svc, telegram, captured } = loadServiceForSend({
    assignment: { id: 5, group_id: 7, telegram_group_id: -100200, original_url: '(manual entry)', waypoints: [] },
    profile: { telegram_user_id: 999, full_name: 'Bob', group_name: 'G' },
  });
  await svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram, customMessage: '<b>hi</b> & bye' });
  assert.equal(captured.body, '&lt;b&gt;hi&lt;/b&gt; &amp; bye');
});

test('sendDriverGroupRouteMessage rejects clearly when the group has no Telegram chat id', async () => {
  const { svc, telegram, captured } = loadServiceForSend({
    assignment: { id: 5, group_id: 7, telegram_group_id: null, waypoints: [] },
  });
  await assert.rejects(
    () => svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram }),
    (err) => { assert.equal(err.code, 'NO_TELEGRAM_GROUP'); return true; }
  );
  assert.equal(captured.chatId, null); // nothing was sent anywhere
});

test('sendDriverGroupRouteMessage rejects a missing assignment with 404', async () => {
  const { svc, telegram } = loadServiceForSend({ assignment: null });
  await assert.rejects(
    () => svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram }),
    (err) => { assert.equal(err.code, 'NOT_FOUND'); assert.equal(err.status, 404); return true; }
  );
});
// ── Screenshot delivery + after-send activation ──────────────────────────────

function loadServiceForScreenshotSend({ assignment, screenshot = null, sendPhotoImpl = null } = {}) {
  const captured = {
    photos: [], texts: [], recorded: null, events: [], activated: null,
  };
  const svc = loadServiceWith({
    '../database/db.js': {
      async getDriverProfileByGroupId() { return { telegram_user_id: 999, full_name: 'Bob', group_name: 'G' }; },
    },
    '../database/routeControl.js': {
      async getRouteAssignment() { return assignment; },
      async getRouteScreenshot() { return screenshot; },
      async recordDriverGroupMessageSent(id, opts) { captured.recorded = { id, opts }; return { id }; },
      async insertRouteMonitorEvent(e) { captured.events.push(e); return e; },
      async activateTracking(id) { captured.activated = id; return { id }; },
    },
  });
  const telegram = {
    async sendPhoto(chatId, photo, extra) {
      if (sendPhotoImpl) return sendPhotoImpl(chatId, photo, extra);
      captured.photos.push({ chatId, photo, extra });
      return { message_id: 71 };
    },
    async sendMessage(chatId, body, extra) {
      captured.texts.push({ chatId, body, extra });
      return { message_id: 72 };
    },
  };
  return { svc, telegram, captured };
}

const SEND_ASSIGNMENT = {
  id: 5, group_id: 7, telegram_group_id: -100200,
  original_url: 'https://maps.google.com/dir?a=1', origin_text: 'A', destination_text: 'B', waypoints: [],
  tracking_start_mode: 'after_message_sent', tracking_status: 'pending',
};

test('sendDriverGroupRouteMessage sends the screenshot as a photo with the route caption', async () => {
  const { svc, telegram, captured } = loadServiceForScreenshotSend({
    assignment: SEND_ASSIGNMENT,
    screenshot: { file_data: Buffer.from('PNG'), mime_type: 'image/png' },
  });
  const res = await svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram, sentBy: 'admin' });
  assert.equal(captured.photos.length, 1);
  assert.equal(captured.texts.length, 0, 'short message fits the caption — no separate text');
  assert.equal(captured.photos[0].chatId, -100200);
  assert.equal(
    captured.photos[0].photo,
    'https://example.test/api/route-screenshot-media/5?signed=test',
    'future screenshot sends use the JSON URL transport, not multipart upload'
  );
  assert.match(captured.photos[0].extra.caption, /Route Assigned/);
  assert.equal(res.withScreenshot, true);
  assert.equal(res.sentVia, 'photo');
  assert.equal(res.messageId, 71);
});

test('sendDriverGroupRouteMessage splits photo + text when the message exceeds the caption limit', async () => {
  const longWaypoints = Array.from({ length: 30 }, (_, i) => ({ raw: `Stop number ${i} — Some Very Long Warehouse Name, 12345 Extremely Long Industrial Parkway Blvd, Suite ${i}, Springfield` }));
  const { svc, telegram, captured } = loadServiceForScreenshotSend({
    assignment: { ...SEND_ASSIGNMENT, waypoints: longWaypoints },
    screenshot: { file_data: Buffer.from('PNG'), mime_type: 'image/png' },
  });
  const res = await svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram });
  assert.equal(captured.photos.length, 1);
  assert.equal(captured.texts.length, 1, 'details follow as a separate message');
  assert.match(captured.photos[0].extra.caption, /details below/);
  assert.ok(captured.texts[0].body.length > 1024);
  assert.equal(res.sentVia, 'photo+text');
});

test('sendDriverGroupRouteMessage falls back to text when the photo send fails — and reports it truthfully', async () => {
  const { svc, telegram, captured } = loadServiceForScreenshotSend({
    assignment: SEND_ASSIGNMENT,
    screenshot: { file_data: Buffer.from('PNG'), mime_type: 'image/png' },
    sendPhotoImpl: async () => { const e = new Error('photo boom'); e.response = { error_code: 400, description: 'PHOTO_INVALID' }; throw e; },
  });
  const res = await svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram });
  assert.equal(captured.texts.length, 1, 'text route message still sent');
  assert.equal(res.sent, true);
  assert.equal(res.sentVia, 'text');
  assert.equal(res.withScreenshot, false);
  assert.equal(res.screenshotStored, true, 'screenshot remains stored for a retry');
  assert.match(res.screenshotError, /TELEGRAM_PHOTO_REJECTED/, 'failure is reported, not hidden');
  // The persisted send record carries the same truth for the Admin list.
  assert.equal(captured.recorded.opts.via, 'text');
  assert.match(captured.recorded.opts.screenshotError, /TELEGRAM_PHOTO_REJECTED/);
});

test('sendDriverGroupRouteMessage: photo 403 is surfaced as a bot permission failure', async () => {
  const { svc, telegram } = loadServiceForScreenshotSend({
    assignment: SEND_ASSIGNMENT,
    screenshot: { file_data: Buffer.from('PNG'), mime_type: 'image/png' },
    sendPhotoImpl: async () => { const e = new Error('kicked'); e.response = { error_code: 403 }; throw e; },
  });
  const res = await svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram });
  assert.match(res.screenshotError, /lacks permission/);
});

test('sendDriverGroupRouteMessage: 413/oversize and timeout photo errors are classified safely', () => {
  const svc = loadService();
  assert.match(
    svc.classifyTelegramPhotoError({ response: { error_code: 413 } }),
    /too large.*413/i
  );
  assert.equal(svc.classifyTelegramPhotoError(new Error('request timed out')), 'TELEGRAM_PHOTO_TIMEOUT');
});

test('sendDriverGroupRouteMessage: photo AND text failure → clear failure, nothing marked sent, no tracking', async () => {
  const captured = { recorded: null, activated: null };
  const svc = loadServiceWith({
    '../database/db.js': {
      async getDriverProfileByGroupId() { return { telegram_user_id: 999, full_name: 'Bob', group_name: 'G' }; },
    },
    '../database/routeControl.js': {
      async getRouteAssignment() { return SEND_ASSIGNMENT; },
      async getRouteScreenshot() { return { file_data: Buffer.from('PNG'), mime_type: 'image/png' }; },
      async recordDriverGroupMessageSent(id, opts) { captured.recorded = { id, opts }; return { id }; },
      async insertRouteMonitorEvent() { return null; },
      async activateTracking(id) { captured.activated = id; return { id }; },
    },
  });
  const boom = (code) => { const e = new Error('down'); e.response = { error_code: code }; throw e; };
  const telegram = {
    async sendPhoto() { boom(400); },
    async sendMessage() { boom(403); }, // permanent → safeSend rethrows immediately
  };
  await assert.rejects(() => svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram }));
  assert.equal(captured.recorded, null, 'driver_group_message_sent_at is NOT marked');
  assert.equal(captured.activated, null, 'after-message tracking is NOT activated');
});

test('sendDriverGroupRouteMessage: screenshot DB read failure still sends the text and reports the code', async () => {
  const captured = { texts: 0, recorded: null };
  const svc = loadServiceWith({
    '../database/db.js': {
      async getDriverProfileByGroupId() { return { telegram_user_id: 999, full_name: 'Bob', group_name: 'G' }; },
    },
    '../database/routeControl.js': {
      async getRouteAssignment() { return SEND_ASSIGNMENT; },
      async getRouteScreenshot() { throw new Error('bytea read failed'); },
      async recordDriverGroupMessageSent(id, opts) { captured.recorded = { id, opts }; return { id }; },
      async insertRouteMonitorEvent() { return null; },
      async activateTracking(id) { return { id }; },
    },
  });
  const telegram = { async sendMessage() { captured.texts += 1; return { message_id: 9 }; } };
  const res = await svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram });
  assert.equal(captured.texts, 1);
  assert.equal(res.sent, true);
  assert.equal(res.screenshotError, 'SCREENSHOT_DB_READ_FAILED');
});

test('sendDriverGroupRouteMessage activates after_message_sent tracking on success', async () => {
  const { svc, telegram, captured } = loadServiceForScreenshotSend({ assignment: SEND_ASSIGNMENT });
  const res = await svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram });
  assert.equal(captured.activated, 5);
  assert.equal(res.trackingActivated, true);
  assert.ok(captured.events.some((e) => e.eventType === 'tracking_started'));
});

test('sendDriverGroupRouteMessage does NOT activate tracking for other start modes', async () => {
  const { svc, telegram, captured } = loadServiceForScreenshotSend({
    assignment: { ...SEND_ASSIGNMENT, tracking_start_mode: 'scheduled_time' },
  });
  const res = await svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram });
  assert.equal(captured.activated, null);
  assert.equal(res.trackingActivated, false);
});
