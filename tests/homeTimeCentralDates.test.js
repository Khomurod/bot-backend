'use strict';

/**
 * Home time is a CENTRAL-TIME business concept — regression tests.
 *
 * Every date in this subsystem (`todayIsoChicago`, homeTimeDateResolver's `TZ`,
 * every AI prompt's "Today is X (America/Chicago)") is a Central calendar date.
 * Turning a UTC instant into a date WITHOUT a zone uses the process default
 * instead, which is UTC in production on Render. A driver reaching home after
 * 19:00 Central then had TOMORROW's date reported and swept against, shifting
 * the window — and the home-time bonus math that reads it — by one day.
 *
 * WHAT THESE TESTS COVER NOW. The clarification loop that once carried this
 * hazard is gone: Wenze no longer asks a driver for planned dates, so there is
 * no `handleActualHomeArrival` insert to mis-date. The same hazard still lives
 * in the two Central-date derivations that survived, and both are pinnable:
 *
 *   - the manager notice, which prints the dates three managers read;
 *   - the housekeeping sweep, which decides whether a request's window has
 *     passed.
 *
 * Both are driven from an INSTANT the test supplies rather than the wall clock,
 * so they fail on the unzoned form no matter what time the suite runs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DateTime } = require('luxon');
const { TODAY } = require('./helpers/homeTimeRequestServiceHarness');
const { shortDate } = require('../lib/homeTime/managerNotice');

// 23:30 Central today: the same instant is ALREADY TOMORROW in UTC, so an
// unzoned `.toISODate()` yields tomorrow's date and a zoned one yields today's.
const LATE_TONIGHT = TODAY.startOf('day').plus({ hours: 23, minutes: 30 });
const LATE_TONIGHT_ISO = LATE_TONIGHT.toUTC().toISO();

test('the fixture really does straddle midnight UTC (guards the tests below)', () => {
  assert.notEqual(
    DateTime.fromISO(LATE_TONIGHT_ISO).toUTC().toISODate(),
    TODAY.toISODate(),
    'a late-evening Central instant must fall on the NEXT UTC date'
  );
});

test('a manager notice prints the CENTRAL date of a late-evening instant', () => {
  assert.equal(
    shortDate(LATE_TONIGHT_ISO),
    TODAY.toFormat('LLL d'),
    'the three managers read the company day, not the UTC one'
  );
});

test('a bare ISO date in a notice is read as a calendar date, never shifted', () => {
  const plain = TODAY.toISODate();
  assert.equal(shortDate(plain), TODAY.toFormat('LLL d'),
    'a stored home_from is already a Central calendar date and must not be re-zoned');
});

test('the housekeeping sweep judges a window against TODAY in Central', async () => {
  const htPath = path.resolve(__dirname, '../database/homeTime.js');
  const approvalPath = path.resolve(__dirname, '../services/homeTimeApproval.js');
  const servicePath = path.resolve(__dirname, '../services/homeTimeReminderService.js');
  for (const p of [htPath, approvalPath, servicePath]) delete require.cache[p];

  require.cache[htPath] = {
    exports: { async getHomeTimeSettings() { return { enabled: true }; } },
  };
  const sweeps = [];
  require.cache[approvalPath] = {
    exports: {
      async sweepOutdatedHomeTimeRequests(_telegram, opts) {
        sweeps.push(opts);
        return { scanned: 0, closed: 0 };
      },
    },
  };

  try {
    const service = require(servicePath);
    const out = await service.runHomeTimeCleanupSweep({}, { nowIso: LATE_TONIGHT_ISO });
    assert.equal(sweeps.length, 1);
    assert.equal(sweeps[0].todayIso, TODAY.toISODate(),
      'at 23:30 Central the sweep must still be working on today, not tomorrow');
    assert.deepEqual(out, { enabled: true, scanned: 0, closed: 0 });
  } finally {
    for (const p of [htPath, approvalPath, servicePath]) delete require.cache[p];
  }
});
