'use strict';

/**
 * "This code replaces that one" — the language, and the target.
 *
 * THE TEST THAT MATTERS MOST IS THE ONE THAT REFUSES. A finance group issues
 * codes to several drivers in the same few minutes, so "a code was voided and
 * another appeared" is not evidence of a replacement — it is evidence of a busy
 * afternoon. Every case below that returns `needs_review` is a case where a
 * plausible-looking guess would have merged two drivers' money into one story.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyReplacementLanguage, decideReplacementTarget,
  REPLACEMENT_DECISION,
} = require('../lib/finance/replacement');
const { classifyModality, MODALITY } = require('../lib/finance/phrasing');

const OLD = { id: 11, codeNormalized: '1491583146', status: 'voided' };
const OTHER = { id: 12, codeNormalized: '9988776655', status: 'active' };

function said(text) {
  return classifyReplacementLanguage(text);
}

test('a statement of replacement is one; a question, a request or a refusal is not', () => {
  assert.equal(said('Replacement for 1491583146 — new code 2288341907').isReplacement, true);
  assert.equal(said('re-issued as 2288341907').isReplacement, true);
  assert.equal(said('2288341907 supersedes 1491583146').isReplacement, true);

  assert.equal(said('should we replace 1491583146?').isReplacement, false, 'a question');
  assert.equal(said('please replace 1491583146').isReplacement, false, 'a request');
  assert.equal(said('working on it, will reissue').isReplacement, false, 'in progress');
  assert.equal(said('do not replace that one').isReplacement, false, 'refused');
});

test('a message with no replacement word is not a replacement, whatever else it says', () => {
  assert.equal(said('Money Transfer code: 2288341907\nAmount: 480.00').isReplacement, false);
  assert.equal(said('new code 2288341907').isReplacement, false,
    'a group posts new codes all day and almost none of them replace anything');
  assert.equal(said('').isReplacement, false);
  assert.equal(said(null).isReplacement, false);
});

test('the modality rules are shared with void detection, not copied', () => {
  // If these two ever diverge, "please void" and "please replace" stop being
  // read the same way, which is the drift this module was extracted to prevent.
  assert.equal(classifyModality('please do it').modality, MODALITY.REQUEST);
  assert.equal(classifyModality('should we?').modality, MODALITY.QUESTION);
  assert.equal(classifyModality('do not').modality, MODALITY.NEGATED);
  assert.equal(classifyModality('voided').modality, MODALITY.COMPLETED);
  assert.equal(classifyModality('code 1491583146').modality, MODALITY.PLAIN);
});

test('the named code is linked, and the new code itself is never a candidate', () => {
  const out = decideReplacementTarget({
    replacement: said('Replacement for 1491583146 — 2288341907'),
    newCode: '2288341907',
    recentCodes: [OLD, OTHER],
  });
  assert.equal(out.decision, REPLACEMENT_DECISION.LINK);
  assert.equal(out.codeId, 11);
  assert.equal(out.confidence, 95);
});

test('a reply to the message that issued a code is enough on its own', () => {
  const out = decideReplacementTarget({
    replacement: said('reissued'),
    newCode: '2288341907',
    replyToCode: OLD,
    recentCodes: [OLD],
  });
  assert.equal(out.decision, REPLACEMENT_DECISION.LINK);
  assert.equal(out.codeId, 11);
  assert.equal(out.evidence.kind, 'replied_to');
});

test('naming one code and replying to another is never resolved', () => {
  const out = decideReplacementTarget({
    replacement: said('replacement for 1491583146 — 2288341907'),
    newCode: '2288341907',
    replyToCode: OTHER,
    recentCodes: [OLD, OTHER],
  });
  assert.equal(out.decision, REPLACEMENT_DECISION.NEEDS_REVIEW);
  assert.equal(out.evidence.kind, 'conflicting_evidence');
});

test('naming two codes we hold is not resolved to either of them', () => {
  const out = decideReplacementTarget({
    replacement: said('replacement for 1491583146 and 9988776655 — 2288341907'),
    newCode: '2288341907',
    recentCodes: [OLD, OTHER],
  });
  assert.equal(out.decision, REPLACEMENT_DECISION.NEEDS_REVIEW);
  assert.equal(out.evidence.kind, 'named_several');
});

test('naming a code we have no record of is unknown, not the nearest thing we hold', () => {
  const out = decideReplacementTarget({
    replacement: said('replacement for 5550001111 — 2288341907'),
    newCode: '2288341907',
    recentCodes: [OLD, OTHER],
  });
  assert.equal(out.decision, REPLACEMENT_DECISION.NEEDS_REVIEW);
  assert.equal(out.evidence.kind, 'named_unknown_code');
});

test('THE ONE THAT MATTERS: one recent code is NOT evidence of a replacement', () => {
  // The void ladder allows "the only active code in scope". This deliberately
  // does not: a void talks about money already spent, a replacement asserts a
  // link between two payments.
  const out = decideReplacementTarget({
    replacement: said('replacement issued'),
    newCode: '2288341907',
    recentCodes: [OLD],
  });
  assert.equal(out.decision, REPLACEMENT_DECISION.NEEDS_REVIEW);
  assert.equal(out.evidence.kind, 'no_named_target');
  assert.match(out.reason, /nothing in the message says which/);
});

test('a replacement claim with no new code decides nothing', () => {
  const out = decideReplacementTarget({
    replacement: said('replacement for 1491583146'),
    newCode: null,
    recentCodes: [OLD],
  });
  assert.equal(out.decision, REPLACEMENT_DECISION.NONE);
  assert.match(out.reason, /issues no code/);
});

test('a message replying to the code it is itself re-stating replaces nothing', () => {
  const out = decideReplacementTarget({
    replacement: said('reissued'),
    newCode: '1491583146',
    replyToCode: OLD,
    recentCodes: [OLD],
  });
  assert.equal(out.decision, REPLACEMENT_DECISION.NEEDS_REVIEW,
    'a code does not replace itself, and the reply is not other evidence');
});

test('language that is not a replacement decides nothing at all', () => {
  const out = decideReplacementTarget({
    replacement: said('please replace 1491583146'),
    newCode: '2288341907',
    recentCodes: [OLD],
  });
  assert.equal(out.decision, REPLACEMENT_DECISION.NONE);
});
