const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TODAY, FROM, TO, LAST_DAY, NOTIFY_GROUP_ID, GROUP, loadService,
} = require('./helpers/homeTimeRequestServiceHarness');

// ── legacy classifier (unchanged contract) ──

test('classifyHomeTimeRequest: AI false → not a request', async () => {
  const { service } = loadService({ gemini: { json: { is_home_time_request: false, confidence: 'high', reason: 'oil change' } } });
  const v = await service.classifyHomeTimeRequest({ transcript: 'oil change', triggerText: 'need an oil change @tomr_robins0n' });
  assert.equal(v.isRequest, false);
});

test('classifyHomeTimeRequest: request with valid dates is extracted', async () => {
  const { service } = loadService({
    gemini: { json: { is_home_time_request: true, confidence: 'high', dates_specified: true, home_from: FROM, home_to: LAST_DAY } },
  });
  const v = await service.classifyHomeTimeRequest({ triggerText: `home ${FROM} to ${LAST_DAY} @tomr_robins0n` });
  assert.equal(v.isRequest, true);
  assert.equal(v.datesSpecified, true);
});

// ── handleApproverMention ──

test('approver tag, not a request → no card, no clarification', async () => {
  const { service, telegram, inserts, sends } = loadService({
    gemini: { json: { is_home_time_request: false, confidence: 'high', reason: 'oil change' } },
  });
  await service.handleApproverMention(telegram, GROUP, { message_id: 10, text: 'oil change @tomr_robins0n', from: { id: 1 } });
  assert.equal(inserts.length, 0);
  assert.equal(sends.length, 0);
});

test('approver tag WITH dates posts the approval card immediately', async () => {
  const { service, telegram, inserts, sends, messageLinks } = loadService({
    gemini: { json: { is_home_time_request: true, confidence: 'high', dates_specified: true, home_from: FROM, home_to: LAST_DAY } },
  });
  await service.handleApproverMention(telegram, GROUP, { message_id: 10, text: `home ${FROM} to ${LAST_DAY} @tomr_robins0n`, from: { id: 1, username: 'rep' } });
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].status, 'pending');
  assert.equal(inserts[0].homeFrom, FROM);
  assert.equal(inserts[0].returnToRoadDate, TO); // last-day-home + 1
  assert.equal(sends.length, 1);
  assert.ok(sends[0].extra?.reply_markup, 'card carries inline buttons');
  assert.equal(sends[0].chatId, NOTIFY_GROUP_ID, 'card posts to the notification group, not the driver group');
  assert.notEqual(sends[0].chatId, GROUP.telegram_group_id);
  assert.equal(messageLinks.length, 1);
  assert.equal(messageLinks[0].chatId, NOTIFY_GROUP_ID, 'stored message chat id is the notification group');
});

test('approver tag WITH dates but NO notification group → card is NOT posted to the driver group', async () => {
  const { service, telegram, inserts, sends, messageLinks } = loadService({
    notifyGroupId: null,
    gemini: { json: { is_home_time_request: true, confidence: 'high', dates_specified: true, home_from: FROM, home_to: LAST_DAY } },
  });
  await service.handleApproverMention(telegram, GROUP, { message_id: 10, text: `home ${FROM} to ${LAST_DAY} @tomr_robins0n`, from: { id: 1, username: 'rep' } });
  assert.equal(inserts.length, 1, 'request is still recorded for the admin panel');
  assert.equal(sends.length, 0, 'no card posted anywhere (never the driver group)');
  assert.equal(messageLinks.length, 0);
});

test('approver tag WITHOUT dates opens a clarification, replying to the tag message', async () => {
  const { service, telegram, inserts, sends, clarMsgs } = loadService({
    gemini: { json: { is_home_time_request: true, confidence: 'high', dates_specified: false }, text: new Error('force fallback') },
  });
  await service.handleApproverMention(telegram, GROUP, { message_id: 42, text: 'he wants to go home @tomr_robins0n', from: { id: 1 } });
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].status, 'awaiting_dates');
  assert.equal(inserts[0].rootMessageId, 42);
  assert.ok(inserts[0].nextReminderAt, 'first reminder scheduled');
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /dates/i);
  assert.equal(sends[0].extra?.reply_to_message_id, 42, 'clarification replies to the tag message');
  assert.equal(clarMsgs.length, 1);
});

