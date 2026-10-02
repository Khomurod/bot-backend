/**
 * "Did it arrive" — the rules that turn the system's own counts into a fault a
 * person is told about. Fixtures are the production shapes of 2026-10-02.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  reconcileSafetyCounts, safetyLossNeedsAPerson, assessNoticeOutbox, publicTelegramError,
} = require('../lib/operations/deliveryTruth');

test('the reconciliation keeps its states', () => {
  assert.equal(reconcileSafetyCounts(null, 0).state, 'cannot_determine');
  assert.equal(reconcileSafetyCounts(4, null).state, 'cannot_determine');
  assert.equal(reconcileSafetyCounts(0, 0).state, 'reconciled');
  assert.equal(reconcileSafetyCounts(5, 5).state, 'reconciled');
  assert.equal(reconcileSafetyCounts(8, 0).state, 'events_lost');
});

test('the production shape — 8 seen, 0 kept — needs a person', () => {
  assert.equal(safetyLossNeedsAPerson(8, 0), true);
});

test('one event in flight is not a fault', () => {
  assert.equal(safetyLossNeedsAPerson(1, 0), false, 'seen this second, stored the next');
  assert.equal(safetyLossNeedsAPerson(2, 0), false);
});

test('most events kept is not a fault; most lost is', () => {
  assert.equal(safetyLossNeedsAPerson(10, 6), false);
  assert.equal(safetyLossNeedsAPerson(10, 4), true);
});

test('missing numbers never raise anything', () => {
  assert.equal(safetyLossNeedsAPerson(null, 0), false);
  assert.equal(safetyLossNeedsAPerson(8, null), false);
});

// The seven-day summary production returned on 2026-10-02.
const PRODUCTION_NOTICES = {
  arrived_home: { rows: 16, events: 16, delivered: 0, pending: 1, failed: 15, abandoned: 0 },
  back_on_road: { rows: 9, events: 9, delivered: 0, pending: 1, failed: 8, abandoned: 0 },
  request: { rows: 4, events: 4, delivered: 0, pending: 1, failed: 3, abandoned: 0 },
};

test('a week of notices with none delivered is broken, and says so plainly', () => {
  const v = assessNoticeOutbox(PRODUCTION_NOTICES);
  assert.equal(v.ok, false);
  assert.match(v.reason, /none of the 29 home-time notice\(s\) of the past week reached the managers/);
  assert.match(v.reason, /26 failed, 0 delivered/);
});

test('a hiccup among deliveries is not broken', () => {
  const v = assessNoticeOutbox({ arrived_home: { rows: 10, delivered: 9, failed: 1, pending: 0 } });
  assert.equal(v.ok, true);
});

test('more failed than delivered is broken even when some got through', () => {
  const v = assessNoticeOutbox({ arrived_home: { rows: 10, delivered: 2, failed: 8, pending: 0 } });
  assert.equal(v.ok, false);
  assert.match(v.reason, /8 of the 10/);
});

test('a quiet week is fine, and an unreadable outbox is unknown — never fine', () => {
  assert.equal(assessNoticeOutbox({}).ok, true);
  const unread = assessNoticeOutbox(null);
  assert.equal(unread.known, false);
});

test('a Telegram error keeps its words and loses every id, token and link', () => {
  assert.equal(publicTelegramError('400: Bad Request: chat not found'), '400: Bad Request: chat not found');
  const s = publicTelegramError(
    'Bad Request: group chat was upgraded to a supergroup chat -1001234567890 '
    + 'via https://api.telegram.org/bot123456789:AAFAKE-not-a-real-token-for-tests/send'
  );
  assert.doesNotMatch(s, /1234567890|AAFAKE|api\.telegram\.org/);
  assert.match(s, /upgraded to a supergroup/);
  assert.equal(publicTelegramError(null), null);
});
