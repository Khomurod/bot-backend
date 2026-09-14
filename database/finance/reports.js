'use strict';

/**
 * The weekly report's numbers, counted by PostgreSQL, and the report rows.
 *
 * EVERY FIGURE IS COUNT/SUM OVER THE CAPTURED ROWS. Not one of them comes from
 * what a model read off a document. That is the line
 * `docs/architecture/ai-decisions.md` records for
 * `finance_document_extraction`: it fills that document's own record and
 * nothing else, and a total is not "that document's own record".
 *
 * Loading the period into JavaScript and adding it up there would be the same
 * answer on a good day and a different one on a bad one — a NUMERIC read as a
 * float, a row filtered slightly differently than the query that counted it.
 * One place does the arithmetic.
 *
 * THE PERIOD IS HALF-OPEN, `[start, end)`, so a code issued exactly on the
 * boundary lands in precisely one report rather than in two or in none.
 */
const { query } = require('../db');

/** Postgres: the relation does not exist — the one honest "not set up yet". */
const UNDEFINED_TABLE = '42P01';

/**
 * Everything the report prints, for one period.
 *
 * `issued_at` is the money code's own time, not when Wenze captured it, so a
 * message captured late still counts in the week it was posted.
 */
async function summariseFinancePeriod({ periodStart, periodEnd }) {
  const codes = await query(
    // ISSUED, ACTIVE AND VOIDED ARE THREE DIFFERENT NUMBERS, and the weekly
    // report was only able to say the first. A voided code still happened — it
    // stays counted under `codeCount` and keeps its own line — but the money it
    // represents is not money the company is out, so `activeAmount` excludes it
    // and is the figure the summary leads with. Overstating a total is how a
    // report stops being trusted; erasing the row is how history stops being
    // auditable, so this does neither.
    //
    // A duplicate POSTING is excluded from the active total for the same
    // reason and a different one: the same code posted twice is one debt, and
    // adding it twice would claim the company paid twice.
    `SELECT COUNT(*)::int                                          AS "codeCount",
            COALESCE(SUM(amount), 0)                               AS "amountTotal",
            -- LIVE, not literally active. A code waiting for a person to
            -- confirm an ambiguous void has NOT been voided — the money went
            -- out and is still out — so leaving it out of this total made real
            -- outstanding money vanish from the report precisely when somebody
            -- needed to look at it. LIVE_STATUSES in the lifecycle module
            -- already said both states are live; this now agrees with it.
            COUNT(*) FILTER (WHERE status IN ('active', 'needs_review'))::int
                                                                   AS "activeCount",
            COALESCE(SUM(amount) FILTER (WHERE status IN ('active', 'needs_review')), 0)
                                                                   AS "activeAmount",
            COUNT(*) FILTER (WHERE status = 'voided')::int          AS "voidedCount",
            COALESCE(SUM(amount) FILTER (WHERE status = 'voided'), 0)
                                                                   AS "voidedAmount",
            -- SUPERSEDED, not "in the replaced state". A code that was voided
            -- and then re-issued keeps voided as its status, because that is
            -- the stronger statement about the money — so counting the state
            -- here would report zero replacements for the commonest case there
            -- is. The two lines overlap by design; they are separate facts, not
            -- a partition of the total.
            COUNT(*) FILTER (WHERE replaced_by_id IS NOT NULL)::int AS "replacedCount",
            COUNT(*) FILTER (WHERE status = 'needs_review')::int    AS "codesNeedingReview",
            COUNT(*) FILTER (WHERE status = 'duplicate_posting')::int
                                                                   AS "duplicatePostings",
            COUNT(*) FILTER (WHERE amount IS NULL)::int             AS "codesWithoutAmount",
            COUNT(*) FILTER (WHERE duplicate_reason = 'same_code')::int
                                                                   AS "duplicateSameCode",
            COUNT(*) FILTER (WHERE duplicate_reason = 'same_amount_recipient_window')::int
                                                                   AS "duplicateSameAmountWindow"
       FROM finance_moneycodes
      WHERE issued_at >= $1 AND issued_at < $2`,
    [periodStart, periodEnd],
  );

  const messages = await query(
    `SELECT COUNT(*)::int AS "messageCount",
            COUNT(*) FILTER (WHERE parse_status IN ('ambiguous', 'unparsed', 'needs_review'))::int
              AS "messagesNeedingAttention",
            COUNT(*) FILTER (WHERE parse_status = 'void_action')::int  AS "voidMessages",
            COUNT(*) FILTER (WHERE parse_status = 'void_request')::int AS "voidRequests"
       FROM finance_messages
      WHERE message_date >= $1 AND message_date < $2`,
    [periodStart, periodEnd],
  );

  // Documents are dated by the message they arrived on, so a document read
  // days later still belongs to the week its message was posted in.
  const documents = await query(
    `SELECT COUNT(*) FILTER (WHERE d.status = 'needs_review')::int AS "documentsNeedingReview",
            COUNT(*) FILTER (WHERE d.status = 'failed')::int        AS "documentsFailed",
            COUNT(*) FILTER (WHERE d.status = 'read')::int          AS "documentsRead"
       FROM finance_documents d
       JOIN finance_messages m ON m.id = d.message_ref_id
      WHERE m.message_date >= $1 AND m.message_date < $2`,
    [periodStart, periodEnd],
  );

  const c = codes.rows[0] || {};
  return {
    ...c,
    // NUMERIC comes back as a string from node-postgres. Left as one would put
    // "12345.50" through a formatter expecting a number; coerced once, here.
    amountTotal: Number(c.amountTotal ?? 0),
    ...(messages.rows[0] || {}),
    ...(documents.rows[0] || {}),
  };
}

