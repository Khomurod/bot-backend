'use strict';

/**
 * The reply parser: what an owner's sentence means.
 *
 * The tests that matter are the refusals. An intent parser that reads "yes" is
 * easy; one that refuses to invent an action nobody offered is the safety
 * property, and one that never guesses "yes" from an ambiguous sentence is the
 * other.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  parseIntent, INTENTS, SNOOZE_DEFAULT_HOURS, TOMORROW_HOURS,
} = require('../lib/control/intent');

const ALL = [{ key: 'approve' }, { key: 'dismiss' }, { key: 'snooze' }];

test('yes approves', () => {
  for (const text of ['yes', 'Yes.', 'yep', 'ok', 'go ahead', 'do it', 'approve']) {
    assert.strictEqual(parseIntent(text, { offered: ALL }).intent, 'approve', text);
  }
});

test('no dismisses, and the words after it become the reason', () => {
  const bare = parseIntent('no', { offered: ALL });
  assert.strictEqual(bare.intent, 'dismiss');
  assert.strictEqual(bare.reason, null, 'a bare no carries no reason');

  const withReason = parseIntent('no, he changed trucks last week', { offered: ALL });
  assert.strictEqual(withReason.intent, 'dismiss');
  assert.strictEqual(withReason.reason, 'he changed trucks last week');
});

test('later puts it off, and a stated period is honoured', () => {
  assert.strictEqual(parseIntent('later', { offered: ALL }).snoozeHours, SNOOZE_DEFAULT_HOURS);
  assert.strictEqual(parseIntent('tomorrow', { offered: ALL }).snoozeHours, TOMORROW_HOURS);
  assert.strictEqual(parseIntent('in 3 days', { offered: ALL }).snoozeHours, 72);
  assert.strictEqual(parseIntent('in 6 hours', { offered: ALL }).snoozeHours, 6);
});

test('a delay is read as a delay even though it starts with a refusal word', () => {
  // "not now" begins with "no". Order in the parser is what makes this right.
  assert.strictEqual(parseIntent('not now', { offered: ALL }).intent, 'snooze');
});

test('AN ACTION THAT WAS NOT OFFERED IS NEVER CHOSEN', () => {
  const onlyDismiss = [{ key: 'dismiss' }];
  const yes = parseIntent('yes, apply it', { offered: onlyDismiss });
  assert.strictEqual(yes.intent, 'unclear');
  assert.strictEqual(yes.action, null);
  assert.strictEqual(yes.note, 'not offered');

  const later = parseIntent('later', { offered: onlyDismiss });
  assert.strictEqual(later.intent, 'unclear');
});

test('nothing is offered at all — no reply can act', () => {
  for (const text of ['yes', 'no', 'later']) {
    assert.strictEqual(parseIntent(text, { offered: [] }).action, null, text);
  }
});

test('an ambiguous reply is unclear, never a yes', () => {
  for (const text of ['maybe', 'hmm', 'what?', 'I will check', '???']) {
    const got = parseIntent(text, { offered: ALL });
    assert.strictEqual(got.intent, 'unclear', text);
    assert.strictEqual(got.action, null, text);
  }
});

test('empty and oversized replies are unclear and say why', () => {
  assert.strictEqual(parseIntent('', { offered: ALL }).note, 'empty');
  assert.strictEqual(parseIntent('   ', { offered: ALL }).note, 'empty');
  assert.strictEqual(parseIntent('x'.repeat(1001), { offered: ALL }).note, 'too long');
});

test('a complaint about the question itself is an engineering request', () => {
  for (const text of ['this is a bug', 'why are you asking this', 'wrong question']) {
    assert.strictEqual(parseIntent(text, { offered: ALL }).intent, 'engineering_request', text);
  }
});

test('"always" and "don\'t ask again" set remember without changing the action', () => {
  const got = parseIntent("no, don't ask again — he's a team driver", { offered: ALL });
  assert.strictEqual(got.intent, 'dismiss');
  assert.strictEqual(got.remember, true);
});

test('every returned intent is in the closed list', () => {
  const texts = ['yes', 'no', 'later', 'this is a bug', 'maybe', ''];
  for (const text of texts) {
    assert.ok(INTENTS.includes(parseIntent(text, { offered: ALL }).intent), text);
  }
});

test('NO PARAMETER THROUGH WHICH A MODEL COULD REACH THIS DECISION', () => {
  // The signature is the guarantee: reading it is how a reviewer confirms the
  // deterministic path has no AI seam. A parameter named `ai`, `model` or
  // `suggest` appearing here later would be that seam.
  const source = parseIntent.toString();
  const params = source.slice(source.indexOf('(') + 1, source.indexOf(')'));
  assert.ok(!/\b(ai|model|suggestion|llm)\b/i.test(params), params);
});
