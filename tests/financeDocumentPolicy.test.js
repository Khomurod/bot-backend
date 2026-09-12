'use strict';

/**
 * The decisions the document reader would otherwise make in bare `if`s.
 *
 * Each one is a judgement worth arguing with, which is why each one is a pure
 * function here rather than a branch nobody can exercise without a Telegram
 * file and a model:
 *
 *   a size refused from what Telegram ALREADY said, before a byte is fetched —
 *   a cap enforced after the download has paid the cost it exists to avoid;
 *
 *   `needs_review` and `failed` staying apart, because one is worth retrying
 *   and the other is not;
 *
 *   `read` meaning an amount AND a date were actually printed. A record with
 *   neither makes the table look fuller than it is, which is worse than an
 *   honest "a person should look at this".
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../lib/finance/documentPolicy');

const MB = 1024 * 1024;

test('a file larger than the limit is refused before it is fetched', () => {
  const verdict = policy.decideIntake(
    { kind: 'document', mimeType: 'application/pdf', fileSize: 12 * MB },
    { maxDocumentMb: 8 },
  );
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.status, policy.STATUS.SKIPPED_TOO_LARGE);
  assert.match(verdict.reason, /12MB.*8MB/);
});

test('the size gate is checked before the type gate, so a huge .zip says the true reason', () => {
  const verdict = policy.decideIntake(
    { kind: 'document', mimeType: 'application/zip', fileSize: 40 * MB },
    { maxDocumentMb: 8 },
  );
  assert.equal(verdict.status, policy.STATUS.SKIPPED_TOO_LARGE,
    'telling somebody the type is wrong when the real problem is 40MB sends them fixing the wrong thing');
});

test('a type nothing here reads is refused rather than attempted', () => {
  const verdict = policy.decideIntake({ kind: 'document', mimeType: 'application/zip', fileSize: 100 });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.status, policy.STATUS.SKIPPED_UNSUPPORTED);
  assert.match(verdict.reason, /application\/zip/);
});

test('a missing mime type is unsupported, not assumed', () => {
  assert.equal(
    policy.decideIntake({ kind: 'document', mimeType: null, fileSize: 100 }).status,
    policy.STATUS.SKIPPED_UNSUPPORTED,
  );
  assert.equal(
    policy.decideIntake({ kind: 'document', mimeType: 'application/octet-stream', fileSize: 100 }).status,
    policy.STATUS.SKIPPED_UNSUPPORTED,
  );
});

test('a PHOTO is always allowed, whatever its declared type says', () => {
  // Telegram sends photos with no mime type at all. Gating a photo on its
  // declared type would refuse every photo ever posted in the group.
  assert.equal(policy.decideIntake({ kind: 'photo', mimeType: null, fileSize: 500 }).allowed, true);
  assert.equal(
    policy.decideIntake({ kind: 'photo', mimeType: 'application/octet-stream', fileSize: 500 }).allowed,
    true,
  );
  // But the size still binds it.
  assert.equal(
    policy.decideIntake({ kind: 'photo', fileSize: 30 * MB }, { maxDocumentMb: 8 }).status,
    policy.STATUS.SKIPPED_TOO_LARGE,
  );
});

test('a mime type with a charset parameter is still recognised', () => {
  assert.equal(policy.isSupportedMime('application/pdf; charset=binary'), true);
  assert.equal(policy.isPdf('APPLICATION/PDF'), true);
});

test('an unknown size is allowed through — the downloader counts the bytes itself', () => {
  // Telegram omits file_size often enough that refusing on its absence would
  // refuse real documents. The cap is enforced again while the bytes arrive.
  assert.equal(
    policy.decideIntake({ kind: 'document', mimeType: 'application/pdf', fileSize: null }).allowed,
    true,
  );
});

test('a PDF with a real text layer is read as text; a scan goes to vision', () => {
  const strong = policy.decideReadPath({ isPdfFile: true, textChars: policy.STRONG_TEXT_CHARS });
  assert.equal(strong.useText, true);
  assert.equal(strong.method, policy.READ_METHOD.PDF_TEXT);

  // A scan's text layer is usually a handful of stray characters — which is
  // worse than none, because it LOOKS like a successful read and contains none
  // of the numbers.
  const scan = policy.decideReadPath({ isPdfFile: true, textChars: 12 });
  assert.equal(scan.useText, false);
  assert.equal(scan.method, policy.READ_METHOD.PDF_TEXT_AI);

  const photo = policy.decideReadPath({ isPdfFile: false, textChars: 0 });
  assert.equal(photo.useText, false);
  assert.equal(photo.method, policy.READ_METHOD.AI_VISION);
});

test('a complete, confident answer is read', () => {
  const outcome = policy.decideReadOutcome({ amount: 500, issuedAt: '2026-09-01', confidence: 90 });
  assert.equal(outcome.status, policy.STATUS.READ);
  assert.equal(outcome.reviewReason, null);
});

test('a missing amount or a missing date is never recorded as read', () => {
  for (const answer of [
    { amount: null, issuedAt: '2026-09-01', confidence: 95 },
    { amount: 500, issuedAt: null, confidence: 95 },
    { amount: 0, issuedAt: '2026-09-01', confidence: 95 },
  ]) {
    const outcome = policy.decideReadOutcome(answer);
    assert.equal(outcome.status, policy.STATUS.NEEDS_REVIEW);
    assert.equal(outcome.reviewReason, policy.REVIEW_REASON.MISSING_FIELDS);
  }
});

test('a low confidence is shown as needing a person, never as a fact', () => {
  const outcome = policy.decideReadOutcome({
    amount: 500, issuedAt: '2026-09-01', confidence: policy.MIN_CONFIDENCE - 1,
  });
  assert.equal(outcome.status, policy.STATUS.NEEDS_REVIEW);
  assert.equal(outcome.reviewReason, policy.REVIEW_REASON.LOW_CONFIDENCE);
});

test('AI being unavailable is needs_review, and is not the document\'s fault', () => {
  const outcome = policy.decideReadOutcome(null, { aiUnavailable: true });
  assert.equal(outcome.status, policy.STATUS.NEEDS_REVIEW,
    'a provider outage must not burn the retry ladder, and the document is intact');
  assert.notEqual(outcome.status, policy.STATUS.FAILED);
  assert.equal(outcome.reviewReason, policy.REVIEW_REASON.AI_UNAVAILABLE);
});

test('an answer that is not an object at all is needs_review, not a crash', () => {
  for (const bad of [null, undefined, 'sorry, I cannot help with that', 42, []]) {
    const outcome = policy.decideReadOutcome(bad);
    assert.equal(outcome.status, policy.STATUS.NEEDS_REVIEW);
  }
});

test('the retry ladder climbs and then stops', () => {
  const now = new Date('2026-09-01T00:00:00Z');
  const minutes = [];
  for (let attempt = 1; attempt <= policy.MAX_ATTEMPTS; attempt += 1) {
    const { retry, nextAttemptAt } = policy.decideRetry(attempt, now);
    assert.equal(retry, true, `attempt ${attempt} should still retry`);
    minutes.push(Math.round((nextAttemptAt - now) / 60000));
  }
  assert.deepEqual(minutes, [...policy.BACKOFF_MINUTES]);

  // Exhausted is a visible end, not a silent forever-loop.
  const done = policy.decideRetry(policy.MAX_ATTEMPTS + 1, now);
  assert.equal(done.retry, false);
  assert.equal(done.nextAttemptAt, null);
});
