'use strict';

/**
 * The report's words.
 *
 * IT ADDS NOTHING UP. Every number it prints comes in already counted, by SQL.
 * A composer that did its own arithmetic would be a second place a total could
 * be wrong, and the two would disagree quietly — so the test feeds it deliberate
 * nonsense (a total that does not match its parts) and asserts it prints the
 * nonsense rather than "correcting" it.
 *
 * IT NEVER SAYS WHAT A REPEAT MEANS. "One code posted twice" and "paid twice"
 * are not the same claim, and Wenze is in no position to make the second.
 *
 * AND EVERYTHING INTERPOLATED IS ESCAPED. It goes to Telegram as HTML, the
 * values include text from outside this application, and an unescaped `<` is a
 * message Telegram refuses — a stray character turning into a missing report.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { composeWeeklyFinanceReport, escapeHtml, money } = require('../lib/finance/weeklyReport');
const schedule = require('../lib/finance/schedule');

const PERIOD = schedule.periodFor(schedule.mostRecentScheduledRun('2026-09-09T12:00:00Z'));

const FULL = {
  codeCount: 7, amountTotal: 12345.5, codesWithoutAmount: 1,
  duplicateSameCode: 1, duplicateSameAmountWindow: 2,
  messagesNeedingAttention: 3, documentsNeedingReview: 2, documentsFailed: 1,
  messageCount: 120,
};

test('it prints what it was handed, and does not recompute it', () => {
  // Deliberately inconsistent: 7 codes cannot total $1.00 with one of them
  // unpriced. A composer that "helped" would hide a real SQL bug.
  const body = composeWeeklyFinanceReport({ ...FULL, amountTotal: 1 }, PERIOD);
  assert.match(body, /7 codes/);
  assert.match(body, /\$1\.00/);
  assert.ok(!body.includes('12,345'), 'nothing may be carried over from anywhere else');
});

test('the two repeat signals stay apart, and neither claims a payment happened', () => {
  const body = composeWeeklyFinanceReport(FULL, PERIOD);
  assert.match(body, /1 code was posted more than once/);
  assert.match(body, /2 codes match the same amount to the same person/);
  assert.match(body, /flagged, not judged/);
  // The claim it must never make.
  assert.ok(!/paid twice|double.?paid|duplicate payment/i.test(body));
});

test('a code with no readable amount is excluded from the total AND said so', () => {
  const body = composeWeeklyFinanceReport(FULL, PERIOD);
  assert.match(body, /1 code has no amount that could be read, so it is not in that total/);

  const many = composeWeeklyFinanceReport({ ...FULL, codesWithoutAmount: 3 }, PERIOD);
  assert.match(many, /3 codes have no amount that could be read, so they are not in that total/);
});

test('a quiet week says so plainly rather than printing an empty table', () => {
  const body = composeWeeklyFinanceReport({ codeCount: 0, messageCount: 4 }, PERIOD);
  assert.match(body, /No money codes were posted in that week/);
  assert.ok(!body.includes('Worth a look'));
  assert.ok(!body.includes('Needs a person'));
});

test('the sections appear only when they have something in them', () => {
  const clean = composeWeeklyFinanceReport(
    { codeCount: 2, amountTotal: 200, messageCount: 10 }, PERIOD,
  );
  assert.ok(!clean.includes('Worth a look'));
  assert.ok(!clean.includes('Needs a person'));

  const reviewOnly = composeWeeklyFinanceReport(
    { codeCount: 2, amountTotal: 200, messageCount: 10, documentsNeedingReview: 1 }, PERIOD,
  );
  assert.ok(reviewOnly.includes('Needs a person'));
  assert.ok(!reviewOnly.includes('Worth a look'));
});

test('HTML from outside the application cannot break the message', () => {
  // Two defences, and it is worth being exact about which does the work.
  // A COUNT is coerced to a number first, so a tag smuggled into one becomes 0
  // rather than markup — stronger than escaping, because there is nothing left
  // to escape.
  const body = composeWeeklyFinanceReport({ codeCount: 0, messageCount: '<b>4</b>' }, PERIOD);
  assert.ok(!body.includes('<b>4</b>'), 'an unescaped tag is a message Telegram refuses to send');
  assert.match(body, /From 0 messages/);

  // Everything that is genuinely TEXT goes through escapeHtml, which is what
  // covers the fields a later stage will add (a recipient, a code off a
  // document) without this file having to be revisited.
  assert.equal(escapeHtml('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
  assert.equal(escapeHtml('</b><script>'), '&lt;/b&gt;&lt;script&gt;');
  assert.equal(escapeHtml(null), '');
});

test('money is formatted once, and a missing figure is $0.00 rather than NaN', () => {
  assert.equal(money(1234567.891), '$1,234,567.89');
  assert.equal(money(0), '$0.00');
  assert.equal(money(null), '$0.00');
  assert.equal(money('not a number'), '$0.00');
});

test('a report too long for Telegram is cut on a LINE, never mid-tag', () => {
  // Cutting inside `<b>` produces HTML Telegram refuses, which turns a long
  // report into no report — the opposite of what a length cap is for.
  const huge = composeWeeklyFinanceReport({
    ...FULL, messageCount: 'x'.repeat(9000),
  }, PERIOD);
  assert.ok(huge.length <= 3500 + 60);
  const opens = (huge.match(/<b>/g) || []).length;
  const closes = (huge.match(/<\/b>/g) || []).length;
  assert.equal(opens, closes, 'every tag it opened, it closed');
});

test('the footer says where the figures came from, because that is the point', () => {
  const body = composeWeeklyFinanceReport(FULL, PERIOD);
  assert.match(body, /From 120 messages captured in the finance group/);
  assert.match(body, /nothing is estimated/);
});

test('the heading names the week the report is about', () => {
  const body = composeWeeklyFinanceReport(FULL, PERIOD);
  assert.match(body, /31 August – 6 September 2026/);
});
