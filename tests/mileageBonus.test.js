const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');

const {
  normalizeDriverName,
  isAccountingUsername,
  toMiles,
  computePayPeriodEnd,
  mostRecentScheduledRun,
  driverPeriodStart,
  tiersReached,
  nextTier,
  PROGRAM_START_ISO,
  SCHEDULE_TIMEZONE,
} = require('../services/mileageBonusConstants');

const {
  buildBonusCardText,
  buildDecidedCardText,
  buildRejectionFollowupText,
} = require('../services/mileageBonusMessages');

test('normalizeDriverName uppercases and strips punctuation/suffixes', () => {
  assert.equal(normalizeDriverName('Mesele Abraha FETWI'), 'MESELE ABRAHA FETWI');
  assert.equal(normalizeDriverName('DENIS MAXIMOV (A2B Transportation LLC)'), 'DENIS MAXIMOV A2B TRANSPORTATION');
  assert.equal(normalizeDriverName('Clyde Lee Jr. Mallett'), 'CLYDE LEE MALLETT');
  assert.equal(normalizeDriverName('  '), '');
});

test('isAccountingUsername matches only the two accounting users (case/@ insensitive)', () => {
  assert.equal(isAccountingUsername('cameron_acc'), true);
  assert.equal(isAccountingUsername('@Cameron_Acc'), true);
  assert.equal(isAccountingUsername('Ellaaccounting'), true);
  assert.equal(isAccountingUsername('@ellaAccounting'), true);
  assert.equal(isAccountingUsername('tomr_robins0n'), false);
  assert.equal(isAccountingUsername(''), false);
  assert.equal(isAccountingUsername(null), false);
});

test('toMiles parses decimal strings and tolerates junk', () => {
  assert.equal(toMiles('574.31'), 574.31);
  assert.equal(toMiles('1,234.5'), 1234.5);
  assert.equal(toMiles(null), 0);
  assert.equal(toMiles('abc'), 0);
});

test('computePayPeriodEnd returns the Sunday two weeks behind', () => {
  // Thursday 2026-06-18 -> period end Sunday 2026-06-07.
  const ref = DateTime.fromISO('2026-06-18T14:00:00', { zone: SCHEDULE_TIMEZONE });
  const end = computePayPeriodEnd(ref);
  assert.equal(end.toISODate(), '2026-06-07');
  assert.equal(end.weekday, 7); // Sunday
  assert.equal(end.hour, 23);
});

test('computePayPeriodEnd is consistent across a Sunday-based week', () => {
  // Sunday 2026-06-14 starts the same week as Thursday 2026-06-18, so both
  // resolve to the prior week's Sunday, 2026-06-07.
  const ref = DateTime.fromISO('2026-06-14T09:00:00', { zone: SCHEDULE_TIMEZONE });
  assert.equal(computePayPeriodEnd(ref).toISODate(), '2026-06-07');
  // Saturday 2026-06-13 is in the previous week -> 2026-05-31.
  const sat = DateTime.fromISO('2026-06-13T09:00:00', { zone: SCHEDULE_TIMEZONE });
  assert.equal(computePayPeriodEnd(sat).toISODate(), '2026-05-31');
});

test('mostRecentScheduledRun resolves to the latest Wednesday 07:00 Central', () => {
  // Thursday 2026-06-18 -> most recent scheduled run Wed 2026-06-17 07:00.
  const thu = DateTime.fromISO('2026-06-18T14:00:00', { zone: SCHEDULE_TIMEZONE });
  const run = mostRecentScheduledRun(thu);
  assert.equal(run.toISODate(), '2026-06-17');
  assert.equal(run.weekday, 3);
  assert.equal(run.hour, 7);

  // Tuesday before 07:00 -> previous week's Wednesday.
  const tue = DateTime.fromISO('2026-06-16T05:00:00', { zone: SCHEDULE_TIMEZONE });
  assert.equal(mostRecentScheduledRun(tue).toISODate(), '2026-06-10');

  // Wednesday at 06:59 -> still last week's Wednesday (run is 07:00).
  const wedEarly = DateTime.fromISO('2026-06-17T06:59:00', { zone: SCHEDULE_TIMEZONE });
  assert.equal(mostRecentScheduledRun(wedEarly).toISODate(), '2026-06-10');
});

test('driverPeriodStart floors at program start but honors later hire dates', () => {
  assert.equal(driverPeriodStart(null).toISODate(), PROGRAM_START_ISO);
  assert.equal(driverPeriodStart('2026-01-01').toISODate(), PROGRAM_START_ISO);
  assert.equal(driverPeriodStart('2026-05-20').toISODate(), '2026-05-20');
});

test('tiersReached and nextTier reflect cumulative milestones', () => {
  assert.deepEqual(tiersReached(5000), []);
  assert.deepEqual(tiersReached(10000).map((t) => t.miles), [10000]);
  assert.deepEqual(tiersReached(45000).map((t) => t.miles), [10000, 40000]);
  assert.equal(nextTier(45000).miles, 100000);
  assert.equal(nextTier(5000).miles, 10000);
  assert.equal(nextTier(250000), null);
});

test('buildBonusCardText includes driver, milestone, bonus and accounting tags', () => {
  const text = buildBonusCardText({
    driver_name: 'John <Doe>',
    threshold_miles: 40000,
    bonus_amount: 500,
    miles_at_notification: 41234.5,
    period_start: '2026-04-17',
    period_end: '2026-06-07',
  });
  assert.match(text, /John &lt;Doe&gt;/); // HTML-escaped
  assert.match(text, /40,000 miles/);
  assert.match(text, /\$500/);
  assert.match(text, /41,235/); // rounded miles
  assert.match(text, /@cameron_acc/);
  assert.match(text, /@Ellaaccounting/);
});

test('buildDecidedCardText shows paid/rejected footer with the decider', () => {
  const record = {
    driver_name: 'Jane Smith',
    threshold_miles: 10000,
    bonus_amount: 200,
    miles_at_notification: 10500,
    period_start: '2026-04-17',
    period_end: '2026-06-07',
  };
  assert.match(buildDecidedCardText(record, 'paid', 'cameron_acc'), /✅ <b>Paid<\/b> — confirmed by @cameron_acc/);
  assert.match(buildDecidedCardText(record, 'rejected', '@Ellaaccounting'), /❌ <b>Rejected in Pay<\/b> — by @Ellaaccounting/);
});

test('buildRejectionFollowupText tags the escalation users', () => {
  const text = buildRejectionFollowupText(
    { driver_name: 'Jane Smith', threshold_miles: 10000, bonus_amount: 200 },
    'cameron_acc'
  );
  assert.match(text, /Rejected in Pay/);
  assert.match(text, /@tomr_robins0n/);
  assert.match(text, /@SaffieBNett/);
});
