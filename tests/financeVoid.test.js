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

// ── what the 24-hour window is for, and what it is NOT for ─────────────────

/**
 * THE WINDOW BOUNDS GUESSING, NOT READING.
 *
 * A message that spells out ten digits is naming one specific payment. Looking
 * for it only inside the context window turned "voided 1491583146" into "a code
 * with no matching record" whenever the code was issued more than a day
 * earlier — so spent money stayed in the active total for exactly the codes
 * somebody had been clearest about.
 */
test('a NAMED code is resolved however old it is', () => {
  const older = { id: 3, codeNormalized: '1491583146', status: 'active' };
  const out = decideVoidTarget({
    voiding: classifyVoidLanguage('voided 1491583146'),
    // Nothing recent at all; the row came from a lookup by digits.
    recentCodes: [older],
  });
  assert.equal(out.decision, DECISION.LINK);
  assert.equal(out.codeId, 3);
  assert.equal(out.evidence.kind, 'named');
});

test('a labelled reference beside the code is not a second candidate', () => {
  // The exact failure the label parser exists for, one layer up: a void that
  // quotes the production format carries a Report Reference, and scanning the
  // whole message offered it as a rival code.
  const voiding = classifyVoidLanguage(
    'voided\nMoney Transfer code: 1491583146\nReport Reference: 165373918',
  );
  assert.deepEqual(voiding.codes, ['1491583146'], 'the reference is not a named code');

  const out = decideVoidTarget({
    voiding,
    recentCodes: [{ id: 4, codeNormalized: '1491583146', status: 'active' }],
  });
  assert.equal(out.decision, DECISION.LINK, 'so the void resolves instead of refusing');
});

test('one code recorded twice and BOTH still live is never resolved', () => {
  const out = decideVoidTarget({
    voiding: classifyVoidLanguage('voided 1491583146'),
    recentCodes: [
      { id: 5, codeNormalized: '1491583146', status: 'active' },
      { id: 6, codeNormalized: '1491583146', status: 'active' },
    ],
  });
  assert.equal(out.decision, DECISION.NEEDS_REVIEW);
  assert.equal(out.evidence.kind, 'code_recorded_more_than_once');
});

test('a repeat POSTING beside the live row is not ambiguous — only one is money', () => {
  const out = decideVoidTarget({
    voiding: classifyVoidLanguage('voided 1491583146'),
    recentCodes: [
      { id: 7, codeNormalized: '1491583146', status: 'duplicate_posting' },
      { id: 8, codeNormalized: '1491583146', status: 'active' },
    ],
  });
  assert.equal(out.decision, DECISION.LINK);
  assert.equal(out.codeId, 8, 'the live row is the one that gets voided');
});