test('approver tag is a no-op when an open request already exists', async () => {
  const { service, telegram, inserts, sends } = loadService({
    open: { id: 1, status: 'awaiting_dates' },
    gemini: { json: { is_home_time_request: true, confidence: 'high' } },
  });
  await service.handleApproverMention(telegram, GROUP, { message_id: 1, text: 'go home @tomr_robins0n', from: { id: 1 } });
  assert.equal(inserts.length, 0);
  assert.equal(sends.length, 0);
});

test('approver tag while already home → no card (unplanned flow handles that)', async () => {
  const { service, telegram, inserts, sends, geminiCalls } = loadService({
    homeStatus: { state: 'home', state_since: TODAY.minus({ days: 1 }).toUTC().toISO() },
    gemini: { json: { is_home_time_request: true, confidence: 'high', dates_specified: true, home_from: FROM, home_to: LAST_DAY } },
  });
  await service.handleApproverMention(telegram, GROUP, { message_id: 1, text: `home ${FROM} to ${LAST_DAY} @tomr_robins0n`, from: { id: 1 } });
  assert.equal(inserts.length, 0);
  assert.equal(sends.length, 0);
  assert.equal(geminiCalls.json.length, 0, 'short-circuits before AI');
});

// ── manager mention must not force a request on a temporary stop / errand ──

test('classifyHomeTimeRequest: confident AI request on an errand is refused (temporary stop)', async () => {
  const { service } = loadService({
    gemini: { json: { is_home_time_request: true, confidence: 'high', reason: 'ai thinks home' } },
  });
  const v = await service.classifyHomeTimeRequest({
    triggerText: 'He needs to pass by his house to pick up his personal belongings @tomr_robins0n',
  });
  assert.equal(v.isRequest, false);
  assert.match(v.reason, /temporary stop|errand/i);
});

test('approver tag on the EXACT "pass by the house to grab belongings" example → no card, no clarification', async () => {
  const { service, telegram, inserts, sends } = loadService({
    gemini: { json: { is_home_time_request: true, confidence: 'high', reason: 'ai over-eager' } },
  });
  await service.handleApproverMention(telegram, GROUP, {
    message_id: 10,
    text: 'Please talk to the driver. He needs to pass by his house to pick up his personal belongings @tomr_robins0n',
    from: { id: 1 },
  });
  assert.equal(inserts.length, 0, 'no request recorded for a temporary stop');
  assert.equal(sends.length, 0, 'nothing sent to anyone');
});

test('approver tag, AI unavailable + errand wording → not surfaced', async () => {
  const { service, telegram, inserts, sends } = loadService({ gemini: { json: new Error('no key') } });
  await service.handleApproverMention(telegram, GROUP, {
    message_id: 10, text: 'he needs to go home to grab his charger @tomr_robins0n', from: { id: 1 },
  });
  assert.equal(inserts.length, 0);
  assert.equal(sends.length, 0);
});

test('approver tag, AI unavailable + genuine "go home" wording → clarification still opens', async () => {
  const { service, telegram, inserts, sends } = loadService({
    gemini: { json: new Error('no key'), text: new Error('force fallback') },
  });
  await service.handleApproverMention(telegram, GROUP, {
    message_id: 10, text: 'driver wants to go home, been out 6 weeks @tomr_robins0n', from: { id: 1 },
  });
  assert.equal(inserts.length, 1, 'genuine time-off wording is still surfaced during an outage');
  assert.equal(inserts[0].status, 'awaiting_dates');
  assert.equal(sends.length, 1);
});

// ── handleActualHomeArrival (Status: Home without an earlier request) ──

test('Status: Home with no earlier request asks ONLY for the return-to-road date, replying to it', async () => {
  const homeStartIso = TODAY.toUTC().toISO();
  const { service, telegram, inserts, sends } = loadService({
    open: null, homeStatus: { state: 'home', state_since: homeStartIso },
    gemini: { text: new Error('force fallback') },
  });
  await service.handleActualHomeArrival(telegram, GROUP, { message_id: 77, text: 'Status: Home', from: { id: 900 } }, { homeStartIso });
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].status, 'awaiting_return_to_road');
  assert.equal(inserts[0].isUnplannedArrival, true);
  assert.equal(inserts[0].homeFrom, TODAY.toISODate()); // home start = the Status: Home date
  assert.equal(inserts[0].returnToRoadDate, null); // never fabricated
  assert.equal(inserts[0].rootMessageId, 77);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].extra?.reply_to_message_id, 77);
  assert.match(sends[0].text, /back on the road/i);
});

