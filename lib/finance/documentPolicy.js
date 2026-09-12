'use strict';

/**
 * What may be read, what is refused, and what the result of reading it means.
 * PURE — no I/O, no database, no clock except the one handed in.
 *
 * These are the decisions that would otherwise be scattered through the
 * reader's control flow as bare `if`s, where nobody could exercise them without
 * a Telegram file and a model. Every one of them is a judgement worth arguing
 * with, so every one of them is a function with a test.
 *
 * THE THREE REFUSALS, and why each is a refusal rather than an attempt:
 *
 *   TOO LARGE — decided from what Telegram ALREADY told us the size is, before
 *   a byte is fetched. A cap enforced after the download has already paid the
 *   cost it exists to avoid, on an instance with 512MB.
 *
 *   UNSUPPORTED — a mime type this reader has no path for. Feeding a .zip to a
 *   PDF parser and then to a vision model is two failures and a bill.
 *
 *   NOT READ WELL ENOUGH — a result that parsed but is too thin or too
 *   uncertain to put in front of somebody as a fact. `needs_review` is the
 *   honest answer and it is not a failure state: the document is fine, it just
 *   needs eyes.
 */

/** Terminal and non-terminal states, named so callers stop spelling them. */
const STATUS = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  READ: 'read',
  NEEDS_REVIEW: 'needs_review',
  FAILED: 'failed',
  SKIPPED_TOO_LARGE: 'skipped_too_large',
  SKIPPED_UNSUPPORTED: 'skipped_unsupported',
});

const READ_METHOD = Object.freeze({
  PDF_TEXT: 'pdf_text',
  AI_VISION: 'ai_vision',
  PDF_TEXT_AI: 'pdf_text_ai',
});

/**
 * Why a person is being asked to look. Each one is a different conversation,
 * so they are not collapsed into "unreadable".
 */
const REVIEW_REASON = Object.freeze({
  AI_UNAVAILABLE: 'ai_unavailable',
  LOW_CONFIDENCE: 'low_confidence',
  MISSING_FIELDS: 'missing_fields',
  NO_TEXT: 'no_text',
  INVALID_ANSWER: 'invalid_answer',
});

