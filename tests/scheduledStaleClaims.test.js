'use strict';

/**
 * A scheduled message a dead process claimed and never released.
 *
 * One weekly PTI reminder sat in `processing` from May to October 2026: it was
 * claimed, the process went away mid-send, and nothing ever looked at it again.
 * These pin the release rules — and above all that releasing NEVER sends, since
 * the dead send may already have reached some groups.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DateTime } = require('luxon');

const {
  decideStaleClaim, STALE_CLAIM_MINUTES, WEEKLY_RESUME_WITHIN_DAYS,
} = require('../services/scheduledMessageUtils');

// A Wednesday, so the next Monday 09:00 Chicago is unambiguous.
const NOW = DateTime.fromISO('2026-10-21T15:00:00Z');
const WEEKLY = {
  id: 9, schedule_type: 'weekly', weekly_day_of_week: 1, weekly_time_local: '09:00',
  schedule_timezone: 'America/Chicago',
};

test('a weekly message that missed one run carries on at its NEXT time, not now', () => {
  const out = decideStaleClaim({ ...WEEKLY, days_overdue: 2 }, { now: NOW });
  assert.equal(out.action, 'reschedule');
  // Monday 2026-10-26 09:00 CDT is 14:00 UTC — next week, so nobody is sent
  // this week's message twice.
  assert.equal(out.nextAt, '2026-10-26T14:00:00.000Z');
});

test('A WEEKLY MESSAGE STUCK FOR WEEKS IS FAILED, NOT QUIETLY RESTARTED', () => {
  // The May reminder: restarting it would have every driver receive a
  // message nobody had seen go out in five months, with nobody deciding to.
  const out = decideStaleClaim({ ...WEEKLY, days_overdue: 168 }, { now: NOW });
  assert.equal(out.action, 'fail');
  assert.match(out.reason, /more than a week/);
  assert.equal(decideStaleClaim({ ...WEEKLY, days_overdue: WEEKLY_RESUME_WITHIN_DAYS + 0.1 }, { now: NOW }).action, 'fail');
  assert.equal(decideStaleClaim({ ...WEEKLY, days_overdue: WEEKLY_RESUME_WITHIN_DAYS }, { now: NOW }).action, 'reschedule');
});

test('a one-time message is failed for a person to resend — never sent again from here', () => {
  const out = decideStaleClaim({ id: 3, schedule_type: 'one_time', days_overdue: 0.2 }, { now: NOW });
  assert.equal(out.action, 'fail');
  assert.equal(decideStaleClaim({ id: 3, days_overdue: 0.2 }, { now: NOW }).action, 'fail',
    'a missing schedule_type is one-time, as everywhere else');
});

test('an unreadable schedule or age fails rather than guessing a time', () => {
  assert.equal(decideStaleClaim({ ...WEEKLY, weekly_time_local: '25:00', days_overdue: 1 }, { now: NOW }).action, 'fail');
  assert.equal(decideStaleClaim({ ...WEEKLY, days_overdue: 'soon' }, { now: NOW }).action, 'fail');
});

test('two hours past its time is dead, not slow', () => {
  assert.equal(STALE_CLAIM_MINUTES, 120);
});

// ── the pass ────────────────────────────────────────────────────────────────

function loadScheduler(dbMock) {
  const schedulerPath = path.resolve(__dirname, '../services/schedulerService.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const botPath = path.resolve(__dirname, '../bot/bot.js');
  for (const p of [schedulerPath, dbPath, botPath]) delete require.cache[p];
  require.cache[dbPath] = { exports: dbMock };
  require.cache[botPath] = { exports: { sendBroadcastToGroups: async () => { throw new Error('must not send'); } } };
  // eslint-disable-next-line global-require
  return require(schedulerPath);
}

test('the pass releases each stuck row by its own rule, and sends nothing', async () => {
  const released = [];
  const store = {
    async listStaleClaims({ olderThanMinutes }) {
      assert.equal(olderThanMinutes, STALE_CLAIM_MINUTES);
      return [
        { ...WEEKLY, id: 1, days_overdue: 1 },
        { ...WEEKLY, id: 2, days_overdue: 90 },
        { id: 3, schedule_type: 'one_time', days_overdue: 0.5 },
      ];
    },
    async releaseStaleClaim(id, opts) { released.push({ id, ...opts }); return true; },
  };
  const scheduler = loadScheduler(store);
  const out = await scheduler.recoverStaleClaims({ store });

  assert.deepEqual(out, { rescheduled: 1, failed: 2 });
  assert.ok(released[0].nextScheduledAt, 'the recent weekly one carries on');
  assert.equal(released[1].nextScheduledAt, null, 'the months-old weekly one is failed');
  assert.equal(released[2].nextScheduledAt, null, 'the one-time one is failed');
});

test('a row whose own send finished first is left alone and not counted', async () => {
  const store = {
    async listStaleClaims() { return [{ ...WEEKLY, id: 1, days_overdue: 1 }]; },
    async releaseStaleClaim() { return false; },
  };
  const scheduler = loadScheduler(store);
  assert.deepEqual(await scheduler.recoverStaleClaims({ store }), { rescheduled: 0, failed: 0 });
});
