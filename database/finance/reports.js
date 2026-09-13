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
    `SELECT COUNT(*)::int                                          AS "codeCount",
            COALESCE(SUM(amount), 0)                               AS "amountTotal",
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
            COUNT(*) FILTER (WHERE parse_status IN ('ambiguous', 'unparsed'))::int
              AS "messagesNeedingAttention"
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
