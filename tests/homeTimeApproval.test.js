/**
 * Unit tests for the SHARED home-time decision workflow (services/homeTimeApproval
 * applyHomeTimeDecision), which backs BOTH the Telegram approval buttons and the
 * admin panel. Covers approve/decline, date validation, atomic conflict handling,
 * card settling, and the approval announcement.
 *
 * database/homeTime, config, and telegramHtml are mocked; the real cards +
 * date-resolver modules are used so the actual Telegram card text is exercised.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');

// Dates are relative to "now" so the past-window guard (which uses the real
// clock) always sees a still-actionable request. A hardcoded window silently
// becomes a time bomb: the original fixture ended 2026-07-24 and every approve
// test began failing the moment that date passed. Mirrors the approach in
// tests/helpers/homeTimeRequestServiceHarness.js.
const TODAY = DateTime.now().setZone('America/Chicago');
const HOME_FROM = TODAY.plus({ days: 3 }).toISODate();
const HOME_TO = TODAY.plus({ days: 6 }).toISODate();
const RETURN_TO_ROAD = TODAY.plus({ days: 7 }).toISODate();
// Comfortably past the whole window — used to exercise the outdated guard.
const AFTER_WINDOW = TODAY.plus({ days: 30 }).toISODate();

const PENDING = {
  id: 5,
  status: 'pending',
  driver_name: 'Pascal F',
  unit_number: '96266',
  home_from: HOME_FROM,
  home_to: HOME_TO,
  return_to_road_date: RETURN_TO_ROAD,
  telegram_chat_id: '-100200300',
  telegram_message_id: 42,
};

function load({ request = PENDING, decideReturnsNull = false, employeeGroupId = '-100EMPLOYEE' } = {}) {
  const approvalPath = require.resolve('../services/homeTimeApproval');
  const htPath = require.resolve('../database/homeTime');
  const configPath = require.resolve('../config/config');
  const htmlPath = require.resolve('../services/telegramHtml');
  for (const p of [approvalPath, htPath, configPath, htmlPath]) delete require.cache[p];

  const calls = { getById: [], decide: [] };
  require.cache[htPath] = {
    exports: {
      async getHomeTimeRequestById(id) { calls.getById.push(id); return request; },
      async decideHomeTimeRequest(id, patch) {
        calls.decide.push({ id, patch });
        if (decideReturnsNull) return null;
        return {
          ...request,
          status: patch.status,
          decided_by_username: patch.username,
          decided_by_user_id: patch.userId,
          decided_at: '2026-07-15T12:00:00.000Z',
        };
      },
    },
  };
  require.cache[configPath] = { exports: { employeeGroupId } };
  require.cache[htmlPath] = { exports: { safeSend: async (fn) => fn() } };

  const mod = require(approvalPath);
  const edits = [];
  const sends = [];
  const telegram = {
    async editMessageText(...args) { edits.push(args); },
    async sendMessage(...args) { sends.push(args); },
  };
  return { mod, calls, telegram, edits, sends };
}

// ── approve ──

test('approve: decides, settles the card (via admin), announces, records the admin', async () => {
  const { mod, calls, telegram, edits, sends } = load();
  const result = await mod.applyHomeTimeDecision(telegram, 5, {
    decision: 'approve', decidedByUsername: 'adminboss', decidedByUserId: null, via: 'admin',
  });
  assert.equal(result.ok, true);
  assert.equal(result.request.status, 'approved');
  // Atomic decide called with the admin identity.
  assert.equal(calls.decide.length, 1);
  assert.equal(calls.decide[0].patch.status, 'approved');
  assert.equal(calls.decide[0].patch.username, 'adminboss');
  // Card edited in place (chat id + message id), buttons dropped (no reply_markup).
  assert.equal(edits.length, 1);
  assert.equal(edits[0][0], '-100200300');
  assert.equal(edits[0][1], 42);
  assert.match(edits[0][3], /Approved/);
  assert.match(edits[0][3], /via the admin panel/);
  assert.equal(edits[0][4].reply_markup, undefined);
  // Approval announced to the employee group.
  assert.equal(sends.length, 1);
  assert.match(sends[0][1], /Home Time Approved/);
});

test('approve via telegram does NOT label the card as admin', async () => {
  const { mod, telegram, edits } = load();
  await mod.applyHomeTimeDecision(telegram, 5, { decision: 'approved', decidedByUsername: 'mgr', via: 'telegram' });
  assert.match(edits[0][3], /Approved/);
  assert.doesNotMatch(edits[0][3], /via the admin panel/);
});

// ── decline ──

test('decline: decides + settles the card but sends NO approval announcement', async () => {
  const { mod, calls, telegram, edits, sends } = load();
  const result = await mod.applyHomeTimeDecision(telegram, 5, {
    decision: 'decline', decidedByUsername: 'adminboss', via: 'admin',
  });
  assert.equal(result.ok, true);
  assert.equal(result.request.status, 'denied');
  assert.equal(calls.decide[0].patch.status, 'denied');
  assert.match(edits[0][3], /Not approved/);
  assert.equal(sends.length, 0, 'a decline never announces an approval');
});

// ── date validation (approval only) ──

test('approve is blocked when the return date is missing', async () => {
  const { mod, calls, telegram, edits } = load({
    request: { ...PENDING, return_to_road_date: null, home_to: null },
  });
  const result = await mod.applyHomeTimeDecision(telegram, 5, { decision: 'approve', via: 'admin' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_dates');
  assert.equal(calls.decide.length, 0, 'never decides with invalid dates');
  assert.equal(edits.length, 0);
});

test('approve is blocked when the return date is on/before the arrive-home date', async () => {
  const bad = load({
    request: { ...PENDING, return_to_road_date: HOME_FROM, home_to: TODAY.plus({ days: 2 }).toISODate() },
  });
  const r = await bad.mod.applyHomeTimeDecision(bad.telegram, 5, { decision: 'approve', via: 'admin' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid_dates');
});

test('decline is allowed even without valid dates', async () => {
  const { mod, calls, telegram } = load({ request: { ...PENDING, return_to_road_date: null, home_to: null } });
  const result = await mod.applyHomeTimeDecision(telegram, 5, { decision: 'decline', via: 'admin' });
  assert.equal(result.ok, true);
  assert.equal(calls.decide[0].patch.status, 'denied');
});

// ── outdated window (approval only) ──

test('approve is blocked when the whole home-time window is already in the past', async () => {
  const { mod, calls, telegram, edits } = load();
  const result = await mod.applyHomeTimeDecision(telegram, 5, {
    decision: 'approve', decidedByUsername: 'adminboss', via: 'admin', todayIso: AFTER_WINDOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'outdated');
  assert.equal(calls.decide.length, 0, 'an outdated request is never approved');
  assert.equal(edits.length, 0);
});

test('an outdated request can still be DECLINED', async () => {
  const { mod, calls, telegram } = load();
  const result = await mod.applyHomeTimeDecision(telegram, 5, {
    decision: 'decline', decidedByUsername: 'adminboss', via: 'admin', todayIso: AFTER_WINDOW,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.decide[0].patch.status, 'denied');
});

// ── already decided / conflict / not found ──

test('a non-pending request is reported as already decided (no second decision)', async () => {
  const { mod, calls, telegram } = load({ request: { ...PENDING, status: 'approved' } });
  const result = await mod.applyHomeTimeDecision(telegram, 5, { decision: 'approve', via: 'admin' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'already_decided');
  assert.equal(result.request.status, 'approved');
  assert.equal(calls.decide.length, 0);
});

test('a lost atomic race is reported as a conflict', async () => {
  const { mod, telegram } = load({ decideReturnsNull: true });
  const result = await mod.applyHomeTimeDecision(telegram, 5, { decision: 'approve', via: 'admin' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'conflict');
});

test('a missing request is reported as not found', async () => {
  const { mod, telegram } = load({ request: null });
  const result = await mod.applyHomeTimeDecision(telegram, 5, { decision: 'approve', via: 'admin' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not_found');
});

test('an unknown decision is rejected before any DB read', async () => {
  const { mod, calls, telegram } = load();
  const result = await mod.applyHomeTimeDecision(telegram, 5, { decision: 'maybe', via: 'admin' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_decision');
  assert.equal(calls.getById.length, 0);
});

// ── telegram optionality ──

test('with no telegram instance the decision still succeeds (card + announce skipped)', async () => {
  const { mod, calls } = load();
  const result = await mod.applyHomeTimeDecision(null, 5, { decision: 'approve', via: 'admin' });
  assert.equal(result.ok, true);
  assert.equal(calls.decide.length, 1);
});

test('a request with no stored card is decided without a card edit (announce still fires)', async () => {
  const { mod, telegram, edits, sends } = load({
    request: { ...PENDING, telegram_chat_id: null, telegram_message_id: null },
  });
  const result = await mod.applyHomeTimeDecision(telegram, 5, { decision: 'approve', via: 'admin' });
  assert.equal(result.ok, true);
  assert.equal(edits.length, 0, 'no card to settle');
  assert.equal(sends.length, 1, 'approval still announced');
});

// ── canApproveWindow (pure) ──

test('canApproveWindow: needs a start + a return strictly after it', () => {
  const { mod } = load();
  assert.equal(mod.canApproveWindow({ home_from: '2026-07-20', return_to_road_date: '2026-07-24' }), true);
  assert.equal(mod.canApproveWindow({ home_from: '2026-07-20', home_to: '2026-07-23' }), true); // return derived
  assert.equal(mod.canApproveWindow({ home_from: '2026-07-20', return_to_road_date: '2026-07-20' }), false);
  assert.equal(mod.canApproveWindow({ home_from: null, return_to_road_date: '2026-07-24' }), false);
  assert.equal(mod.canApproveWindow({ home_from: '2026-07-20' }), false);
});
