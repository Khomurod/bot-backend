'use strict';

/**
 * Deciding which money code a "voided" refers to — and refusing to when it
 * cannot be known.
 *
 * THE ASYMMETRY THAT GOVERNS THIS FILE. Marking a live code dead makes real
 * money vanish from a total and looks like an answer; failing to mark a dead
 * one leaves a number slightly high and a person able to see why. The two
 * mistakes are not the same size, so every uncertainty resolves towards a
 * person.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyVoidLanguage, VOID_KIND } = require('../lib/finance/void/intent');
const { decideVoidTarget, DECISION } = require('../lib/finance/void/target');

const A = { id: 1, codeNormalized: '1491583146', status: 'active' };
const B = { id: 2, codeNormalized: '2288341907', status: 'active' };

const target = (text, over = {}) => decideVoidTarget({
  voiding: classifyVoidLanguage(text), recentCodes: [A, B], ...over,
});

// ── request versus completed ───────────────────────────────────────────────

test('an intent to void is not a void', () => {
  for (const [text, kind] of [
    ['voided', VOID_KIND.COMPLETED],
    ['done, voided', VOID_KIND.COMPLETED],
    ['cancelled', VOID_KIND.COMPLETED],
    ['need to void this', VOID_KIND.REQUEST],
    ['need to void this one?', VOID_KIND.REQUEST],
    ['please void this', VOID_KIND.REQUEST],
    ['should we void this?', VOID_KIND.REQUEST],
    ['void this', VOID_KIND.REQUEST],
    ['working on it', VOID_KIND.NONE],
    ['yes', VOID_KIND.NONE],
    ['do not void that', VOID_KIND.NONE],
  ]) {
    assert.equal(classifyVoidLanguage(text).kind, kind, text);
  }
});

test('a request never reaches a code, whatever else is in the message', () => {
  const out = target('please void 1491583146');
  assert.notEqual(out.decision, DECISION.LINK,
    'asking for a void must not perform one');
});

// ── which code ─────────────────────────────────────────────────────────────

test('naming the code is enough', () => {
  const out = target('voided 1491583146');
  assert.equal(out.decision, DECISION.LINK);
  assert.equal(out.codeId, 1);
  assert.equal(out.evidence.kind, 'named');
});

test('replying to the message that issued it is enough', () => {
  const out = target('voided', { replyToCode: B });
  assert.equal(out.decision, DECISION.LINK);
  assert.equal(out.codeId, 2);
  assert.equal(out.evidence.kind, 'replied_to');
});

/** The most dangerous case in the feature: two hard signals, disagreeing. */
test('naming one code while replying to another is NEVER resolved', () => {
  const out = target('voided 1491583146', { replyToCode: B });
  assert.equal(out.decision, DECISION.NEEDS_REVIEW);
  assert.equal(out.evidence.kind, 'conflicting_evidence');
  assert.match(out.reason, /names one code and replies to another/);
});

test('one code in scope and nothing contradicting it may be used, with the evidence kept', () => {
  const out = decideVoidTarget({ voiding: classifyVoidLanguage('voided'), recentCodes: [A] });
  assert.equal(out.decision, DECISION.LINK);
  assert.equal(out.evidence.kind, 'only_active_code_in_scope');
  assert.ok(out.confidence >= 75, 'and only because the confidence clears the bar');
});

test('two codes in scope and a bare "voided" goes to a person', () => {
  const out = target('voided');
  assert.equal(out.decision, DECISION.NEEDS_REVIEW);
  assert.match(out.reason, /2 codes could be meant/);
});

test('naming a code we have no record of is surfaced, not resolved to a near one', () => {
  const out = target('voided 7777777777');
  assert.equal(out.decision, DECISION.NEEDS_REVIEW);
  assert.equal(out.evidence.kind, 'named_unknown_code');
});

test('voiding an already-voided code changes nothing and says so', () => {
  const out = decideVoidTarget({
    voiding: classifyVoidLanguage('voided'),
    replyToCode: { ...A, status: 'voided' },
    recentCodes: [{ ...A, status: 'voided' }],
  });
  assert.equal(out.decision, DECISION.ALREADY_VOIDED);
});

test('a voided code is not a candidate for a later contextual void', () => {
  const out = decideVoidTarget({
    voiding: classifyVoidLanguage('voided'),
    recentCodes: [{ ...A, status: 'voided' }, B],
  });
  assert.equal(out.decision, DECISION.LINK);
  assert.equal(out.codeId, 2, 'the one live code is the only thing it can mean');
});

test('no code in scope at all is a person\'s problem, not a silent no-op', () => {
  const out = decideVoidTarget({ voiding: classifyVoidLanguage('voided'), recentCodes: [] });
  assert.equal(out.decision, DECISION.NEEDS_REVIEW);
  assert.match(out.reason, /no code in scope/);
});