/**
 * Record a report. `ON CONFLICT DO NOTHING` on the partial unique index, so a
 * second automatic attempt at a period that was already reported writes
 * nothing and says so.
 *
 * @returns {Promise<{id: number|null, created: boolean}>}
 */
async function recordReport(fields) {
  const { rows } = await query(
    `INSERT INTO finance_reports (
       period_start, period_end, scheduled_for, status, chat_id,
       telegram_message_id, totals, body, error, sent_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (period_start) WHERE status <> 'manual' DO NOTHING
     RETURNING id`,
    [
      fields.periodStart, fields.periodEnd, fields.scheduledFor, fields.status,
      fields.chatId ?? null, fields.telegramMessageId ?? null,
      fields.totals === undefined || fields.totals === null ? null : JSON.stringify(fields.totals),
      fields.body ?? null, fields.error ?? null, fields.sentAt ?? null,
    ],
  );
  return { id: rows[0]?.id ?? null, created: Boolean(rows[0]) };
}

/** Has this period already been reported automatically? */
async function findReportForPeriod(periodStart) {
  const { rows } = await query(
    `SELECT id, status, sent_at AS "sentAt", telegram_message_id AS "telegramMessageId"
       FROM finance_reports
      WHERE period_start = $1 AND status <> 'manual'
      LIMIT 1`,
    [periodStart],
  );
  return rows[0] || null;
}

/** Most recent first, for the admin and the health block. Never the body. */
async function listReports({ limit = 20 } = {}) {
  try {
    const { rows } = await query(
      `SELECT id, period_start AS "periodStart", period_end AS "periodEnd",
              scheduled_for AS "scheduledFor", status, totals,
              sent_at AS "sentAt", error
         FROM finance_reports
        ORDER BY scheduled_for DESC, id DESC
        LIMIT $1`,
      [Math.min(100, Math.max(1, Number(limit) || 20))],
    );
    return rows;
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) return [];
    throw err;
  }
}

module.exports = {
  summariseFinancePeriod,
  recordReport,
  findReportForPeriod,
  listReports,
};
