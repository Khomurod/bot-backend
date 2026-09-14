'use strict';

/**
 * The life of a money code after it was issued — voided, replaced, or waiting
 * for a person.
 *
 * SEPARATE FROM `financeMessages.js` ON PURPOSE. That module answers "what did
 * the group say"; this one answers "what is true of this code now". They move
 * at different times and for different reasons: re-reading a message must never
 * resurrect a code somebody voided, and the clearest way to hold that line is
 * for the reading path not to own the state.
 *
 * NOTHING HERE DELETES. A void adds a state, a timestamp, the message that
 * caused it and the evidence for the link. The digits, the amount, the original
 * message and the issue time all stay exactly as they were, because the
 * question an auditor asks is not "what is live" but "what happened".
 *
 * EVERY TRANSITION WRITES AN EVENT. The row carries the current state; the
 * event table carries how it got there, including whether a model contributed.
 * A state with no event behind it is a state nobody can explain.
 */

const { query } = require('./db');

const UNDEFINED_TABLE = '42P01';

const CODE_STATUS = Object.freeze({
  ACTIVE: 'active',
  VOIDED: 'voided',
  REPLACED: 'replaced',
  NEEDS_REVIEW: 'needs_review',
  DUPLICATE_POSTING: 'duplicate_posting',
});

/** States that are still money the company is out. */
const LIVE_STATUSES = Object.freeze([CODE_STATUS.ACTIVE, CODE_STATUS.NEEDS_REVIEW]);

/**
 * Record one thing that happened to a code. Append-only.
 *
 * `decidedBy` is `deterministic`, `ai` or `admin`, and it is not cosmetic: a
 * reading a model contributed to must never be indistinguishable from one the
 * rules reached on their own.
 */
