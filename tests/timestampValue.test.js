'use strict';

/**
 * Postgres does not treat a string it cannot read as a null. It raises
 * `invalid input syntax`, which aborts the statement — and in production it
 * aborted a critical background pass for a day, once every twelve minutes,
 * because one external field held something that was not a date.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { toTimestampValue, isUsableTimestamp } = require('../lib/database/timestampValue');

test('a readable timestamp comes back as ISO, whatever shape it arrived in', () => {
  assert.equal(toTimestampValue('2026-09-11T23:00:00Z'), '2026-09-11T23:00:00.000Z');
  assert.equal(toTimestampValue('  2026-09-11T23:00:00Z  '), '2026-09-11T23:00:00.000Z');
  assert.equal(toTimestampValue(new Date('2026-01-02T00:00:00Z')), '2026-01-02T00:00:00.000Z');
});

test('what an external system actually sends instead of a date becomes null', () => {
  // Every one of these would abort the statement if it reached the cast.
  for (const junk of ['TBD', 'ASAP', 'call driver', 'n/a', '-', '??', 'Pending']) {
    assert.equal(toTimestampValue(junk), null, junk);
  }
});

test('nothing at all is null, not an empty string', () => {
  for (const empty of [null, undefined, '', '   ']) {
    assert.equal(toTimestampValue(empty), null, JSON.stringify(empty));
  }
});

test('a bare number is refused rather than guessed at', () => {
  // Seconds or milliseconds? Guessing wrong turns a 2026 timestamp into 1970,
  // and a wrong date is worse than a missing one.
  assert.equal(toTimestampValue(1757640000), null);
  assert.equal(toTimestampValue(1757640000000), null);
  assert.equal(toTimestampValue('2026'), null, 'a year is not a timestamp');
});

test('a date outside the range this application can mean is refused', () => {
  assert.equal(toTimestampValue('0001-01-01'), null);
  assert.equal(toTimestampValue('9999-12-31T00:00:00Z'), null);
  assert.equal(toTimestampValue('1969-12-31T00:00:00Z'), null);
});

test('an invalid Date object does not become an exception', () => {
  assert.equal(toTimestampValue(new Date('nonsense')), null);
});

test('isUsableTimestamp answers the same question without converting', () => {
  assert.equal(isUsableTimestamp('2026-09-11T23:00:00Z'), true);
  assert.equal(isUsableTimestamp('TBD'), false);
});

test('this is NOT the display helper, and the contracts differ on purpose', () => {
  // `services/liveLocations/shaping.toIso` passes unreadable text through so a
  // person can see what a dispatcher typed. That behaviour in a SQL parameter
  // is the outage this module exists to prevent.
  // eslint-disable-next-line global-require
  const { toIso } = require('../services/liveLocations/shaping');
  assert.equal(toIso('TBD'), 'TBD');
  assert.equal(toTimestampValue('TBD'), null);
});

test('a calendar date that does not exist is refused, not rolled forward', () => {
  // `Date.parse('2026-02-30')` SUCCEEDS and answers 2 March. Storing that is
  // worse than storing nothing: it is a fabricated appointment time that reads
  // as real, and every freshness and lifecycle calculation downstream believes
  // it. The contract says null for anything unreadable, and a day that does not
  // exist is unreadable.
  for (const impossible of ['2026-02-30', '2026-04-31', '2025-02-29', '2026-06-31']) {
    assert.equal(toTimestampValue(impossible), null, impossible);
  }
});

test('a real leap day is still a real date', () => {
  assert.equal(toTimestampValue('2028-02-29'), '2028-02-29T00:00:00.000Z');
  assert.equal(toTimestampValue('2026-02-28'), '2026-02-28T00:00:00.000Z');
  assert.equal(toTimestampValue('2026-12-31T23:59:59Z'), '2026-12-31T23:59:59.000Z');
});

test('a timestamp carrying an explicit offset is kept, not mistaken for a bad day', () => {
  // The first version of the calendar check compared the parsed instant's UTC
  // day against the day in the text. For `…T23:30:00-05:00` those differ by
  // design, so a perfectly good timestamp was refused. Whether 30 February
  // exists is not a question about timezones, so the check is arithmetic.
  assert.equal(toTimestampValue('2026-09-11T23:30:00-05:00'), '2026-09-12T04:30:00.000Z');
  assert.equal(toTimestampValue('2026-09-11T23:30:00+05:00'), '2026-09-11T18:30:00.000Z');
});
