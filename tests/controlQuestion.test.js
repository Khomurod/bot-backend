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
  // THE EVIDENCE KEYS ARE THE ONES THE CHECK ACTUALLY WRITES. This test used to
  // pass `currentUnit`/`targetUnit`, which `checks/identityLayer.js` has never
  // emitted — so the wording's `fact` silently fell through to the title on
  // every real question, and the test proved the fiction agreed with itself.
  // The keys below are asserted against the check's own output in the next test.
  const got = questionFor({
    checkKey: 'identity.stale_unit_assignment',
    title: 'x',
    evidence: { profileUnit: '322', recordedUnit: '310', personId: 91 },
  });
  assert.match(got.lines[0], /310/);
  assert.match(got.lines[0], /322/);
  assert.ok(!got.lines[0].includes('91'));
});

test('a driver with no truck on record reads as that, not as a blank', () => {
  const got = questionFor({
    checkKey: 'identity.stale_unit_assignment',
    title: 'x',
    evidence: { profileUnit: '322', recordedUnit: null },
  });
  assert.match(got.lines[0], /No truck on record/i);
  assert.match(got.lines[0], /322/);
});

test('THE WORDING READS THE SHAPE THE CHECK ACTUALLY PRODUCES', () => {
  // The guard against the whole class: run the real check, hand its finding to
  // the real wording, and assert the fact line is built from the evidence
  // rather than falling back to the title. A key renamed on either side fails
  // here instead of degrading silently in a group chat.
  const { runIdentityLayerChecks } = require('../services/operations/checks/identityLayer');
  const findings = runIdentityLayerChecks({
    now: new Date(),
    groups: [{ id: 49, group_name: 'WENZE UNIT # 322 (COMPANY DRIVER)', group_type: 'driver', active: true }],
    profiles: [{ group_id: 49, unit_number: '322', first_name: 'A', last_name: 'B', driver_type: 'company_driver' }],
    people: [{ id: 5, display_name: 'A B' }],
    personGroups: [{ person_id: 5, group_id: 49 }],
    units: [{ person_id: 5, unit_number: '310', fleet_type: 'company', seat: 1 }],
    boardRows: [],
    groupMembers: [], botUsers: [], telegramIdentities: [],
    fuelAlerts: [], teamDrivers: [], mileageProgress: [],
    routeAssignments: [], personGroupHistory: [], notificationSettings: [],
  });
  const stale = findings.find((f) => f.checkKey === 'identity.stale_unit_assignment');
  assert.ok(stale, 'the check produced the finding this wording is for');

  const asked = questionFor(stale);
  assert.notStrictEqual(asked.lines[0], stale.title,
    'it built a fact from the evidence rather than reprinting the title');
  assert.match(asked.lines[0], /310/);
  assert.match(asked.lines[0], /322/);
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
