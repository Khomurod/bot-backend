'use strict';

/**
 * Home-Time silent mode, end to end through the real orchestrator.
 *
 * THE RULE THIS FILE PROTECTS. `home_time_settings.driver_clarification_enabled`
 * governs one thing and one thing only: whether Wenze may write in a DRIVER's
 * group. It has never governed whether a request is recorded, and it must never
 * govern whether the three managers are told — that notice goes to the staff
 * notification group, which is never a driver's chat.
 *
 * WHAT CHANGED. These tests used to describe a clarification conversation: with
 * messaging off the request opened `awaiting_dates`, was stamped
 * `clarification_channel = internal`, and staff got an alert saying which dates
 * were missing; with messaging on the driver was ASKED for those dates and a
 * reminder was scheduled. None of that happens now. Wenze does not ask a driver
 * for planned dates at all — Home In and Home Out are read from the Dispatcher
 * Board — so a request is recorded, the managers are told, the driver gets at
 * most one reply, and it is finished. The switch now changes exactly one
 * observable thing: that reply.
 *
 * These tests drive services/homeTimeRequestService with its DB / AI / Telegram
 * dependencies mocked by the shared harness, so they exercise the real wiring
 * between the orchestrator, the request-delivery flow, the driver channel and
 * the manager notice.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  NOTIFY_GROUP_ID, GROUP, loadService,
} = require('./helpers/homeTimeRequestServiceHarness');

// A driver-initiated request with no dates — once the trigger for the whole
// clarification apparatus, now simply a request with two null columns.
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

/** Silent: driver messaging off. `gemini.text` errors so the deterministic
 *  wording is used and a test can assert the exact sentence. */
function silent(extra = {}) {
  return loadService({
    gemini: { json: REQUEST_NO_DATES, text: new Error('force fallback') },
    driverMessaging: false,
    ...extra,
  });
}

function loud(extra = {}) {
  return loadService({
    gemini: { json: REQUEST_NO_DATES, text: new Error('force fallback') },
    driverMessaging: true,
    ...extra,
  });
}

// ── the driver hears nothing ──

test('SILENT: a detected request sends NOTHING to the driver group', async () => {
  const h = silent();
  await h.service.processHomeTimeMessage(h.telegram, GROUP, DRIVER_MSG, {});
  assert.equal(h.driverSends().length, 0, 'not one word into the driver chat');
  assert.equal(h.reactions.length, 0, 'no reaction either');
});

test('SILENT: the request is still recorded, with its intent and AI reasoning', async () => {
  const h = silent();
  await h.service.processHomeTimeMessage(h.telegram, GROUP, DRIVER_MSG, {});
  assert.equal(h.inserts.length, 1, 'the request is still created');
  const row = h.inserts[0];
  assert.equal(row.status, 'recorded', 'recorded, never awaiting anybody');
  assert.equal(row.detectedIntent, 'home_time_request');
  assert.equal(row.aiConfidence, 90);
  assert.match(row.aiReasoning, /asking for home time/i);
  assert.equal(row.groupId, GROUP.id);
});

test('SILENT: missing dates stay missing — they never become a question', async () => {
  const h = silent();
  await h.service.processHomeTimeMessage(h.telegram, GROUP, DRIVER_MSG, {});
  const row = h.inserts[0];
  assert.equal(row.homeFrom, null);
  assert.equal(row.returnToRoadDate, null);
  assert.equal(row.nextReminderAt, null, 'nothing is scheduled, so nothing can leak later');
});

// ── the managers hear about it, in BOTH modes ──

test('SILENT: the three managers are still told — the switch does not reach them', async () => {
  const h = silent();
  await h.service.processHomeTimeMessage(h.telegram, GROUP, DRIVER_MSG, {});
  const cards = h.notifySends();
  assert.equal(cards.length, 1, 'the staff notice is not a driver message');
  assert.equal(cards[0].chatId, NOTIFY_GROUP_ID);
  assert.equal(cards[0].extra?.reply_markup, undefined, 'and it carries no decision buttons');
  for (const who of ['@tomr_robins0n', '@SaffieBNett', '@amelia_wenze']) {
    assert.ok(cards[0].text.includes(who), `${who} is tagged`);
  }
  assert.match(cards[0].text, /PASCAL F \(Unit 96266\)/, 'who it is about');
});

