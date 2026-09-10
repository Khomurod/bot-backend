/**
 * The three home-time events, the words they use, and the promise that each is
 * told once.
 *
 * The rule these tests exist to hold: "the driver asked to go home", "the driver
 * IS home" and "the driver went back to work" are three different facts. The old
 * system had one message for the first and silence for the other two, and the
 * one message asked a question. Confusing them again would be a regression a
 * manager notices before any test does.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const notice = require('../lib/homeTime/managerNotice');

const MANAGERS = ['@tomr_robins0n', '@SaffieBNett', '@amelia_wenze'];
const NOTICES_PATH = path.resolve(__dirname, '../services/homeTime/managerNotices.js');
const HT_PATH = path.resolve(__dirname, '../database/homeTime.js');
const PEOPLE_PATH = path.resolve(__dirname, '../database/driverPeople.js');
const CONSTANTS_PATH = path.resolve(__dirname, '../services/homeTimeRequestConstants.js');
const HTML_PATH = path.resolve(__dirname, '../services/telegramHtml.js');

// ── the words ────────────────────────────────────────────────────────────────

test('a request says the driver ASKED — never that they are home', () => {
  const text = notice.buildRequestNotice({
    driverName: 'John Doe', unitNumber: '123', daysOnRoad: 39,
    homeFrom: '2026-09-18', returnToRoadDate: '2026-09-22', mentions: MANAGERS,
  });
  assert.match(text, /Home-Time Request — JOHN DOE \(Unit 123\)/);
  assert.match(text, /Driver is requesting Home Time/);
  assert.match(text, /On the road: <b>39 days<\/b> \(~5\.6 weeks\)/);
  assert.match(text, /Requested dates: <b>Sep 18 → Sep 22<\/b>/);
  assert.equal(/is now home|returned to work/.test(text), false,
    'a request must never read as an arrival');
  for (const who of MANAGERS) assert.ok(text.includes(who));
});

test('an arrival says the driver IS home, and carries the start of the cycle', () => {
  const text = notice.buildArrivedHomeNotice({
    driverName: 'John Doe', unitNumber: '123',
    homeSince: '2026-09-18', plannedReturn: '2026-09-22', daysOnRoad: 39, mentions: MANAGERS,
  });
  assert.match(text, /Driver Is Home — JOHN DOE \(Unit 123\)/);
  assert.match(text, /Wenze detected that the driver is now home/);
  assert.match(text, /Home since: <b>Sep 18<\/b>/);
  assert.match(text, /Planned return: <b>Sep 22<\/b>/);
  assert.equal(/requesting/.test(text), false);
});

test('a return says the driver went back to WORK, with days at home and the evidence', () => {
  const text = notice.buildBackOnRoadNotice({
    driverName: 'John Doe', unitNumber: '123', endedAt: '2026-09-22', homeDays: 4,
    evidence: 'active load + confirmed truck activity', mentions: MANAGERS,
  });
  assert.match(text, /Driver Back on the Road — JOHN DOE \(Unit 123\)/);
  assert.match(text, /returned to work/);
  assert.match(text, /Home Time ended: <b>Sep 22<\/b>/);
  assert.match(text, /Time at home: <b>4 days<\/b>/);
  assert.match(text, /Evidence: active load \+ confirmed truck activity/);
});

test('one day at home is a day, not days', () => {
  const text = notice.buildBackOnRoadNotice({ driverName: 'A', homeDays: 1 });
  assert.match(text, /Time at home: <b>1 day<\/b>/);
});

test('no notice ever carries a button, and unknown facts are simply absent', () => {
  for (const type of notice.EVENT_TYPES) {
    const text = notice.buildNotice(type, { driverName: 'A', mentions: MANAGERS });
    assert.equal(/Approve|Do Not Approve|reply_markup/.test(text), false);
    assert.equal(/undefined|null|NaN/.test(text), false, `${type} renders no placeholder`);
  }
});

test('a driver name is escaped AFTER upper-casing, so the entities stay valid', () => {
  // Upper-casing an already-escaped name produces "&LT;", which Telegram's HTML
  // parser does not recognise — the message renders wrong or is rejected.
  const text = notice.buildRequestNotice({ driverName: '<b>x</b>&', unitNumber: '<i>' });
  assert.ok(text.includes('&lt;B&gt;X&lt;/B&gt;&amp;'), text);
  assert.equal(text.includes('&LT;'), false, 'no upper-cased entity');
  assert.equal(text.includes('<b>x</b>'), false, 'no injected markup');
  assert.ok(text.includes('Unit &lt;i&gt;'));
});

test('an unknown event type throws rather than posting a blank card', () => {
  assert.throws(() => notice.buildNotice('approved', {}), /Unknown home-time event type/);
});

test('the event key is derived from the data, so the same event is always the same key', () => {
  assert.equal(notice.eventKeyFor('arrived_home', 412), 'arrived_home:412');
  assert.equal(notice.eventKeyFor('arrived_home', '412'), notice.eventKeyFor('arrived_home', 412));
  assert.notEqual(notice.eventKeyFor('arrived_home', 412), notice.eventKeyFor('back_on_road', 412));
});

// ── recording and sending ────────────────────────────────────────────────────

function loadNotifier({ enqueueReturns = 'row', sendThrows = null, claimReturns = 'row' } = {}) {
  for (const p of [NOTICES_PATH, HT_PATH, PEOPLE_PATH, CONSTANTS_PATH, HTML_PATH]) delete require.cache[p];
  const seen = new Set();
  const state = { enqueued: [], delivered: [], failed: [], sends: [], claimed: [] };
  require.cache[HT_PATH] = {
    exports: {
      async enqueueNotice(payload) {
        if (enqueueReturns === 'null') return null;
        if (seen.has(payload.eventKey)) return null; // the real UNIQUE(event_key)
        seen.add(payload.eventKey);
        state.enqueued.push(payload);
        return { id: state.enqueued.length, ...payload };
      },
      async claimNoticeById(id) {
        if (claimReturns === null) return null;
        const row = { ...state.enqueued[id - 1], id, attempts: 1 };
        state.claimed.push(row);
        return row;
      },
      async markNoticeDelivered(id, opts) { state.delivered.push({ id, ...opts }); return { id }; },
      async markNoticeFailed(id, err) { state.failed.push({ id, err }); return { id }; },
      async claimDueNotices() { return state.due || []; },
    },
  };
  require.cache[PEOPLE_PATH] = { exports: { async getPersonIdForGroup() { return 7; } } };
  require.cache[HTML_PATH] = {
    exports: {
      async safeSend(fn) { return fn(); },
    },
  };
  const telegram = {
    async sendMessage(chatId, text, extra) {
      state.sends.push({ chatId, text, extra });
      if (sendThrows) throw new Error(sendThrows);
      return { message_id: 500 + state.sends.length };
    },
  };
  return { notices: require(NOTICES_PATH), telegram, state };
}

const SETTINGS = { completed_notify_group_id: '-100777' };

test('an arrival is recorded, delivered, and stamped with the person', async () => {
  const { notices, telegram, state } = loadNotifier();
  const r = await notices.noticeDriverIsHome(telegram, {
    roadHistoryId: 412, groupId: 3, driverName: 'A', unitNumber: '9',
    homeSince: '2026-09-18', settings: SETTINGS,
  });
  assert.equal(r.recorded, true);
  assert.equal(r.delivered, true);
  assert.equal(state.enqueued[0].eventKey, 'arrived_home:412');
  assert.equal(state.enqueued[0].personId, 7, 'the permanent driver, not just the chat');
  assert.equal(state.sends[0].chatId, '-100777');
  assert.equal(state.sends[0].extra.reply_markup, undefined);
  assert.equal(state.delivered.length, 1);
});

test('the same arrival derived again tells nobody a second time', async () => {
  const { notices, telegram, state } = loadNotifier();
  const args = {
    roadHistoryId: 412, groupId: 3, driverName: 'A', homeSince: '2026-09-18', settings: SETTINGS,
  };
  await notices.noticeDriverIsHome(telegram, args);
  const second = await notices.noticeDriverIsHome(telegram, args);
  assert.equal(second.recorded, false);
  assert.equal(second.reason, 'already_recorded');
  assert.equal(state.sends.length, 1, 'three managers are tagged once');
});

test('a return with no cycle to close still gets one stable key per event', async () => {
  const { notices, telegram, state } = loadNotifier();
  const args = {
    roadHistoryId: null, eventKeySuffix: '3:2026-09-22T00:00:00Z', groupId: 3,
    driverName: 'A', endedAt: '2026-09-22', settings: SETTINGS,
  };
  await notices.noticeDriverBackOnRoad(telegram, args);
  await notices.noticeDriverBackOnRoad(telegram, args);
  assert.equal(state.sends.length, 1);
  assert.equal(state.enqueued[0].eventKey, 'back_on_road:3:2026-09-22T00:00:00Z');
});

test('with neither a cycle nor a fallback key, nothing is recorded rather than something wrong', async () => {
  const { notices, telegram, state } = loadNotifier();
  const r = await notices.noticeDriverBackOnRoad(telegram, { groupId: 3, driverName: 'A', settings: SETTINGS });
  assert.equal(r.recorded, false);
  assert.equal(r.reason, 'no_event_key');
  assert.equal(state.sends.length, 0);
});

test('no notification group configured → recorded nowhere, and no crash', async () => {
  const { notices, telegram, state } = loadNotifier();
  const r = await notices.noticeHomeTimeRequested(telegram, {
    requestId: 1, groupId: 3, driverName: 'A', settings: { completed_notify_group_id: null },
  });
  assert.equal(r.recorded, false);
  assert.equal(r.reason, 'no_chat');
  assert.equal(state.sends.length, 0);
});

test('a notice is CLAIMED before it is sent, so the sweep cannot send it too', async () => {
  // The row is due the moment it exists. Without a lease, an immediate send and
  // a sweep running at the same time both hold the same notice and three
  // managers are tagged twice — the unique key stops a second ROW, not a
  // second SEND.
  const { notices, telegram, state } = loadNotifier();
  await notices.noticeDriverIsHome(telegram, {
    roadHistoryId: 77, groupId: 3, driverName: 'A', homeSince: '2026-09-18', settings: SETTINGS,
  });
  assert.equal(state.claimed.length, 1, 'the immediate path takes the lease');
  assert.equal(state.claimed[0].id, state.enqueued.length);
});

test('a claim taken by someone else means this path sends nothing', async () => {
  const { notices, telegram, state } = loadNotifier({ claimReturns: null });
  const r = await notices.noticeDriverIsHome(telegram, {
    roadHistoryId: 78, groupId: 3, driverName: 'A', homeSince: '2026-09-18', settings: SETTINGS,
  });
  assert.equal(r.recorded, true, 'the event is still recorded');
  assert.equal(r.delivered, false);
  assert.equal(state.sends.length, 0, 'but the worker holding the lease will send it');
});

test('a Telegram failure keeps the event recorded for the retry sweep', async () => {
  const { notices, telegram, state } = loadNotifier({ sendThrows: 'chat not found' });
  const r = await notices.noticeDriverIsHome(telegram, {
    roadHistoryId: 9, groupId: 3, driverName: 'A', homeSince: '2026-09-18', settings: SETTINGS,
  });
  assert.equal(r.recorded, true, 'the event is not lost because the send failed');
  assert.equal(r.delivered, false);
  assert.equal(state.failed.length, 1);
  assert.match(state.failed[0].err, /chat not found/);
});

test('the sweep delivers what it claims and counts what it could not', async () => {
  const { notices, telegram, state } = loadNotifier();
  state.due = [
    { id: 1, chatId: '-100777', body: 'one' },
    { id: 2, chatId: '-100777', body: 'two' },
  ];
  const summary = await notices.runManagerNoticeSweep(telegram);
  assert.deepEqual(summary, { claimed: 2, delivered: 2, failed: 0 });
  assert.equal(state.sends.length, 2);
});
