'use strict';

/**
 * How much a notice deserves attention, and when not to send it at all.
 *
 * TWO PROPERTIES. THE OWNER'S SEVERITY IS A CEILING — a category they marked
 * `info` cannot be escalated to `now` by circumstance, because that was their
 * decision about their business and overriding it is how a notification system
 * becomes one people mute. And ONLY ESTABLISHED FACTS MOVE IT: a distance, a
 * percentage, a count. Never an opinion.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { LEVELS, priorityFor, shouldSuppress } = require('../lib/notifications/priority');

// ── urgency comes from the numbers ──────────────────────────────────────────

test('a truck that CANNOT reach the next stop is "now"', () => {
  const out = priorityFor({ severity: 'serious', facts: { rangeMiles: 80, milesToStation: 200 } });
  assert.equal(out.level, LEVELS.NOW);
  assert.match(out.reasons.join(' '), /cannot reach the next stop/);
  assert.match(out.reasons.join(' '), /200 miles to go/);
});

test('a thin margin is "today", not "now"', () => {
  const out = priorityFor({ severity: 'serious', facts: { rangeMiles: 230, milesToStation: 200 } });
  assert.equal(out.level, LEVELS.TODAY);
  assert.match(out.reasons.join(' '), /30 miles of margin/);
});

test('a comfortable margin is "whenever" — the same category, a different day', () => {
  const out = priorityFor({ severity: 'serious', facts: { rangeMiles: 600, milesToStation: 20 } });
  assert.equal(out.level, LEVELS.WHENEVER);
  // Which is the whole point: `fuel` is a warning whether the truck is twenty
  // miles out with half a tank or four hundred miles out at eight percent, and
  // sending both as the same thing teaches people the word means nothing.
});

test('something already overdue is "now"; something due soon is "today"', () => {
  assert.equal(priorityFor({ severity: 'serious', facts: { hoursUntilDue: -5 } }).level, LEVELS.NOW);
  assert.equal(priorityFor({ severity: 'serious', facts: { hoursUntilDue: 6 } }).level, LEVELS.TODAY);
  assert.equal(priorityFor({ severity: 'serious', facts: { hoursUntilDue: 90 } }).level, LEVELS.WHENEVER);
});

test('many drivers at once reads as one upstream problem, and is raised', () => {
  const out = priorityFor({ severity: 'warning', facts: { driversAffected: 30 } });
  assert.equal(out.level, LEVELS.TODAY);
  assert.match(out.reasons.join(' '), /something upstream rather than thirty separate problems/);
});

test('one driver affected raises nothing', () => {
  assert.equal(priorityFor({ severity: 'warning', facts: { driversAffected: 1 } }).level, LEVELS.WHENEVER);
});

test('no facts at all is "whenever" rather than a guess', () => {
  const out = priorityFor({ severity: 'serious' });
  assert.equal(out.level, LEVELS.WHENEVER);
  assert.deepEqual(out.reasons, []);
});

// ── the owner's severity is a ceiling ───────────────────────────────────────

test('AN `info` CATEGORY CANNOT BE ESCALATED TO "now" BY CIRCUMSTANCE', () => {
  const out = priorityFor({ severity: 'info', facts: { rangeMiles: 10, milesToStation: 500 } });
  assert.equal(out.level, LEVELS.WHENEVER);
  assert.match(out.reasons.join(' '), /held at "whenever" because this category is marked info/,
    'they said this kind of thing is never urgent — that was their decision '
    + 'about their business, and circumstance does not get a vote');
});

test('a `warning` category tops out at "today" however bad the numbers', () => {
  const out = priorityFor({ severity: 'warning', facts: { rangeMiles: 10, milesToStation: 500 } });
  assert.equal(out.level, LEVELS.TODAY);
  assert.match(out.reasons.join(' '), /held at "today"/);
});

test('an unrecognised severity falls to the lowest ceiling, not the highest', () => {
  const out = priorityFor({ severity: 'extremely-urgent', facts: { hoursUntilDue: -100 } });
  assert.equal(out.level, LEVELS.WHENEVER);
});

test('NO PARAMETER EXISTS THROUGH WHICH A MODEL COULD RAISE AN ALARM', () => {
  const signature = priorityFor.toString().slice(0, priorityFor.toString().indexOf('{', 30));
  for (const forbidden of ['ai', 'model', 'llm', 'opinion', 'urgency']) {
    assert.equal(new RegExp(forbidden, 'i').test(signature), false, `no \`${forbidden}\` way in`);
  }
  const probe = priorityFor({
    severity: 'info', aiSaysUrgent: true, modelPriority: 'now', override: 'now',
  });
  assert.equal(probe.level, LEVELS.WHENEVER);
});

// ── one driver having one bad morning ───────────────────────────────────────

const noticeAbout = (subjectKey, minutesAgo = 5) => ({
  subjectKey, at: new Date(Date.now() - minutesAgo * 60000).toISOString(),
});

test('THREE DIFFERENT NOTICES ABOUT ONE DRIVER READ AS THREE PROBLEMS — so the fourth waits', () => {
  const recent = [noticeAbout('driver:12', 5), noticeAbout('driver:12', 10), noticeAbout('driver:12', 20)];
  const out = shouldSuppress({ level: LEVELS.TODAY, subjectKey: 'driver:12', recent });
  assert.equal(out.suppress, true);
  assert.match(out.why, /one driver having one bad morning/);
});

test('A "now" IS NEVER SUPPRESSED, whatever else they have been told', () => {
  const recent = [noticeAbout('driver:12'), noticeAbout('driver:12'), noticeAbout('driver:12')];
  const out = shouldSuppress({ level: LEVELS.NOW, subjectKey: 'driver:12', recent });
  assert.equal(out.suppress, false);
  assert.match(out.why, /always worth saying/);
});

test('notices about OTHER drivers do not silence this one', () => {
  const recent = [noticeAbout('driver:99'), noticeAbout('driver:98'), noticeAbout('driver:97')];
  assert.equal(shouldSuppress({ level: LEVELS.TODAY, subjectKey: 'driver:12', recent }).suppress, false);
});

test('notices older than the window do not count', () => {
  const recent = [noticeAbout('driver:12', 200), noticeAbout('driver:12', 300), noticeAbout('driver:12', 400)];
  assert.equal(shouldSuppress({ level: LEVELS.TODAY, subjectKey: 'driver:12', recent }).suppress, false);
});

test('under the limit passes, and says how close it is', () => {
  const out = shouldSuppress({ level: LEVELS.TODAY, subjectKey: 'driver:12', recent: [noticeAbout('driver:12')] });
  assert.equal(out.suppress, false);
  assert.match(out.why, /1 notice\(s\) about this subject/);
});

test('no subject to group by means nothing to suppress', () => {
  assert.equal(shouldSuppress({ level: LEVELS.TODAY, subjectKey: null, recent: [] }).suppress, false);
});

test('an unreadable timestamp in the history is ignored rather than throwing', () => {
  const recent = [{ subjectKey: 'driver:12', at: 'yesterday-ish' }];
  assert.equal(shouldSuppress({ level: LEVELS.TODAY, subjectKey: 'driver:12', recent }).suppress, false);
});

test('everything here is plain data', () => {
  const p = priorityFor({ severity: 'warning', facts: { hoursUntilDue: 1 } });
  const s = shouldSuppress({ level: LEVELS.TODAY, subjectKey: 'x', recent: [] });
  for (const v of [...Object.values(p), ...Object.values(s)]) assert.notEqual(typeof v, 'function');
});
