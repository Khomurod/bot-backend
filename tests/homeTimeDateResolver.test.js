const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeHomeTimeWindow, statusForMissingFields, computeHomeDays,
  lastDayHomeFromReturn, returnFromLastDayHome, isReasonableWindow,
  resolveRequestReturnDate, isUsableKnownReturnDate, isoDateOnly,
} = require('../services/homeTimeDateResolver');

// §3 / §8 — the canonical date model. home_from = arrive home; return_to_road =
// leave home; last day home = return − 1; homeDays = return − start.

test('Monday home to Friday road = 4 home days (Mon..Thu)', () => {
  const w = normalizeHomeTimeWindow({ homeStart: '2026-07-13', returnToRoad: '2026-07-17' });
  assert.equal(w.homeStartDate, '2026-07-13');
  assert.equal(w.returnToRoadDate, '2026-07-17');
  assert.equal(w.lastDayHome, '2026-07-16'); // Thursday
  assert.equal(w.homeTo, '2026-07-16');
  assert.equal(w.homeDays, 4);
  assert.equal(w.complete, true);
  assert.deepEqual(w.missingFields, []);
});

test('range given as last day home ("Monday through Thursday") → return Friday, 4 days', () => {
  const w = normalizeHomeTimeWindow({ homeStart: '2026-07-13', lastDayHome: '2026-07-16' });
  assert.equal(w.returnToRoadDate, '2026-07-17');
  assert.equal(w.homeDays, 4);
});

test('start only → return stays null, missing return_to_road (never dup)', () => {
  const w = normalizeHomeTimeWindow({ homeStart: '2026-07-13' });
  assert.equal(w.returnToRoadDate, null);
  assert.equal(w.homeDays, null);
  assert.deepEqual(w.missingFields, ['return_to_road']);
  assert.equal(w.complete, false);
});

test('return only with a KNOWN home start completes the window', () => {
  const w = normalizeHomeTimeWindow({ returnToRoad: '2026-07-17', knownHomeStart: '2026-07-13' });
  assert.equal(w.homeStartDate, '2026-07-13');
  assert.equal(w.homeDays, 4);
  assert.equal(w.complete, true);
});

test('duration + start computes the return correctly ("home Monday for 4 days")', () => {
  const w = normalizeHomeTimeWindow({ homeStart: '2026-07-13', durationDays: 4 });
  assert.equal(w.returnToRoadDate, '2026-07-17');
  assert.equal(w.homeDays, 4);
});

test('duration + return computes the start ("back Friday, need 4 days")', () => {
  const w = normalizeHomeTimeWindow({ returnToRoad: '2026-07-17', durationDays: 4 });
  assert.equal(w.homeStartDate, '2026-07-13');
  assert.equal(w.homeDays, 4);
});

test('a single date is NEVER copied into both ends (start==return collapses)', () => {
  const w = normalizeHomeTimeWindow({ homeStart: '2026-07-13', returnToRoad: '2026-07-13' });
  assert.equal(w.returnToRoadDate, null);
  assert.deepEqual(w.missingFields, ['return_to_road']);
});

test('a return before the start is discarded rather than fabricated', () => {
  const w = normalizeHomeTimeWindow({ homeStart: '2026-07-13', returnToRoad: '2026-07-10' });
  assert.equal(w.returnToRoadDate, null);
});

test('missing home start only → awaiting_home_start; missing return → awaiting_return_to_road', () => {
  assert.equal(statusForMissingFields(['home_start']), 'awaiting_home_start');
  assert.equal(statusForMissingFields(['return_to_road']), 'awaiting_return_to_road');
  assert.equal(statusForMissingFields(['home_start', 'return_to_road']), 'awaiting_dates');
  assert.equal(statusForMissingFields([]), 'pending');
});

test('date derivation helpers are consistent', () => {
  assert.equal(computeHomeDays('2026-07-13', '2026-07-17'), 4);
  assert.equal(lastDayHomeFromReturn('2026-07-17'), '2026-07-16');
  assert.equal(returnFromLastDayHome('2026-07-16'), '2026-07-17');
});

// §4 — reuse an already-known return date instead of re-asking the driver.

test('isoDateOnly extracts a plain date from a string, a JS Date (UTC, no shift), or ISO datetime', () => {
  assert.equal(isoDateOnly('2026-07-17'), '2026-07-17');
  assert.equal(isoDateOnly('2026-07-17T13:45:00Z'), '2026-07-17');
  assert.equal(isoDateOnly(new Date('2026-07-17T00:00:00Z')), '2026-07-17'); // no TZ off-by-one
  assert.equal(isoDateOnly(null), null);
  assert.equal(isoDateOnly(''), null);
});

test('resolveRequestReturnDate prefers explicit return_to_road_date', () => {
  assert.equal(
    resolveRequestReturnDate({ return_to_road_date: '2026-07-17', home_to: '2026-07-20' }),
    '2026-07-17'
  );
});

test('resolveRequestReturnDate falls back to home_to + 1 (last day home → return)', () => {
  assert.equal(resolveRequestReturnDate({ return_to_road_date: null, home_to: '2026-07-16' }), '2026-07-17');
  assert.equal(resolveRequestReturnDate({}), null);
  assert.equal(resolveRequestReturnDate(null), null);
});

test('isUsableKnownReturnDate accepts a future return within the window', () => {
  assert.equal(isUsableKnownReturnDate('2026-07-17', '2026-07-13'), true);
});

test('isUsableKnownReturnDate rejects a return on/before the arrival', () => {
  assert.equal(isUsableKnownReturnDate('2026-07-13', '2026-07-13'), false);
  assert.equal(isUsableKnownReturnDate('2026-07-10', '2026-07-13'), false);
});

test('isUsableKnownReturnDate rejects a stale/too-far return (> maxHomeDays out)', () => {
  assert.equal(isUsableKnownReturnDate('2026-12-13', '2026-07-13'), false); // ~150 days
  assert.equal(isUsableKnownReturnDate('2026-07-20', '2026-07-13', { maxHomeDays: 3 }), false);
  assert.equal(isUsableKnownReturnDate(null, '2026-07-13'), false);
});

test('isReasonableWindow rejects reversed / far-past / far-future windows', () => {
  const today = '2026-07-13';
  assert.equal(isReasonableWindow('2026-07-13', '2026-07-17', today), true);
  assert.equal(isReasonableWindow('2026-07-17', '2026-07-13', today), false); // reversed
  assert.equal(isReasonableWindow('1999-01-01', '1999-01-05', today), false); // far past
  assert.equal(isReasonableWindow('2030-01-01', '2030-01-05', today), false); // far future
});
