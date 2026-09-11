'use strict';

/**
 * Noticing that Wenze keeps being corrected the same way.
 *
 * The signal is a human UNDOING something, which is the only kind of feedback
 * this application actually collects: nobody fills in a form saying "that was
 * wrong", they revert the correction or answer the candidate themselves.
 *
 * Two properties this file holds. ONE REVERT IS NOT A LESSON — it is a person
 * disagreeing about one row, and they are usually right about that row and
 * nothing more. And A SUGGESTION IS ONLY A SUGGESTION: nothing here changes a
 * setting, disables a check or edits a rule, because important business rules
 * must not change without an administrator agreeing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findLessons, groupReverts, groupRefusals, describeRevertGroup, describeRefusalGroup,
} = require('../lib/operations/learning');

const NOW = '2026-09-11T00:00:00Z';
const nowMs = Date.parse(NOW);
const ago = (days) => new Date(nowMs - days * 86400000).toISOString();

const revert = (over = {}) => ({
  actionKey: 'home_time.close_cycle',
  checkKey: 'home_time.closable_open_cycle',
  subjectType: 'road_history', subjectId: 1,
  revertedAt: ago(2), revertedBy: 'boss', revertReason: 'wrong return date',
  ...over,
});

test('one revert says nothing — a person disagreed about one row', () => {
  const out = findLessons({ corrections: [revert()] }, { now: NOW });
  assert.deepEqual(out, []);
});

test('two is still not a pattern', () => {
  const out = findLessons({
    corrections: [revert({ subjectId: 1 }), revert({ subjectId: 2 })],
  }, { now: NOW });
  assert.deepEqual(out, []);
});

test('the third time, "this check is wrong" is more likely than "these rows were unusual"', () => {
  const out = findLessons({
    corrections: [revert({ subjectId: 1 }), revert({ subjectId: 2 }), revert({ subjectId: 3 })],
  }, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'reverted_correction');
  assert.match(out[0].title, /undone 3 times/);
});

test('the suggestion is the CONSERVATIVE one, and never an instruction', () => {
  const [lesson] = findLessons({
    corrections: [revert({ subjectId: 1 }), revert({ subjectId: 2 }), revert({ subjectId: 3 })],
  }, { now: NOW });
  // "Turn auto-apply off and let it propose" costs nothing if it is wrong and
  // stops a wrong repair if it is right. "Change the rule" is the expensive
  // guess, and is not this module's to make.
  assert.match(lesson.suggestion, /Consider switching automatic correction OFF/);
  assert.ok(!/^(Disable|Turn off|Change)\b/.test(lesson.suggestion), 'a proposal, not a command');
});

test('the humans\' own reasons are carried verbatim, not paraphrased', () => {
  const [lesson] = findLessons({
    corrections: [
      revert({ subjectId: 1, revertReason: 'wrong truck' }),
      revert({ subjectId: 2, revertReason: 'wrong truck' }),
      revert({ subjectId: 3, revertReason: 'driver was still at home' }),
    ],
  }, { now: NOW });
  assert.match(lesson.suggestion, /wrong truck/);
  assert.match(lesson.suggestion, /driver was still at home/);
  assert.deepEqual(lesson.evidence.reasons.sort(), ['driver was still at home', 'wrong truck']);
});

test('three reverts with no reason recorded says so, rather than inventing one', () => {
  const [lesson] = findLessons({
    corrections: [1, 2, 3].map((id) => revert({ subjectId: id, revertReason: null })),
  }, { now: NOW });
  assert.match(lesson.suggestion, /No reason was recorded/);
});

test('reverts of DIFFERENT actions are different problems, not one', () => {
  const out = findLessons({
    corrections: [
      revert({ subjectId: 1 }), revert({ subjectId: 2 }),
      revert({ subjectId: 3, actionKey: 'identity.sync_status' }),
    ],
  }, { now: NOW });
  assert.deepEqual(out, [], 'neither reached three on its own');
});

test('old reverts fall out of the window — a pattern is recent or it is archaeology', () => {
  const out = findLessons({
    corrections: [
      revert({ subjectId: 1, revertedAt: ago(2) }),
      revert({ subjectId: 2, revertedAt: ago(3) }),
      revert({ subjectId: 3, revertedAt: ago(40) }),
    ],
  }, { now: NOW });
  assert.deepEqual(out, []);
});

test('a correction that was never reverted is not a correction anybody objected to', () => {
  const out = groupReverts(
    [1, 2, 3].map((id) => revert({ subjectId: id, revertedAt: null })),
    { nowMs, windowDays: 14, minCount: 3 },
  );
  assert.deepEqual(out, []);
});

// ── the recruiting half ─────────────────────────────────────────────────────

const convo = (over = {}) => ({
  driverPhone: '+15550000001', refusals: 1,
  lastRefusalReason: 'unapproved_figure — used 92, which no approved statement contains',
  updatedAt: ago(1), ...over,
});

test('repeated refusals for an unapproved figure mean a GAP, not a defect', () => {
  const out = findLessons({
    conversations: [
      convo({ driverPhone: '+1', refusals: 2 }),
      convo({ driverPhone: '+2', refusals: 2 }),
    ],
  }, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'recruiting_refusal');
  assert.match(out[0].suggestion, /Adding the fact under Teach Wenze/);
  assert.equal(out[0].evidence.conversations, 2);
});

test('a refusal for a COMMITMENT reads the other way — the guard is doing its job', () => {
  const out = findLessons({
    conversations: [
      convo({ driverPhone: '+1', refusals: 3, lastRefusalReason: 'commitment — guarantees something' }),
    ],
  }, { now: NOW });
  assert.match(out[0].suggestion, /the guard is doing its job/);
});

test('refusals are counted across conversations, not per conversation', () => {
  const groups = groupRefusals(
    [convo({ driverPhone: '+1', refusals: 1 }), convo({ driverPhone: '+2', refusals: 1 })],
    { nowMs, windowDays: 14, minRefusals: 3 },
  );
  assert.deepEqual(groups, [], 'two is under the threshold');
});

test('a conversation with no refusal recorded contributes nothing', () => {
  const groups = groupRefusals(
    [convo({ refusals: 0, lastRefusalReason: null })],
    { nowMs, windowDays: 14, minRefusals: 1 },
  );
  assert.deepEqual(groups, []);
});

// ── the shape of the output ─────────────────────────────────────────────────

test('A SUGGESTION NAMES AN ACTION; IT CANNOT BE ONE', () => {
  const lesson = describeRevertGroup({
    actionKey: 'home_time.close_cycle', count: 5, checkKeys: ['home_time.closable_open_cycle'],
    reasons: ['wrong date'], revertedBy: ['boss'], subjects: ['road_history:1'],
    firstAt: ago(9), lastAt: ago(1),
  });
  // Plain data: a title, some lines, a suggestion, evidence, and the NAME of a
  // registered action. Naming is not doing — only an administrator's POST to
  // /accept, behind the apply gate, ever runs one.
  assert.deepEqual(
    Object.keys(lesson).sort(),
    ['applyAction', 'evidence', 'kind', 'lines', 'subjectId', 'suggestion', 'title'],
  );
  assert.deepEqual(lesson.applyAction, {
    action: 'disable_auto_apply',
    payload: { checkKeys: ['home_time.closable_open_cycle'] },
  });
  for (const value of Object.values(lesson)) {
    assert.notEqual(typeof value, 'function', 'a lesson cannot do anything');
  }
  assert.equal(JSON.stringify(lesson).includes('function'), false);
});

test('a suggestion that is not a setting names NO action, rather than pretending', () => {
  const lesson = describeRefusalGroup({
    kind: 'unapproved_figure', count: 4, conversations: 3,
    examples: ['the draft quoted a rate nobody approved'],
  });
  assert.equal(lesson.applyAction, null,
    'what a company offers a driver is a fact a PERSON supplies under Teach Wenze. '
    + 'A machine that could add it from a pattern in refused drafts would be '
    + 'learning company offers from the questions candidates asked');
});

test('the only action a lesson may ever name turns automation OFF', () => {
  // eslint-disable-next-line global-require
  const { listLearningActions } = require('../services/operations/learningActions');
  assert.deepEqual(listLearningActions(), ['disable_auto_apply'],
    'there is deliberately no enable_auto_apply — a machine proposing that it be '
    + 'trusted with more is the one shape nobody should build, however many '
    + 'confirmations sit in front of it');
});

test('the list is capped — a list nobody reads is no list', () => {
  const corrections = [];
  for (let a = 0; a < 8; a += 1) {
    for (let i = 0; i < 3; i += 1) {
      corrections.push(revert({ actionKey: `action.${a}`, subjectId: `${a}-${i}` }));
    }
  }
  const out = findLessons({ corrections }, { now: NOW, maxSuggestions: 5 });
  assert.equal(out.length, 5);
});

test('the most-evidenced pattern comes first', () => {
  const corrections = [
    ...[1, 2, 3].map((i) => revert({ actionKey: 'small', subjectId: i })),
    ...[1, 2, 3, 4, 5, 6].map((i) => revert({ actionKey: 'big', subjectId: i })),
  ];
  const out = findLessons({ corrections }, { now: NOW });
  assert.match(out[0].title, /big/);
  assert.equal(out[0].evidence.count, 6);
});

test('no sources at all is an empty list, not a crash', () => {
  assert.deepEqual(findLessons({}, { now: NOW }), []);
  assert.deepEqual(findLessons({ corrections: null, conversations: null }, { now: NOW }), []);
});

// ── the world disagreeing, rather than a person ─────────────────────────────

const graded = (over = {}) => ({
  checkKey: 'load_lifecycle.conflict', verdict: 'act',
  outcome: 'contradicted', outcomeAt: ago(2), outcomeDetail: 'phase no longer holds',
  lastDecidedAt: ago(2), ...over,
});

test('A CHECK THAT KEEPS BEING WRONG IS THE THIRD SIGNAL, and not a human one', () => {
  const decisions = [
    ...Array.from({ length: 7 }, (_, i) => graded({ subjectId: i })),
    ...Array.from({ length: 2 }, (_, i) => graded({ subjectId: `c${i}`, outcome: 'confirmed' })),
  ];
  const out = findLessons({ decisions }, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'contradicted_decisions');
  assert.match(out[0].title, /acted 9 times and only 22% held/);
});

test('a short record is a quiet week, not a bad check', () => {
  const decisions = Array.from({ length: 4 }, (_, i) => graded({ subjectId: i }));
  assert.deepEqual(findLessons({ decisions }, { now: NOW }), [],
    'four wrong out of four would have this pass proposing a check be switched '
    + 'off the first afternoon it was switched on');
});

test('a check that mostly holds is left alone', () => {
  const decisions = [
    ...Array.from({ length: 9 }, (_, i) => graded({ subjectId: i, outcome: 'confirmed' })),
    graded({ subjectId: 'x' }),
  ];
  assert.deepEqual(findLessons({ decisions }, { now: NOW }), []);
});

test('NOT_CHECKED IS NOT A GRADE, either way', () => {
  const decisions = Array.from({ length: 20 }, (_, i) => graded({ subjectId: i, outcome: 'not_checked' }));
  assert.deepEqual(findLessons({ decisions }, { now: NOW }), [],
    'counting it would let a check nothing can verify build a record out of nothing');
});

test('a HOLD that was never carried out says nothing about the check\'s judgement', () => {
  const decisions = Array.from({ length: 20 }, (_, i) => graded({
    subjectId: i, verdict: 'hold', outcome: 'contradicted',
  }));
  assert.deepEqual(findLessons({ decisions }, { now: NOW }), []);
});

test('old grades fall out of the window like every other pattern here', () => {
  const decisions = Array.from({ length: 20 }, (_, i) => graded({ subjectId: i, outcomeAt: ago(40) }));
  assert.deepEqual(findLessons({ decisions }, { now: NOW }), []);
});

test('IT NAMES THE REGISTRY\'S ONE ACTION — no new power is granted', () => {
  const decisions = Array.from({ length: 10 }, (_, i) => graded({ subjectId: i }));
  const [lesson] = findLessons({ decisions }, { now: NOW });
  assert.deepEqual(lesson.applyAction, {
    action: 'disable_auto_apply',
    payload: { checkKeys: ['load_lifecycle.conflict'] },
  });
  // The most this can do, once a person agrees, is turn something OFF.
  // eslint-disable-next-line global-require
  const { listLearningActions } = require('../services/operations/learningActions');
  assert.deepEqual(listLearningActions(), ['disable_auto_apply']);
});

test('THE THRESHOLD ADVICE IS WORDS, NOT AN ACTION', () => {
  const decisions = Array.from({ length: 10 }, (_, i) => graded({ subjectId: i }));
  const [lesson] = findLessons({ decisions }, { now: NOW });
  assert.match(lesson.lines.join(' '), /Raising the confidence this check needs/);
  assert.match(lesson.lines.join(' '), /not something Wenze will change by itself/,
    'choosing a confidence floor is a judgement about how much caution a '
    + 'business wants, and a pass that watched its own results and then moved '
    + 'its own bar would be grading its own homework twice');
  assert.equal(JSON.stringify(lesson).includes('minConfidence'), false);
});

test('the worst-performing check is proposed first', () => {
  const decisions = [
    ...Array.from({ length: 10 }, (_, i) => graded({ checkKey: 'bad', subjectId: i })),
    ...Array.from({ length: 10 }, (_, i) => graded({
      checkKey: 'mediocre', subjectId: i, outcome: i < 5 ? 'confirmed' : 'contradicted',
    })),
  ];
  const out = findLessons({ decisions }, { now: NOW });
  assert.equal(out.length, 2);
  assert.match(out[0].title, /"bad"/);
});

test('all three signals coexist without crowding each other out', () => {
  const out = findLessons({
    corrections: [1, 2, 3].map((id) => revert({ subjectId: id })),
    conversations: [convo({ driverPhone: '+1', refusals: 2 }), convo({ driverPhone: '+2', refusals: 2 })],
    decisions: Array.from({ length: 10 }, (_, i) => graded({ subjectId: i })),
  }, { now: NOW });
  assert.deepEqual(
    out.map((l) => l.kind).sort(),
    ['contradicted_decisions', 'recruiting_refusal', 'reverted_correction']
  );
});