test('Status: Home does NOT re-ask when a complete request already exists (no duplicate)', async () => {
  const { service, telegram, inserts, sends } = loadService({
    open: { id: 5, status: 'pending', home_from: FROM, return_to_road_date: TO },
  });
  await service.handleActualHomeArrival(telegram, GROUP, { message_id: 77, text: 'Status: Home', from: { id: 900 } }, { homeStartIso: TODAY.toUTC().toISO() });
  assert.equal(inserts.length, 0);
  assert.equal(sends.length, 0);
});

test('Status: Home reuses an APPROVED request return date (no re-ask, no clarification)', async () => {
  // No OPEN request, but an approved home-time request already carries a usable
  // return-to-road date → do not open a clarification or send any message.
  const homeStartIso = TODAY.toUTC().toISO();
  const { service, telegram, inserts, sends } = loadService({
    open: null,
    approvedRequest: { id: 12, status: 'approved', home_from: TODAY.toISODate(), return_to_road_date: TO },
    homeStatus: { state: 'home', state_since: homeStartIso },
  });
  await service.handleActualHomeArrival(telegram, GROUP, { message_id: 77, text: 'Status: Home', from: { id: 900 } }, { homeStartIso });
  assert.equal(inserts.length, 0, 'no new clarification request created');
  assert.equal(sends.length, 0, 'the driver is NOT asked for a return date again');
});

test('Status: Home reuses an approved window that only carries home_to (last day home + 1)', async () => {
  const homeStartIso = TODAY.toUTC().toISO();
  const { service, telegram, inserts, sends } = loadService({
    open: null,
    approvedRequest: { id: 13, status: 'approved', home_from: TODAY.toISODate(), return_to_road_date: null, home_to: LAST_DAY },
    homeStatus: { state: 'home', state_since: homeStartIso },
  });
  await service.handleActualHomeArrival(telegram, GROUP, { message_id: 77, text: 'Status: Home', from: { id: 900 } }, { homeStartIso });
  assert.equal(inserts.length, 0);
  assert.equal(sends.length, 0);
});

test('Status: Home still asks when the only approved return date is stale/unusable', async () => {
  // Approved return date is in the past relative to this arrival → not reused.
  const homeStartIso = TODAY.toUTC().toISO();
  const stalePast = TODAY.minus({ days: 30 }).toISODate();
  const { service, telegram, inserts, sends } = loadService({
    open: null,
    approvedRequest: { id: 14, status: 'approved', home_from: stalePast, return_to_road_date: stalePast },
    homeStatus: { state: 'home', state_since: homeStartIso },
    gemini: { text: new Error('force fallback') },
  });
  await service.handleActualHomeArrival(telegram, GROUP, { message_id: 77, text: 'Status: Home', from: { id: 900 } }, { homeStartIso });
  assert.equal(inserts.length, 1, 'a fresh clarification is opened');
  assert.equal(inserts[0].status, 'awaiting_return_to_road');
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /back on the road/i);
});

// ── handleHomeTimeClarificationReply (plain-text follow-up) ──

test('driver answers the return date (no Telegram reply) → completes + posts card + 👍 ack', async () => {
  const { service, telegram, fulfills, sends, reactions } = loadService({
    clarification: { id: 42, status: 'awaiting_return_to_road', home_from: FROM, return_to_road_date: null, language: 'en' },
    gemini: {
      json: {
        intent: 'home_time_followup', confidence: 90, isActualStatusChange: false,
        requestedHomeTime: false, returnToRoadDate: TO,
      },
      text: 'Awesome, noted.',
    },
    // Compliant: 40 days on road, 4 home days.
    homeStatus: { state: 'home', state_since: TODAY.toUTC().toISO() },
    openStay: { road_started_at: TODAY.minus({ days: 40 }).toUTC().toISO(), days_on_road: 40 },
  });
  await service.handleHomeTimeClarificationReply(telegram, GROUP, { message_id: 88, text: `back on the road ${TO}`, from: { id: 900, username: 'driver' } });
  assert.equal(fulfills.length, 1);
  assert.equal(fulfills[0].payload.returnToRoadDate, TO);
  // one card (notification group) + one ack (driver group)
  assert.ok(sends.length >= 2, 'card and acknowledgment both sent');
  const card = sends.find((s) => s.extra?.reply_markup);
  const ack = sends.find((s) => !s.extra?.reply_markup);
  assert.ok(card, 'approval card posted');
  assert.equal(card.chatId, NOTIFY_GROUP_ID, 'card → notification group');
  assert.equal(ack.chatId, GROUP.telegram_group_id, 'ack → driver group (existing behavior)');
  assert.equal(ack.extra?.reply_to_message_id, 88, 'ack replies to the driver message');
  assert.equal(reactions.length, 1, 'compliant → 👍 reaction on the driver message');
  assert.equal(reactions[0].chatId, GROUP.telegram_group_id, 'reaction is in the driver group');
});

