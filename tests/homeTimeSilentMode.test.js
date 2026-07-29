/**
 * Home-Time silent mode, end to end through the real orchestrator.
 *
 * With home_time_settings.driver_clarification_enabled = false the feature must
 * keep working COMPLETELY — detect, record, capture later dates, and post the
 * approval card — while saying absolutely nothing in the driver's group. Staff
 * get one internal alert instead.
 *
 * These tests drive services/homeTimeRequestService with its DB / AI / Telegram
 * dependencies mocked by the shared harness, so they exercise the real wiring
 * between the orchestrator, the clarification flow, the driver channel and the
 * internal alert.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FROM, TO, LAST_DAY, NOTIFY_GROUP_ID, INTERNAL_GROUP_ID, GROUP, loadService,
} = require('./helpers/homeTimeRequestServiceHarness');

// A driver-initiated request with no dates → a clarification would normally open.
const REQUEST_NO_DATES = {
  intent: 'home_time_request', confidence: 90, isActualStatusChange: false,
  requestedHomeTime: true, language: 'en',
  reason: 'Driver is asking for home time but gave no dates.',
};

const DRIVER_MSG = {
  message_id: 9001, date: Math.floor(Date.now() / 1000),
  from: { id: 900, username: 'driver' },
  text: 'I need some home time soon, been out 6 weeks',
};

function silent(extra = {}) {
  return loadService({ gemini: { json: REQUEST_NO_DATES }, driverMessaging: false, ...extra });
}

// ── the driver hears nothing ──

test('SILENT: a detected request sends NOTHING to the driver group', async () => {
  const h = silent();
  await h.service.processHomeTimeMessage(h.telegram, GROUP, DRIVER_MSG, {});
  assert.equal(h.driverSends().length, 0, 'no clarification question to the driver');
  assert.equal(h.reactions.length, 0, 'no reaction either');
});

test('SILENT: the request is still recorded, with dates, status and AI reasoning', async () => {
  const h = silent();
  await h.service.processHomeTimeMessage(h.telegram, GROUP, DRIVER_MSG, {});
  assert.equal(h.inserts.length, 1, 'the request is still created');
  const row = h.inserts[0];
  assert.equal(row.status, 'awaiting_dates');
  assert.equal(row.detectedIntent, 'home_time_request');
  assert.equal(row.aiConfidence, 90);
  assert.match(row.aiReasoning, /asking for home time/i);
  assert.equal(row.groupId, GROUP.id);
});

test('SILENT: the request is stamped clarification_channel = internal', async () => {
  const h = silent();
  await h.service.processHomeTimeMessage(h.telegram, GROUP, DRIVER_MSG, {});
  assert.equal(h.inserts[0].clarificationChannel, 'internal');
});

test('SILENT: no reminder is scheduled, so none can leak or replay later', async () => {
  const h = silent();
  await h.service.processHomeTimeMessage(h.telegram, GROUP, DRIVER_MSG, {});
  assert.equal(h.inserts[0].nextReminderAt, null);
});

// ── staff hear about it ──

test('SILENT: exactly one internal alert is sent, to the configured staff group', async () => {
  const h = silent();
  await h.service.processHomeTimeMessage(h.telegram, GROUP, DRIVER_MSG, {});
  const internal = h.internalSends();
  assert.equal(internal.length, 1);
  assert.equal(internal[0].chatId, INTERNAL_GROUP_ID);
});

test('SILENT: the internal alert carries the driver, group, message and gaps', async () => {
  const h = silent();
  await h.service.processHomeTimeMessage(h.telegram, GROUP, DRIVER_MSG, {});
  const { text } = h.internalSends()[0];
  assert.match(text, /Pascal F/, 'driver name');
  assert.match(text, /96266/, 'unit number');
  assert.match(text, /WENZE UNIT # 96266/, 'source driver group');
  assert.match(text, /been out 6 weeks/, 'original message');
  assert.match(text, /@tomr_robins0n/);
  assert.match(text, /@SaffieBNett/);
  assert.match(text, /arrive-home date and return-to-road date/, 'what is missing');
});

test('SILENT: DUPLICATE PREVENTION — a repeated detection does not re-alert', async () => {
  const h = silent();
  await h.service.processHomeTimeMessage(h.telegram, GROUP, DRIVER_MSG, {});
  await h.service.processHomeTimeMessage(h.telegram, GROUP, DRIVER_MSG, {});
  // Two requests were created (two separate detections), but the SAME request id
  // is never alerted twice — the atomic claim is what guarantees it.
  assert.equal(new Set(h.internalClaims).size, h.internalClaims.length,
    'no request id claimed more than once');
});

test('SILENT: an unconfigured internal group loses no data', async () => {
  const h = silent({ internalGroupId: null });
  await h.service.processHomeTimeMessage(h.telegram, GROUP, DRIVER_MSG, {});
  assert.equal(h.sends.length, 0, 'nothing sent anywhere');
  assert.equal(h.inserts.length, 1, 'the request is STILL recorded for the admin panel');
  assert.equal(h.inserts[0].clarificationChannel, 'internal');
});

// ── later silent date capture ──

const OPEN_CLARIFICATION = {
  id: 77,
  status: 'awaiting_return_to_road',
  home_from: FROM,
  home_to: null,
  return_to_road_date: null,
  root_message_id: 9001,
  language: 'en',
  requested_at: new Date().toISOString(),
};

const FOLLOWUP_MSG = {
  message_id: 9100, date: Math.floor(Date.now() / 1000),
  from: { id: 900, username: 'driver' },
  text: `I'll be back on the road ${TO}`,
};

const FOLLOWUP_VERDICT = {
  intent: 'home_time_followup', confidence: 95, isActualStatusChange: false,
  requestedHomeTime: false, language: 'en',
  homeStartDate: FROM, returnToRoadDate: TO, lastDayHome: LAST_DAY,
  reason: 'Driver supplied the return date.',
};

test('SILENT: a date the driver volunteers later is captured on the SAME request', async () => {
  const h = loadService({
    gemini: { json: FOLLOWUP_VERDICT },
    clarification: OPEN_CLARIFICATION,
    driverMessaging: false,
  });
  await h.service.processHomeTimeMessage(h.telegram, GROUP, FOLLOWUP_MSG, {});
  assert.equal(h.fulfills.length, 1, 'the open request is completed');
  assert.equal(h.fulfills[0].id, 77, 'the SAME request, not a new one');
  assert.equal(h.fulfills[0].payload.returnToRoadDate, TO);
});

test('SILENT: completing the dates still posts the approval card to the staff group', async () => {
  const h = loadService({
    gemini: { json: FOLLOWUP_VERDICT },
    clarification: OPEN_CLARIFICATION,
    driverMessaging: false,
  });
  await h.service.processHomeTimeMessage(h.telegram, GROUP, FOLLOWUP_MSG, {});
  const cards = h.notifySends();
  assert.equal(cards.length, 1, 'the completed-request card is unaffected by silent mode');
  assert.equal(cards[0].chatId, NOTIFY_GROUP_ID);
  assert.ok(cards[0].extra.reply_markup, 'the Approve / Do Not Approve buttons are present');
});

test('SILENT: completing the dates still says nothing to the driver', async () => {
  const h = loadService({
    gemini: { json: FOLLOWUP_VERDICT },
    clarification: OPEN_CLARIFICATION,
    driverMessaging: false,
  });
  await h.service.processHomeTimeMessage(h.telegram, GROUP, FOLLOWUP_MSG, {});
  assert.equal(h.driverSends().length, 0, 'no acknowledgment and no policy warning');
  assert.equal(h.reactions.length, 0, 'no 👍 to the driver');
});

// ── the same flows with messaging ON are unchanged ──

test('ENABLED: the driver IS asked, and no internal alert is raised', async () => {
  const h = loadService({ gemini: { json: REQUEST_NO_DATES }, driverMessaging: true });
  await h.service.processHomeTimeMessage(h.telegram, GROUP, DRIVER_MSG, {});
  assert.equal(h.driverSends().length, 1, 'the driver is asked for dates');
  assert.equal(h.internalSends().length, 0, 'no internal alert while messaging is on');
  assert.equal(h.inserts[0].clarificationChannel, 'driver');
  assert.ok(h.inserts[0].nextReminderAt, 'a reminder IS scheduled');
});

test('ENABLED: completing the dates acknowledges the driver as before', async () => {
  const h = loadService({
    gemini: { json: FOLLOWUP_VERDICT },
    clarification: OPEN_CLARIFICATION,
    driverMessaging: true,
  });
  await h.service.processHomeTimeMessage(h.telegram, GROUP, FOLLOWUP_MSG, {});
  assert.equal(h.notifySends().length, 1, 'card still posted');
  assert.equal(h.driverSends().length, 1, 'driver still gets the policy response');
});

// ── toggling ──

test('TOGGLING off then on does not replay anything for the old request', async () => {
  // Opened while silent: no reminder scheduled, channel internal, staff alerted.
  const off = silent();
  await off.service.processHomeTimeMessage(off.telegram, GROUP, DRIVER_MSG, {});
  assert.equal(off.inserts[0].nextReminderAt, null);
  assert.equal(off.driverSends().length, 0);

  // Switched back on. A NEW detection behaves normally; the old request has no
  // schedule to fire, so nothing is replayed to the driver about it.
  const on = loadService({ gemini: { json: REQUEST_NO_DATES }, driverMessaging: true });
  await on.service.processHomeTimeMessage(on.telegram, GROUP, DRIVER_MSG, {});
  assert.equal(on.driverSends().length, 1, 'only the new request is asked about');
  assert.equal(on.internalSends().length, 0);
});
