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

test('manager tag WITH dates tells the three managers immediately, with no buttons', async () => {
  const { service, telegram, inserts, sends, messageLinks, notices } = loadService({
    gemini: { json: { is_home_time_request: true, confidence: 'high', dates_specified: true, home_from: FROM, home_to: LAST_DAY } },
  });
  await service.handleApproverMention(telegram, GROUP, { message_id: 10, text: `home ${FROM} to ${LAST_DAY} @tomr_robins0n`, from: { id: 1, username: 'rep' } });
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].homeFrom, FROM);
  assert.equal(inserts[0].returnToRoadDate, TO); // last-day-home + 1
  assert.equal(sends.length, 1);
  assert.equal(sends[0].extra?.reply_markup, undefined, 'no Approve / Do Not Approve buttons');
  assert.match(sends[0].text, /Home-Time Request/);
  assert.match(sends[0].text, /Driver is requesting Home Time/);
  for (const who of ['@tomr_robins0n', '@SaffieBNett', '@amelia_wenze']) {
    assert.ok(sends[0].text.includes(who), `${who} is tagged`);
  }
  assert.equal(sends[0].chatId, NOTIFY_GROUP_ID, 'posts to the notification group, not the driver group');
  assert.notEqual(sends[0].chatId, GROUP.telegram_group_id);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].eventType, 'request');
  assert.equal(messageLinks.length, 1);
  assert.equal(messageLinks[0].chatId, NOTIFY_GROUP_ID, 'stored message chat id is the notification group');
});