async function recordEvent(moneycodeId, {
  event, fromStatus = null, toStatus = null, messageRefId = null,
  decidedBy = 'deterministic', confidence = null, evidence = null, note = null,
} = {}) {
  const { rows } = await query(
    `INSERT INTO finance_moneycode_events (
       moneycode_id, event, from_status, to_status, message_ref_id,
       decided_by, confidence, evidence, note
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      moneycodeId, event, fromStatus, toStatus, messageRefId,
      decidedBy, confidence,
      evidence === null || evidence === undefined ? null : JSON.stringify(evidence),
      note,
    ],
  );
  return rows[0]?.id ?? null;
}

/** The code a particular message issued, if it issued one. */
async function findCodeByMessage(chatId, messageId) {
  try {
    const { rows } = await query(
      `SELECT c.id, c.code_normalized AS "codeNormalized", c.status, c.amount
         FROM finance_moneycodes c
         JOIN finance_messages m ON m.id = c.message_ref_id
        WHERE m.chat_id = $1 AND m.message_id = $2
        ORDER BY c.id ASC
        LIMIT 1`,
      [String(chatId), Number(messageId)],
    );
    return rows[0] || null;
  } catch (err) {
    if (err.code === UNDEFINED_TABLE) return null;
    throw err;
  }
}

/**
 * The code whose digits a message named, if we ever recorded one.
 *
 * NORMALISED DIGITS ONLY. The caller hands over digits it already proved are
 * present verbatim in a captured message; this looks for a code that was stored
 * with exactly those digits. A partial or fuzzy match is refused by
 * construction — there is no LIKE here — because a near-miss on a money code is
 * a different payment.
 *
 * NEWEST FIRST. The same digits can appear twice — that is a duplicate posting
 * — so this returns the most recent and nothing more. Every caller of it must
 * therefore stop at a non-destructive action: today the only one is the model
 * fallback, which marks a code as wanting a person and never voids it. A
 * destructive action against one of several rows would be a guess wearing an
 * answer's clothes, and this function is not the place that could make it safe.
 */
async function findCodeByDigits(codeNormalized, { limit = 1 } = {}) {
  const digits = String(codeNormalized ?? '').replace(/\D/g, '');
  if (!digits) return null;
  try {
    const { rows } = await query(
      `SELECT c.id, c.code_normalized AS "codeNormalized", c.status, c.amount,
              c.message_ref_id AS "messageRefId", c.issued_at AS "issuedAt"
         FROM finance_moneycodes c
        WHERE c.code_normalized = $1
        ORDER BY c.issued_at DESC NULLS LAST, c.id DESC
        LIMIT $2`,
      [digits, Math.max(1, Number(limit) || 1)],
    );
    return rows[0] || null;
  } catch (err) {
    if (err.code === UNDEFINED_TABLE) return null;
    throw err;
  }
}

/**
 * Codes a void in this chat could plausibly mean.
 *
 * SCOPED BY TIME AND BY CHAT, and deliberately small. A void message is about
 * something recent; widening this to the whole history would make "exactly one
 * candidate" almost impossible and push every contextual void into needs-review
 * — but widening it further would also let a month-old code be voided by a
 * sentence that had nothing to do with it. The window is the caller's.
 */
async function recentCodesInScope({ chatId, before, withinHours = 24, limit = 20 } = {}) {
  try {
    const { rows } = await query(
      `SELECT c.id, c.code_normalized AS "codeNormalized", c.status, c.amount,
              c.issued_at AS "issuedAt"
         FROM finance_moneycodes c
         JOIN finance_messages m ON m.id = c.message_ref_id
        WHERE m.chat_id = $1
          AND c.issued_at IS NOT NULL
          AND c.issued_at <= $2
          AND c.issued_at >= $2::timestamptz - ($3 || ' hours')::interval
        ORDER BY c.issued_at DESC
        LIMIT $4`,
      [String(chatId), before, String(Number(withinHours) || 24), Math.max(1, Number(limit) || 20)],
    );
    return rows;
  } catch (err) {
    if (err.code === UNDEFINED_TABLE) return [];
    throw err;
  }
}

/**
 * Void one code, once.
 *
 * IDEMPOTENT BY THE `WHERE`: a code already voided does not move, so a
 * redelivered Telegram message, a re-read, or two passes racing cannot stack
 * two voids or overwrite the evidence of the first one. The returned value says
 * whether THIS call was the one that did it.
 */
async function voidCode(moneycodeId, {
  messageRefId = null, evidence = null, confidence = null,
  decidedBy = 'deterministic', at = null,
} = {}) {
  const { rows } = await query(
    `UPDATE finance_moneycodes
        SET status = 'voided',
            voided_at = COALESCE($2, NOW()),
            void_message_ref_id = $3,
            void_confidence = $4,
            void_evidence = $5
      WHERE id = $1 AND status <> 'voided'
      RETURNING id, status`,
    [
      moneycodeId, at, messageRefId, confidence,
      evidence === null || evidence === undefined ? null : JSON.stringify(evidence),
    ],
  );
  if (!rows[0]) return { changed: false };

  await recordEvent(moneycodeId, {
    event: 'voided', toStatus: 'voided', messageRefId, decidedBy, confidence, evidence,
  });
  return { changed: true };
}

/**
 * Record that one code superseded another — only ever from real evidence.
 *
 * A code issued after a void is not automatically its replacement. This is
 * called when something SAID so, and the evidence travels with it.
 *
 * A VOID IS NOT OVERWRITTEN BY A REPLACEMENT. Both are true of a code that was
 * voided and then re-issued, and the status column can only hold one — so it
 * keeps the stronger, earlier statement about the money. The relationship is
 * not lost: `replaced_by_id` is written either way, and the event trail records
 * both. Letting `replaced` win would quietly shrink the voided total on every
 * report, which is the number somebody is reconciling against.
 */
async function markReplaced(moneycodeId, replacementId, {
  messageRefId = null, evidence = null, confidence = null, decidedBy = 'deterministic',
} = {}) {
  if (!replacementId || Number(replacementId) === Number(moneycodeId)) return { changed: false };
  const { rows } = await query(
    `UPDATE finance_moneycodes
        SET status = CASE WHEN status = 'voided' THEN status ELSE 'replaced' END,
            replaced_by_id = $2
      WHERE id = $1 AND replaced_by_id IS DISTINCT FROM $2
      RETURNING id, status`,
    [moneycodeId, replacementId],
  );
  if (!rows[0]) return { changed: false };
  await recordEvent(moneycodeId, {
    event: 'replaced', toStatus: rows[0].status, messageRefId, decidedBy, confidence,
    evidence: { ...(evidence || {}), replacedBy: replacementId },
  });
  return { changed: true, status: rows[0].status };
}

/**
 * Hand a code to a person, with the reason written down.
 *
 * A VOIDED CODE IS NOT DRAGGED BACK for review: the strongest statement already
 * made about it stands, and an ambiguous later sentence is not grounds to undo
 * it.
 */
async function markNeedsReview(moneycodeId, reason, {
  messageRefId = null, evidence = null, decidedBy = 'deterministic',
} = {}) {
  const { rows } = await query(
    `UPDATE finance_moneycodes
        SET status = 'needs_review', review_reason = $2
      WHERE id = $1 AND status NOT IN ('voided', 'replaced')
      RETURNING id`,
    [moneycodeId, reason ?? null],
  );
  if (!rows[0]) return { changed: false };
  await recordEvent(moneycodeId, {
    event: 'needs_review', toStatus: 'needs_review', messageRefId, decidedBy, evidence, note: reason,
  });
  return { changed: true };
}

/** The trail behind one code, newest first. */
async function listEvents(moneycodeId, { limit = 50 } = {}) {
  try {
    const { rows } = await query(
      `SELECT id, event, from_status AS "fromStatus", to_status AS "toStatus",
              message_ref_id AS "messageRefId", decided_by AS "decidedBy",
              confidence, evidence, note, created_at AS "createdAt"
         FROM finance_moneycode_events
        WHERE moneycode_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [moneycodeId, Math.max(1, Number(limit) || 50)],
    );
    return rows;
  } catch (err) {
    if (err.code === UNDEFINED_TABLE) return [];
    throw err;
  }
}

module.exports = {
  CODE_STATUS, LIVE_STATUSES,
  recordEvent, findCodeByMessage, findCodeByDigits, recentCodesInScope,
  voidCode, markReplaced, markNeedsReview, listEvents,
};
