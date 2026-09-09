/**
 * A GAP IN A MODEL'S ANSWER IS NOT AN ANSWER.
 *
 * When the annotator returned fewer rows than it was given messages, the missing
 * ones were filled in with a complete, plausible annotation: `intent:
 * 'no_signal'`, `role: 'unknown'`, confidence 0. Downstream, that row is
 * indistinguishable from one the model actually produced — so "the model looked
 * at this message and saw nothing" and "the model never mentioned this message"
 * became the same recorded fact.
 *
 * `chat_message_annotations.intent` and `role_guess` are nullable, so
 * "unannotated" is representable and always was. It is also strictly better
 * downstream: `MODE() WITHIN GROUP (ORDER BY role_guess)` ignores NULLs, so an
 * unanswered message no longer casts an 'unknown' vote that can outweigh real
 * ones, and `AVG(role_confidence)` no longer has zeros in it for messages the
 * model never judged.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.BOT_TOKEN ||= 'test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test';
process.env.JWT_SECRET ||= 'test';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef';

const { parseAnnotationBatchResponse: parseAnnotationResponse, normalizeAnnotation } = require('../services/aiAnnotationService');

const batch = [{ id: 1, text: 'a' }, { id: 2, text: 'b' }, { id: 3, text: 'c' }];

test('a message the model never answered is recorded as UNANNOTATED', () => {
  const out = parseAnnotationResponse(JSON.stringify([
    { id: 1, role: 'driver', intent: 'status_update', language: 'en' },
  ]), batch);

  const byId = new Map(out.map((a) => [a.id, a]));
  assert.equal(byId.get(1).intent, 'status_update');

  for (const id of [2, 3]) {
    assert.equal(byId.get(id).intent, null, `#${id}: not a fabricated no_signal`);
    assert.equal(byId.get(id).role, null, `#${id}: and not a fabricated 'unknown' vote`);
    assert.equal(byId.get(id).role_confidence, null,
      `#${id}: a confidence of 0 is a judgement; there was none`);
    assert.equal(byId.get(id).unannotated, true);
  }
});

test('an explicit no_signal is still an answer and is kept', () => {
  const [row] = parseAnnotationResponse(
    JSON.stringify([{ id: 1, role: 'driver', intent: 'no_signal', language: 'en' }]),
    [batch[0]]
  );
  assert.equal(row.intent, 'no_signal', 'the model looked and said nothing was there');
  assert.equal(row.unannotated, undefined);
});

test('an intent outside the enum is unannotated, not relabelled no_signal', () => {
  // The model claimed something. Recording that claim as "saw no signal" is a
  // different assertion than the one it made, and downstream cannot tell.
  const row = normalizeAnnotation({ id: 1, role: 'driver', intent: 'ordering_pizza' }, 1);
  assert.equal(row.intent, null);
});

test('a role outside the enum is still "unknown", which is honest', () => {
  // 'unknown' is a real value in the role vocabulary and it MEANS "I do not
  // know" — unlike no_signal, which means "I looked and there was nothing".
  const row = normalizeAnnotation({ id: 1, role: 'wizard', intent: 'question' }, 1);
  assert.equal(row.role, 'unknown');
});