test('the same request completed twice tells the managers once', async () => {
  const { service, telegram, sends, notices } = loadService({
    gemini: { json: { is_home_time_request: true, confidence: 'high', dates_specified: true, home_from: FROM, home_to: LAST_DAY } },
  });
  const msg = { message_id: 10, text: `home ${FROM} to ${LAST_DAY} @tomr_robins0n`, from: { id: 1, username: 'rep' } };
  await service.handleApproverMention(telegram, GROUP, msg);
  await service.handleApproverMention(telegram, GROUP, { ...msg, message_id: 11 });
  assert.equal(notices.length, 1, 'one event, one notice — the second insert is a no-op');
  assert.equal(sends.length, 1, 'and three managers are not tagged twice');
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

test('approver tag WITHOUT dates records the request anyway and asks nothing', async () => {
  const { service, telegram, inserts, sends } = loadService({
    gemini: { json: { is_home_time_request: true, confidence: 'high', dates_specified: false }, text: new Error('force fallback') },
  });
  await service.handleApproverMention(telegram, GROUP, { message_id: 42, text: 'he wants to go home @tomr_robins0n', from: { id: 1 } });
  assert.equal(inserts.length, 1);
  // Recorded, not awaiting. Missing dates are missing, not a question.
  assert.equal(inserts[0].status, 'recorded');
  assert.equal(inserts[0].rootMessageId, 42);
  assert.equal(inserts[0].nextReminderAt, null, 'nothing is ever scheduled');
  assert.equal(inserts[0].homeFrom, null, 'a date nobody gave is not invented');
  assert.equal(inserts[0].returnToRoadDate, null);
  const asked = sends.filter((m) => /date|back on the road/i.test(m.text || ''));
  assert.deepEqual(asked, [], 'the driver is not asked for dates');
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

test('approver tag, AI unavailable + genuine "go home" wording → still recorded', async () => {
  const { service, telegram, inserts } = loadService({
    gemini: { json: new Error('AI down'), text: new Error('AI down') },
  });
  await service.handleApproverMention(telegram, GROUP, {
    message_id: 43, text: 'send him home please @tomr_robins0n', from: { id: 1 },
  });
  assert.equal(inserts.length, 1, 'an AI outage must not lose the request');
  assert.equal(inserts[0].status, 'recorded');
  assert.equal(inserts[0].nextReminderAt, null);
});

test('Status: Home records the arrival and asks the driver nothing', async () => {
  const homeStartIso = TODAY.toUTC().toISO();
  const { service, telegram, inserts, sends } = loadService({
    open: null, homeStatus: { state: 'home', state_since: homeStartIso },
    gemini: { text: new Error('force fallback') },
  });
  await service.handleActualHomeArrival(telegram, GROUP, { message_id: 77, text: 'Status: Home', from: { id: 900 } }, { homeStartIso });
  // The cycle was already opened by applyStateTransition and the managers were
  // already told. "When are you back?" is Home Out, and Home Out is read from
  // the Dispatcher Board, not guessed by the driver on the day they arrive.
  assert.deepEqual(inserts, [], 'no clarification row is created');
  assert.deepEqual(sends, [], 'nothing is sent into the driver group');
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

test('Status: Home with a stale approved return date still asks nothing', async () => {
  const homeStartIso = TODAY.toUTC().toISO();
  const { service, telegram, inserts, sends } = loadService({
    open: null, approved: { id: 9, status: 'approved', return_to_road_date: '2020-01-01' },
    homeStatus: { state: 'home', state_since: homeStartIso },
    gemini: { text: new Error('force fallback') },
  });
  await service.handleActualHomeArrival(telegram, GROUP, { message_id: 78, text: 'Status: Home', from: { id: 900 } }, { homeStartIso });
  assert.deepEqual(inserts, []);
  assert.deepEqual(sends, []);
});

test('orchestrator: road→home transition asks nothing and creates no clarification', async () => {
  const homeStartIso = TODAY.toUTC().toISO();
  const { service, telegram, inserts, sends } = loadService({
    open: null, homeStatus: { state: 'home', state_since: homeStartIso },
    gemini: { text: new Error('force fallback') },
  });
  await service.processHomeTimeMessage(telegram, GROUP, { message_id: 79, text: 'Status: Home', from: { id: 900 } }, {
    statusResult: { transition: 'road_to_home', eventAt: homeStartIso },
  });
  assert.deepEqual(inserts, []);
  assert.deepEqual(sends, []);
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

test('an APPROVER-TAGGED request past the horizon is recorded without its bad date', async () => {
  const farOut = TODAY.plus({ days: 400 }).toISODate();
  const { service, telegram, inserts, sends } = loadService({
    gemini: { json: { is_home_time_request: true, confidence: 'high', dates_specified: true, home_from: farOut } },
  });
  await service.handleApproverMention(telegram, GROUP, {
    message_id: 51, text: `home ${farOut} @tomr_robins0n`, from: { id: 1 },
  });
  assert.equal(inserts.length, 1, 'the request is still recorded');
  assert.equal(inserts[0].status, 'recorded');
  assert.equal(inserts[0].nextReminderAt, null);
  const asked = sends.filter((m) => /date|back on the road/i.test(m.text || ''));
  assert.deepEqual(asked, [], 'a mis-parsed year is not a reason to interrogate the driver');
});

test('a home start a year out is recorded, and the driver is not interrogated', async () => {
  const farOut = TODAY.plus({ days: 380 }).toISODate();
  const { service, telegram, inserts, sends } = loadService({
    open: null,
    gemini: {
      json: {
        is_home_time_request: true, confidence: 'high', dates_specified: true,
        home_from: farOut, intent: 'home_time_request',
      },
    },
  });
  await service.processHomeTimeMessage(telegram, GROUP, {
    message_id: 52, text: `I want to go home ${farOut}`, from: { id: 900 },
  }, { statusResult: null, mentionsApprover: false });
  const asked = sends.filter((m) => /date|back on the road/i.test(m.text || ''));
  assert.deepEqual(asked, [], 'no clarification is opened for a date that parsed oddly');
  for (const row of inserts) assert.equal(row.nextReminderAt, null);
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

test('actual home arrival: an OUTDATED open request is closed and nothing is asked', async () => {
  const homeStartIso = TODAY.toUTC().toISO();
  const { service, telegram, inserts, sends, expiries } = loadService({
    open: { id: 7, status: 'awaiting_return_to_road', home_from: '2020-01-01', home_to: '2020-01-05' },
    homeStatus: { state: 'home', state_since: homeStartIso },
    gemini: { text: new Error('force fallback') },
  });
  await service.handleActualHomeArrival(telegram, GROUP, {
    message_id: 80, text: 'Status: Home', from: { id: 900 },
  }, { homeStartIso });
  assert.deepEqual(expiries, [7], 'a finished row must not block the next one');
  assert.deepEqual(inserts, [], 'and nothing new is opened to replace it');
  assert.deepEqual(sends, []);
});

