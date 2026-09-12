'use strict';

/**
 * The question wording, and the two rules that keep it safe to put in a chat.
 *
 * A question goes into a group whose history is permanent and whose membership
 * nobody audits, so: it names no ids, and it never says the name of an action a
 * reply could then quote back.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  QUESTIONS, isAskable, questionFor, offeredActionsFor, replyHintFor,
} = require('../lib/control/askable');
const { CHECK_TO_ACTION } = require('../services/operations/corrections/actions');
const { sanitise } = require('../lib/notifications/compose');

test('EVERY check with a registered action has wording', () => {
  // The other half of wiring up an action. Without this a check can be given a
  // correction and then never ask about it, silently.
  const missing = [...CHECK_TO_ACTION.keys()].filter((key) => !isAskable(key));
  assert.deepStrictEqual(missing, [], `no question wording for: ${missing.join(', ')}`);
});

test('every question is a question', () => {
  for (const [key, entry] of Object.entries(QUESTIONS)) {
    assert.ok(entry.ask.trim().endsWith('?'), `${key} does not end in a question mark`);
    assert.ok(entry.ask.length < 160, `${key} is too long for a phone`);
  }
});

test('no question names an id, a chat or an action key', () => {
  for (const [key, entry] of Object.entries(QUESTIONS)) {
    assert.ok(!/\b(chat_id|chatId|person_id|personId|group_id)\b/.test(entry.ask), key);
    // An action key looks like `identity.sync_unit`. If one appeared in the
    // visible text, a reply could quote it and the text would be naming the
    // operation — which is exactly what `offeredActions` exists to prevent.
    assert.ok(!/[a-z_]+\.[a-z_]{4,}/.test(entry.ask), `${key} looks like it names an action key`);
    assert.ok(!/\d{6,}/.test(entry.ask), `${key} contains something id-shaped`);
  }
});

test('a question body survives the notice sanitiser unchanged', () => {
  for (const [key, entry] of Object.entries(QUESTIONS)) {
    assert.strictEqual(sanitise(entry.ask), entry.ask, key);
  }
});

test('a check with no wording is simply not askable', () => {
  assert.strictEqual(isAskable('something.invented'), false);
  assert.strictEqual(questionFor({ checkKey: 'something.invented' }), null);
});

test('facts tolerate missing evidence rather than throwing', () => {
  for (const key of Object.keys(QUESTIONS)) {
    const got = questionFor({ checkKey: key });
    assert.ok(got, key);
    assert.ok(Array.isArray(got.lines), key);
  }
});

test('the stale-unit question says both trucks and no ids', () => {
  const got = questionFor({
    checkKey: 'identity.stale_unit_assignment',
    title: 'x',
    evidence: { currentUnit: '310', targetUnit: '322', personId: 91 },
  });
  assert.match(got.lines[0], /310/);
  assert.match(got.lines[0], /322/);
  assert.ok(!got.lines[0].includes('91'));
});

test('no is always available; yes only when there is something to apply', () => {
  const withAction = offeredActionsFor({ hasAction: true }).map((o) => o.key);
  assert.deepStrictEqual(withAction, ['approve', 'dismiss', 'snooze']);

  const without = offeredActionsFor({ hasAction: false }).map((o) => o.key);
  assert.deepStrictEqual(without, ['dismiss', 'snooze']);
});

test('the hint tells the reader exactly what to type', () => {
  const hint = replyHintFor(offeredActionsFor({ hasAction: true }));
  assert.match(hint, /yes/);
  assert.match(hint, /no/);
  assert.match(hint, /later/);
  assert.ok(!/approve|dismiss|snooze/.test(hint), 'the hint must not name action keys');
});
