/**
 * Home time is a CENTRAL-TIME business concept — regression tests.
 *
 * Every date in this subsystem (`todayIsoChicago`, homeTimeDateResolver's `TZ`,
 * every AI prompt's "Today is X (America/Chicago)") is a Central calendar date.
 * Turning a UTC instant into a date WITHOUT a zone uses the process default
 * instead, which is UTC in production on Render. A driver arriving home after
 * 19:00 Central then had TOMORROW recorded as their home start, shifting the
 * whole window — and the home-time bonus math that reads it — by one day.
 *
 * These tests pin the INSTANT rather than trusting the wall clock, so they fail
 * on the unzoned form no matter what time the suite runs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');
const { TODAY, GROUP, loadService } = require('./helpers/homeTimeRequestServiceHarness');

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

test('a late-evening home arrival records TODAY in Central, not tomorrow in UTC', async () => {
  const { service, telegram, inserts } = loadService({
    open: null,
    homeStatus: { state: 'home', state_since: LATE_TONIGHT_ISO },
    gemini: { text: new Error('force fallback') },
  });
  await service.handleActualHomeArrival(
    telegram,
    GROUP,
    { message_id: 77, text: 'Status: Home', from: { id: 900 } },
    { homeStartIso: LATE_TONIGHT_ISO }
  );
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].homeFrom, TODAY.toISODate());
});

test('a late-evening arrival with no explicit start uses the MESSAGE time in Central', async () => {
  const { service, telegram, inserts } = loadService({
    open: null,
    homeStatus: { state: 'home', state_since: LATE_TONIGHT_ISO },
    gemini: { text: new Error('force fallback') },
  });
  await service.handleActualHomeArrival(
    telegram,
    GROUP,
    // No homeStartIso → the service falls back to the Telegram message's own date.
    { message_id: 78, text: 'Status: Home', from: { id: 900 }, date: Math.floor(LATE_TONIGHT.toSeconds()) },
    {}
  );
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].homeFrom, TODAY.toISODate());
});

test('a late-evening arrival completes an awaiting_home_start window on the Central date', async () => {
  const returnDate = TODAY.plus({ days: 5 }).toISODate();
  const { service, telegram, fulfills } = loadService({
    open: {
      id: 31, status: 'awaiting_home_start', home_from: null,
      return_to_road_date: returnDate, language: 'en',
    },
    homeStatus: { state: 'home', state_since: LATE_TONIGHT_ISO },
    gemini: { text: new Error('force fallback') },
  });
  await service.handleActualHomeArrival(
    telegram,
    GROUP,
    { message_id: 79, text: 'Status: Home', from: { id: 900 } },
    { homeStartIso: LATE_TONIGHT_ISO }
  );
  assert.equal(fulfills.length, 1, `expected the window to be completed; saw ${JSON.stringify(fulfills)}`);
  assert.equal(fulfills[0].payload.homeFrom, TODAY.toISODate());
  assert.equal(fulfills[0].payload.returnToRoadDate, returnDate);
});
