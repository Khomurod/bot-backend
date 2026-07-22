/**
 * Outdated / stale home-time request handling.
 *   Part A: the pure predicates (isHomeTimeWindowInPast, isHomeTimeRequestOutdated).
 *   Part B: the sweep + single-request expiry (services/homeTimeApproval), with the
 *           expiry DB layer + config + telegram mocked.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isHomeTimeWindowInPast,
  isHomeTimeRequestOutdated,
} = require('../services/homeTimeDateResolver');

const TODAY = '2026-07-13';

// ── Part A: pure predicates ──

test('isHomeTimeWindowInPast: true once the return date is before today', () => {
  assert.equal(isHomeTimeWindowInPast({ home_from: '2026-07-01', return_to_road_date: '2026-07-05' }, TODAY), true);
  assert.equal(isHomeTimeWindowInPast({ home_from: '2026-07-10', return_to_road_date: '2026-07-20' }, TODAY), false);
  // Derives the end from last-day-home + 1 when no explicit return date.
  assert.equal(isHomeTimeWindowInPast({ home_from: '2026-07-01', home_to: '2026-07-04' }, TODAY), true);
  // No end date known → not decidable as "in the past".
  assert.equal(isHomeTimeWindowInPast({ home_from: '2026-07-01' }, TODAY), false);
});

test('outdated: a pending request whose dates have passed', () => {
  assert.equal(
    isHomeTimeRequestOutdated({ status: 'pending', home_from: '2026-07-01', return_to_road_date: '2026-07-05' }, { todayIso: TODAY }),
    true,
  );
});

test('NOT outdated: a pending request whose window is still current/future', () => {
  assert.equal(
    isHomeTimeRequestOutdated({ status: 'pending', home_from: '2026-07-12', return_to_road_date: '2026-07-20' }, { todayIso: TODAY }),
    false,
  );
});

test('outdated: an awaiting clarification that already carries a past return date', () => {
  assert.equal(
    isHomeTimeRequestOutdated({ status: 'awaiting_home_start', return_to_road_date: '2026-07-02' }, { todayIso: TODAY }),
    true,
  );
});

test('NOT outdated: an active clarification with reminders still pending', () => {
  assert.equal(
    isHomeTimeRequestOutdated({
      status: 'awaiting_return_to_road', home_from: '2026-05-01',
      next_reminder_at: '2026-07-13T18:00:00Z', requested_at: '2026-05-01T00:00:00Z',
    }, { todayIso: TODAY }),
    false,
  );
});

test('outdated: a stale clarification — reminders exhausted and long open', () => {
  assert.equal(
    isHomeTimeRequestOutdated({
      status: 'clarification_unanswered', home_from: '2026-05-01',
      next_reminder_at: null, requested_at: '2026-05-01T00:00:00Z',
    }, { todayIso: TODAY }),
    true,
  );
});

test('NOT outdated: a recent unanswered clarification with no dates yet', () => {
  assert.equal(
    isHomeTimeRequestOutdated({
      status: 'awaiting_dates', next_reminder_at: null, requested_at: '2026-07-10T00:00:00Z',
    }, { todayIso: TODAY }),
    false,
  );
});

test('outdated: an old dateless clarification once reminders are done', () => {
  assert.equal(
    isHomeTimeRequestOutdated({
      status: 'awaiting_dates', next_reminder_at: null, requested_at: '2026-05-01T00:00:00Z',
    }, { todayIso: TODAY }),
    true,
  );
});

test('terminal statuses are never "outdated" (already resolved history)', () => {
  for (const status of ['approved', 'denied', 'cancelled', 'expired']) {
    assert.equal(
      isHomeTimeRequestOutdated({ status, home_from: '2026-07-01', return_to_road_date: '2026-07-05' }, { todayIso: TODAY }),
      false,
      `${status} must not be outdated`,
    );
  }
});

test('predicates never mutate the request (history preserved)', () => {
  const req = Object.freeze({ status: 'pending', home_from: '2026-07-01', return_to_road_date: '2026-07-05' });
  assert.equal(isHomeTimeRequestOutdated(req, { todayIso: TODAY }), true); // would throw if it mutated
});

// ── Part B: sweep + single-request expiry ──

function loadApproval({ open = [] } = {}) {
  const approvalPath = require.resolve('../services/homeTimeApproval');
  const configPath = require.resolve('../config/config');
  const htPath = require.resolve('../database/homeTime');
  const htExpiryPath = require.resolve('../database/homeTimeExpiry');
  const htmlPath = require.resolve('../services/telegramHtml');
  for (const p of [approvalPath, configPath, htPath, htExpiryPath, htmlPath]) delete require.cache[p];

  const expired = [];
  require.cache[configPath] = { exports: { employeeGroupId: '' } };
  require.cache[htPath] = { exports: {} }; // ht not used by the sweep path
  require.cache[htExpiryPath] = {
    exports: {
      async listOpenHomeTimeRequests() { return open; },
      async expireOutdatedHomeTimeRequest(id) {
        expired.push(id);
        const row = open.find((r) => r.id === id);
        return row ? { ...row, status: 'expired', next_reminder_at: null } : null;
      },
    },
  };
  require.cache[htmlPath] = { exports: { safeSend: async (fn) => fn() } };

  const mod = require(approvalPath);
  const edits = [];
  const telegram = { async editMessageText(...args) { edits.push(args); } };
  return { mod, telegram, expired, edits };
}

const CARD = { telegram_chat_id: '-100999', telegram_message_id: 7 };

test('sweep expires only the outdated requests and settles their cards', async () => {
  const open = [
    { id: 1, status: 'pending', driver_name: 'A', home_from: '2026-07-01', home_to: '2026-07-04', return_to_road_date: '2026-07-05', ...CARD }, // past → expire
    { id: 2, status: 'pending', home_from: '2026-07-12', return_to_road_date: '2026-07-20' }, // future → keep
    { id: 3, status: 'clarification_unanswered', home_from: '2026-05-01', next_reminder_at: null, requested_at: '2026-05-01T00:00:00Z' }, // stale → expire
    { id: 4, status: 'awaiting_dates', next_reminder_at: '2026-07-13T18:00:00Z', requested_at: '2026-07-12T00:00:00Z' }, // active → keep
  ];
  const { mod, telegram, expired, edits } = loadApproval({ open });
  const summary = await mod.sweepOutdatedHomeTimeRequests(telegram, { todayIso: TODAY });
  assert.deepEqual(expired.sort(), [1, 3]);
  assert.deepEqual(summary, { scanned: 4, expired: 2 });
  // Only #1 had a stored card → exactly one card edit, showing the expiry.
  assert.equal(edits.length, 1);
  assert.equal(edits[0][0], '-100999');
  assert.match(edits[0][3], /Expired — No Action/);
  assert.equal(edits[0][4].reply_markup, undefined);
});

test('expireOutdatedRequest edits the card when present and returns the expired row', async () => {
  const request = { id: 1, status: 'pending', driver_name: 'A', home_from: '2026-07-01', home_to: '2026-07-04', ...CARD };
  const { mod, telegram, expired, edits } = loadApproval({ open: [request] });
  const row = await mod.expireOutdatedRequest(telegram, request);
  assert.equal(row.status, 'expired');
  assert.deepEqual(expired, [1]);
  assert.equal(edits.length, 1);
  assert.match(edits[0][3], /Expired — No Action/);
});

test('expireOutdatedRequest without a card does not edit anything', async () => {
  const request = { id: 9, status: 'awaiting_dates' };
  const { mod, telegram, edits } = loadApproval({ open: [request] });
  const row = await mod.expireOutdatedRequest(telegram, request);
  assert.equal(row.status, 'expired');
  assert.equal(edits.length, 0);
});

test('expireOutdatedRequest returns null when the row was already changed', async () => {
  const { mod, telegram, edits } = loadApproval({ open: [] }); // expire returns null (id not found)
  const row = await mod.expireOutdatedRequest(telegram, { id: 123, ...CARD });
  assert.equal(row, null);
  assert.equal(edits.length, 0, 'no card edit when nothing was expired');
});