test('over-home window → firm policy reminder, NO 👍', async () => {
  const longReturn = TODAY.plus({ days: 10 }).toISODate(); // ~10 home days > 4
  const { service, telegram, fulfills, sends, reactions } = loadService({
    clarification: { id: 42, status: 'awaiting_return_to_road', home_from: TODAY.toISODate(), return_to_road_date: null },
    gemini: {
      json: {
        intent: 'home_time_followup', confidence: 90, isActualStatusChange: false, returnToRoadDate: longReturn,
      },
      text: new Error('force fallback'),
    },
    homeStatus: { state: 'home', state_since: TODAY.toUTC().toISO() },
    openStay: { road_started_at: TODAY.minus({ days: 40 }).toUTC().toISO(), days_on_road: 40 },
  });
  await service.handleHomeTimeClarificationReply(telegram, GROUP, { message_id: 88, text: `back ${longReturn}`, from: { id: 900 } });
  assert.equal(fulfills.length, 1);
  assert.equal(reactions.length, 0, 'not compliant → no 👍');
  const warning = sends.find((s) => /4 weeks on the road/i.test(s.text));
  assert.ok(warning, 'firm policy reminder sent');
  assert.equal(warning.chatId, GROUP.telegram_group_id, 'under-allowance reminder stays in the driver group');
});

test('unrelated plain text is NOT consumed as an answer', async () => {
  const { service, telegram, fulfills, sends } = loadService({
    clarification: { id: 42, status: 'awaiting_return_to_road', home_from: FROM },
    gemini: { json: { intent: 'unrelated', confidence: 95, isActualStatusChange: false } },
  });
  await service.handleHomeTimeClarificationReply(telegram, GROUP, { message_id: 88, text: 'ok thanks boss', from: { id: 900 } });
  assert.equal(fulfills.length, 0);
  assert.equal(sends.length, 0);
});

test('no open clarification → follow-up handler is a no-op', async () => {
  const { service, telegram, fulfills } = loadService({ clarification: null });
  await service.handleHomeTimeClarificationReply(telegram, GROUP, { message_id: 88, text: `back ${TO}`, from: { id: 900 } });
  assert.equal(fulfills.length, 0);
});

// ── processHomeTimeMessage orchestration ──

test('orchestrator: road→home transition triggers the unplanned-arrival ask', async () => {
  const homeStartIso = TODAY.toUTC().toISO();
  const { service, telegram, inserts } = loadService({ open: null, homeStatus: { state: 'home', state_since: homeStartIso }, gemini: { text: new Error('fb') } });
  await service.processHomeTimeMessage(telegram, GROUP, { message_id: 77, text: 'Status: Home', from: { id: 900 } }, {
    statusResult: { transition: 'road_to_home', eventAt: homeStartIso },
    mentionsApprover: false,
  });
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].status, 'awaiting_return_to_road');
});

test('orchestrator: repeated same-status line does nothing conversational', async () => {
  const { service, telegram, inserts, sends } = loadService({});
  await service.processHomeTimeMessage(telegram, GROUP, { message_id: 1, text: 'Status: Home', from: { id: 900 } }, {
    statusResult: { changed: false, transition: null, eventAt: TODAY.toUTC().toISO() },
    mentionsApprover: false,
  });
  assert.equal(inserts.length, 0);
  assert.equal(sends.length, 0);
});

test('orchestrator: AI "actual_home_status" on a brief ERRAND stop does NOT flip the tracker or ask', async () => {
  const { service, telegram, stateTransitions, inserts, sends } = loadService({
    open: null, clarification: null,
    homeStatus: { state: 'road', state_since: TODAY.minus({ days: 30 }).toUTC().toISO() },
    gemini: {
      json: {
        intent: 'actual_home_status', confidence: 95, isActualStatusChange: true,
        requestedHomeTime: false, reason: 'ai thinks driver is home',
      },
    },
  });
  await service.processHomeTimeMessage(telegram, GROUP, {
    message_id: 5, text: "he's at the house grabbing his charger, then back out", from: { id: 900 },
  }, { statusResult: null, mentionsApprover: false });
  assert.equal(stateTransitions.length, 0, 'no state transition applied for a brief stop');
  assert.equal(inserts.length, 0, 'no unplanned-arrival request opened');
  assert.equal(sends.length, 0, 'driver is not asked about a return-to-road date');
});