/** What this reader has a path for. Anything else is refused, not attempted. */
const SUPPORTED_MIME = Object.freeze([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

/** A model's answer below this is shown as needing a person, never as a fact. */
const MIN_CONFIDENCE = 50;

/**
 * Text below this is treated as "the PDF has no usable text layer" and the
 * document goes to vision instead. A scan's text layer is often a handful of
 * stray characters, which is worse than nothing: it looks like a successful
 * read and contains none of the numbers.
 */
const STRONG_TEXT_CHARS = 200;

/** Retry ladder for a DOWNLOAD failure, in minutes. Never for a read failure. */
const BACKOFF_MINUTES = Object.freeze([5, 15, 30, 60, 60]);
const MAX_ATTEMPTS = BACKOFF_MINUTES.length;

function normaliseMime(value) {
  return String(value || '').trim().toLowerCase().split(';')[0];
}

function isSupportedMime(mimeType) {
  return SUPPORTED_MIME.includes(normaliseMime(mimeType));
}

function isPdf(mimeType) {
  return normaliseMime(mimeType) === 'application/pdf';
}

/**
 * May this document be read at all?
 *
 * A PHOTO IS ALWAYS AN IMAGE, whatever `mime_type` says, because Telegram sends
 * photos with no mime type at all and the descriptor fills in `image/jpeg`.
 * Gating a photo on its declared type would refuse every photo ever posted.
 *
 * @returns {{allowed: true} | {allowed: false, status: string, reason: string}}
 */
function decideIntake(document, { maxDocumentMb = 8 } = {}) {
  const maxBytes = Math.max(1, Number(maxDocumentMb) || 8) * 1024 * 1024;
  const size = Number(document?.fileSize);

  // Size first: it is the cheap refusal and the one that protects the instance.
  if (Number.isFinite(size) && size > maxBytes) {
    return {
      allowed: false,
      status: STATUS.SKIPPED_TOO_LARGE,
      reason: `the file is ${Math.round(size / 1024 / 1024)}MB and the limit is ${maxDocumentMb}MB`,
    };
  }

  if (document?.kind === 'photo') return { allowed: true };

  if (!isSupportedMime(document?.mimeType)) {
    return {
      allowed: false,
      status: STATUS.SKIPPED_UNSUPPORTED,
      reason: `nothing here reads ${normaliseMime(document?.mimeType) || 'that file type'}`,
    };
  }

  return { allowed: true };
}

/**
 * Given what came out of the file, how should it be read?
 *
 * A PDF with a strong text layer is read as TEXT — cheaper, exact, and it never
 * hallucinates a digit. Everything else goes to vision, which is what a scan or
 * a photo of a receipt actually needs.
 */
function decideReadPath({ isPdfFile, textChars = 0 }) {
  if (isPdfFile && Number(textChars) >= STRONG_TEXT_CHARS) {
    return { useText: true, method: READ_METHOD.PDF_TEXT };
  }
  if (isPdfFile) return { useText: false, method: READ_METHOD.PDF_TEXT_AI };
  return { useText: false, method: READ_METHOD.AI_VISION };
}

/**
 * What the model came back with, turned into a row's fate.
 *
 * `read` requires an amount AND a date. A money-code record with neither is not
 * a record of anything — it is a row that makes the table look fuller than it
 * is, which is worse than an honest `needs_review`.
 *
 * @returns {{status: string, reviewReason: string|null}}
 */
function decideReadOutcome(extracted, { aiUnavailable = false } = {}) {
  if (aiUnavailable) {
    return { status: STATUS.NEEDS_REVIEW, reviewReason: REVIEW_REASON.AI_UNAVAILABLE };
  }
  if (!extracted || typeof extracted !== 'object') {
    return { status: STATUS.NEEDS_REVIEW, reviewReason: REVIEW_REASON.INVALID_ANSWER };
  }

  const confidence = Number(extracted.confidence);
  if (Number.isFinite(confidence) && confidence < MIN_CONFIDENCE) {
    return { status: STATUS.NEEDS_REVIEW, reviewReason: REVIEW_REASON.LOW_CONFIDENCE };
  }

  const hasAmount = Number.isFinite(Number(extracted.amount)) && Number(extracted.amount) > 0;
  const hasDate = Boolean(String(extracted.issuedAt || '').trim());
  if (!hasAmount || !hasDate) {
    return { status: STATUS.NEEDS_REVIEW, reviewReason: REVIEW_REASON.MISSING_FIELDS };
  }

  return { status: STATUS.READ, reviewReason: null };
}

/**
 * When to try a failed DOWNLOAD again, or whether to stop.
 *
 * `attempt` is the count AFTER this failure, because attempts are incremented
 * at claim time — the bounded-crash-loop rule the repository's other queues
 * follow. Exhausting the ladder leaves the row `failed` with no next attempt,
 * which is visible rather than silently retried forever.
 */
function decideRetry(attempt, now = new Date()) {
  const index = Math.max(0, Number(attempt) - 1);
  if (index >= BACKOFF_MINUTES.length) return { retry: false, nextAttemptAt: null };
  const minutes = BACKOFF_MINUTES[index];
  return { retry: true, nextAttemptAt: new Date(now.getTime() + minutes * 60 * 1000) };
}

module.exports = {
  STATUS,
  READ_METHOD,
  REVIEW_REASON,
  SUPPORTED_MIME,
  MIN_CONFIDENCE,
  STRONG_TEXT_CHARS,
  BACKOFF_MINUTES,
  MAX_ATTEMPTS,
  isSupportedMime,
  isPdf,
  normaliseMime,
  decideIntake,
  decideReadPath,
  decideReadOutcome,
  decideRetry,
};