test('the manager notice is IDENTICAL whether or not the driver may be messaged', async () => {
  const off = silent();
  await off.service.processHomeTimeMessage(off.telegram, GROUP, DRIVER_MSG, {});
  const on = loud();
  await on.service.processHomeTimeMessage(on.telegram, GROUP, DRIVER_MSG, {});
  assert.equal(off.notifySends()[0].text, on.notifySends()[0].text);
});

test('SILENT: no internal clarification alert is raised — there is nothing to ask', async () => {
  const h = silent();
  await h.service.processHomeTimeMessage(h.telegram, GROUP, DRIVER_MSG, {});
  assert.equal(h.internalSends().length, 0,
    'the staff alert existed to say which dates were missing; nothing asks for dates now');
  assert.equal(h.internalClaims.length, 0, 'and nothing is enqueued for the alert worker');
});

test('SILENT: an unconfigured staff group loses no data', async () => {
  const h = silent({ notifyGroupId: null });
  await h.service.processHomeTimeMessage(h.telegram, GROUP, DRIVER_MSG, {});
  assert.equal(h.sends.length, 0, 'nothing sent anywhere');
  assert.equal(h.inserts.length, 1, 'the request is STILL recorded for the admin panel');
  assert.equal(h.inserts[0].status, 'recorded');
});

// ── with messaging ON, the driver gets a reply, not a question ──

test('ENABLED: the driver gets ONE acknowledgment, and it asks for nothing', async () => {
  const h = loud();
  await h.service.processHomeTimeMessage(h.telegram, GROUP, DRIVER_MSG, {});
  const sent = h.driverSends();
  assert.equal(sent.length, 1, 'exactly one message, not a question and a reminder');
  assert.equal(sent[0].text, 'Awesome, I took note. Thanks for letting me know.');
  assert.equal(sent[0].text.includes('?'), false, 'Wenze no longer asks the driver anything');
  assert.equal(h.reactions.length, 1, 'and a 👍 on the message it is replying to');
});

test('ENABLED: the request is recorded exactly as it is while silent', async () => {
  const h = loud();
  await h.service.processHomeTimeMessage(h.telegram, GROUP, DRIVER_MSG, {});
  assert.equal(h.inserts.length, 1);
  assert.equal(h.inserts[0].status, 'recorded');
  assert.equal(h.inserts[0].nextReminderAt, null, 'a reminder is never scheduled, in either mode');
  assert.equal(h.internalSends().length, 0);
});

// ── the shapes that must stay gone ──

test('no request path can open an awaiting_* status any more', () => {
  const flow = fs.readFileSync(
    path.resolve(__dirname, '../services/homeTimeClarificationFlow.js'), 'utf8'
  );
  const code = flow.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const gone of [
    'createClarification',
    'advanceClarification',
    'statusForMissingFields',
    'notifyInternalClarification',
    'reminderTimeIfAllowed',
  ]) {
    assert.equal(code.includes(gone), false,
      `${gone} must not be reachable — a retired conversation kept "just in case" comes back`);
  }
});

test('TOGGLING off then on replays nothing, because nothing was ever scheduled', async () => {
  const off = silent();
  await off.service.processHomeTimeMessage(off.telegram, GROUP, DRIVER_MSG, {});
  assert.equal(off.inserts[0].nextReminderAt, null);
  assert.equal(off.driverSends().length, 0);

  const on = loud();
  await on.service.processHomeTimeMessage(on.telegram, GROUP, DRIVER_MSG, {});
  assert.equal(on.driverSends().length, 1, 'only the new request is acknowledged');
  assert.equal(on.inserts[0].nextReminderAt, null, 'and it too schedules nothing');
});