test('orchestrator: AI "actual_home_status" on a genuine arrival DOES flip the tracker', async () => {
  const { service, telegram, stateTransitions } = loadService({
    open: null, clarification: null,
    homeStatus: { state: 'road', state_since: TODAY.minus({ days: 30 }).toUTC().toISO() },
    gemini: {
      json: {
        intent: 'actual_home_status', confidence: 95, isActualStatusChange: true,
        requestedHomeTime: false, reason: 'driver arrived home',
      },
    },
  });
  await service.processHomeTimeMessage(telegram, GROUP, {
    message_id: 6, text: 'uyga yetib keldim', from: { id: 900 },
  }, { statusResult: null, mentionsApprover: false });
  assert.equal(stateTransitions.length, 1, 'a genuine home arrival still transitions');
  assert.equal(stateTransitions[0].newState, 'home');
});

// ── outdated-request guards (expiry applied consistently, not just in the UI) ──

const PAST_FROM = TODAY.minus({ days: 40 }).toISODate();
const PAST_RETURN = TODAY.minus({ days: 33 }).toISODate();

test('approver tag: an OUTDATED open request is auto-closed and a fresh request proceeds', async () => {
  const { service, telegram, inserts, sends, expiries } = loadService({
    open: { id: 1, status: 'pending', home_from: PAST_FROM, return_to_road_date: PAST_RETURN },
    gemini: { json: { is_home_time_request: true, confidence: 'high', dates_specified: true, home_from: FROM, home_to: LAST_DAY } },
  });
  await service.handleApproverMention(telegram, GROUP, {
    message_id: 10, text: `home ${FROM} to ${LAST_DAY} @tomr_robins0n`, from: { id: 1, username: 'rep' },
  });
  assert.deepEqual(expiries, [1], 'the stale open request was expired first');
  assert.equal(inserts.length, 1, 'a brand-new request was created (not blocked)');
  assert.ok(sends.length >= 1, 'a new card/message was sent');
});

test('late reply to an OUTDATED clarification is ignored (expired, never completed)', async () => {
  const { service, telegram, fulfills, updates, expiries } = loadService({
    clarification: {
      id: 42, status: 'awaiting_return_to_road', home_from: PAST_FROM,
      return_to_road_date: null, next_reminder_at: null, requested_at: `${PAST_FROM}T00:00:00Z`,
    },
    gemini: { json: { intent: 'home_time_followup', confidence: 90, returnToRoadDate: TO } },
  });
  await service.handleHomeTimeClarificationReply(telegram, GROUP, {
    message_id: 88, text: `back ${TO}`, from: { id: 900 },
  });
  assert.deepEqual(expiries, [42], 'the stale clarification was expired');
  assert.equal(fulfills.length, 0, 'the expired request is never completed');
  assert.equal(updates.length, 0, 'the expired request is never advanced');
});

test('orchestrator: an OUTDATED open clarification is expired and the message is not fed to it', async () => {
  const { service, telegram, fulfills, inserts, expiries } = loadService({
    clarification: {
      id: 42, status: 'awaiting_dates', home_from: null,
      next_reminder_at: null, requested_at: `${PAST_FROM}T00:00:00Z`,
    },
    gemini: { json: { intent: 'unrelated', confidence: 90 } },
  });
  await service.processHomeTimeMessage(telegram, GROUP, {
    message_id: 5, text: 'ok thanks boss', from: { id: 900 },
  }, { statusResult: null, mentionsApprover: false });
  assert.deepEqual(expiries, [42]);
  assert.equal(fulfills.length, 0);
  assert.equal(inserts.length, 0);
});

test('actual home arrival: an OUTDATED open request does not block a fresh unplanned-arrival flow', async () => {
  const homeStartIso = TODAY.toUTC().toISO();
  const { service, telegram, inserts, expiries } = loadService({
    open: { id: 1, status: 'pending', home_from: PAST_FROM, return_to_road_date: PAST_RETURN },
    homeStatus: { state: 'home', state_since: homeStartIso },
    gemini: { text: new Error('force fallback') },
  });
  await service.handleActualHomeArrival(telegram, GROUP, {
    message_id: 77, text: 'Status: Home', from: { id: 900 },
  }, { homeStartIso });
  assert.deepEqual(expiries, [1], 'the stale request was expired');
  assert.equal(inserts.length, 1, 'a fresh unplanned-arrival clarification was opened');
  assert.equal(inserts[0].status, 'awaiting_return_to_road');
  assert.equal(inserts[0].isUnplannedArrival, true);
});
