'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { checkReply, extractNumbers } = require('../lib/recruiting/replyGuard');
const { FORBIDDEN } = require('../lib/recruiting/replyGuard');

const APPROVED = [
  'Company driver pay is 77 cents per mile, paid weekly.',
  'Drivers average 2,500 miles a week.',
  'Home time is every 3 weeks.',
  'We hire drivers with at least 6 months of verifiable OTR experience.',
];

function guard(text, extra = []) {
  return checkReply(text, { approvedText: APPROVED, extraApproved: extra });
}

// ── the core rule: a number Wenze was not given is a number it may not say ───

test('a figure that IS in an approved statement passes', () => {
  const out = guard('Yes — pay is 77 cents per mile and drivers average 2,500 miles a week.');
  assert.strictEqual(out.ok, true);
});

test('a figure nobody approved is refused, and the figure is named', () => {
  const out = guard('Pay starts at 85 cents per mile for experienced drivers.');
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'unapproved_figure');
  assert.match(out.detail, /85/, 'the reviewer needs to see WHICH number');
});

test('a sign-on bonus nobody mentioned is refused', () => {
  const out = guard('We also have a 5000 dollar sign-on bonus for you.');
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'unapproved_figure');
});

test('the same figure written differently still matches', () => {
  // 2,500 approved; "2500" is the same claim.
  assert.strictEqual(guard('Drivers run about 2500 miles a week.').ok, true);
});

test('a number the CANDIDATE introduced is NOT thereby approved', () => {
  // The approved corpus is the only source. A guard that also read the thread
  // would let Wenze agree with a figure a candidate invented.
  const out = checkReply('That is right, we pay 92 cents per mile.', {
    approvedText: APPROVED,
    // deliberately NOT passing the conversation
  });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'unapproved_figure');
});

test('a figure the SYSTEM supplied can be allowed explicitly', () => {
  const out = guard('A recruiter will call you on Monday after 9 am.', ['9 am Monday']);
  assert.strictEqual(out.ok, true, 'extraApproved covers figures that did not come from the model');
});

test('one and two are not claims about the offer', () => {
  assert.strictEqual(guard('One of our recruiters will call you back.').ok, true);
});

// ── commitments ─────────────────────────────────────────────────────────────

test('a guarantee is refused however it is phrased', () => {
  for (const text of [
    'I can guarantee you a truck when you start.',
    'Your home time is guaranteed every 3 weeks.',
    'We guarantee 2,500 miles a week.',
  ]) {
    const out = guard(text);
    assert.strictEqual(out.ok, false, text);
    assert.strictEqual(out.reason, 'commitment');
  }
});

test('granting an exception is refused; OFFERING TO DISCUSS one is allowed', () => {
  assert.strictEqual(guard('I can make an exception for you on that.').ok, false);
  assert.strictEqual(guard('We can approve that for you.').ok, false);
  const allowed = guard('The recruiter can discuss an exception with you during working hours.');
  assert.strictEqual(allowed.ok, true, 'the approved answer to an exception request must survive');
});

test('a hiring decision is refused', () => {
  assert.strictEqual(guard("Good news, you're hired — welcome aboard.").ok, false);
  assert.strictEqual(guard('You are approved to start with us.').ok, false);
  assert.strictEqual(guard('I can offer you a position on our fleet.').ok, false);
});

test('waiving a requirement is refused', () => {
  const out = guard('No experience is required for this role, come on in.');
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'commitment');
});

test('saying the company is hiring is NOT a commitment', () => {
  assert.strictEqual(guard('We are hiring OTR drivers right now.').ok, true);
});

test('a promise is refused', () => {
  assert.strictEqual(guard('I promise the recruiter will sort this out for you.').ok, false);
});

// ── channel and shape ───────────────────────────────────────────────────────

test('a link is refused', () => {
  assert.strictEqual(guard('Apply here: https://example.com/apply today.').reason, 'contact_leak');
  assert.strictEqual(guard('Have a look at www.example.com for details.').reason, 'contact_leak');
});

test('an email address is refused', () => {
  assert.strictEqual(guard('Send your CDL to recruiting@example.com when you can.').reason, 'contact_leak');
});

test('markdown is refused because a phone shows it literally', () => {
  assert.strictEqual(guard('**Great news** — a recruiter will be in touch soon.').reason, 'formatting');
});

test('a reply too long for two SMS segments is refused', () => {
  const out = guard(`${'We are glad you asked about the role. '.repeat(12)}`);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'too_long');
});

test('an empty or near-empty reply is refused', () => {
  assert.strictEqual(guard('ok').reason, 'too_short');
  assert.strictEqual(guard('').reason, 'too_short');
});

test('whitespace is normalised so a multi-line answer is judged on its words', () => {
  const out = guard('Thanks for asking.\n\n   A recruiter will confirm the details.');
  assert.strictEqual(out.ok, true);
  assert.ok(!out.text.includes('\n'), 'the sent text is a single line');
});

// ── the number extractor itself ─────────────────────────────────────────────

test('numbers are normalised so the same claim compares equal', () => {
  assert.ok(extractNumbers('$0.77 per mile').has('0.77'));
  assert.ok(extractNumbers('77.0 cents').has('77'));
  assert.ok(extractNumbers('2,500 miles').has('2500'));
  assert.ok(extractNumbers('.75 cpm').has('0.75'));
});

test('the forbidden list is not empty, and every entry names why', () => {
  assert.ok(FORBIDDEN.length >= 5);
  for (const rule of FORBIDDEN) {
    assert.ok(rule.re instanceof RegExp);
    assert.ok(typeof rule.why === 'string' && rule.why.length > 5);
  }
});
