/**
 * What the finance group said — the store behind the Finance Monitor.
 *
 * `finance_messages.text` IS THE RECORD. Everything the parser concluded is
 * written beside it, never over it: the parser has never seen a real message
 * (lib/finance/moneycode.js says so in its own header), so a tightened one must
 * be able to re-read exactly the rows the provisional one produced. That is
 * only possible while the original text is still there.
 *
 * CAPTURE IS IDEMPOTENT BY THE DATABASE, NOT BY A CHECK. Telegram redelivers,
 * and a bot restart can replay. `ON CONFLICT (chat_id, message_id) DO NOTHING`
 * makes a second delivery a no-op at the one place that can be certain about
 * it — two racing handlers cannot both win a unique index.
 *
 * NOTHING HERE LOGS MESSAGE TEXT. Ids and statuses only. The whole point of the
 * table is that payment messages live in one auditable place; copying them into
 * the application log would undo that.
 */
const { query } = require('./db');

/** Postgres: the relation does not exist — the one honest "not set up yet". */
const UNDEFINED_TABLE = '42P01';

/**
 * Store one message exactly as it arrived, with what the parser made of it.
 *
 * @returns `{ id, created }` — `created: false` means it was already stored,
 *   which is the normal answer to a Telegram redelivery and not a problem.
 */
async function captureMessage(message, parsed) {
  const { rows } = await query(
    `INSERT INTO finance_messages (
       chat_id, message_id, sender_user_id, sender_username, sender_name,
       text, has_document, has_photo, media_group_id, message_date, edit_date,
       parse_status, parser_version, parse_json
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (chat_id, message_id) DO NOTHING
     RETURNING id`,
    [
      String(message.chatId), Number(message.messageId),
      message.senderUserId ?? null, message.senderUsername ?? null, message.senderName ?? null,
      message.text ?? null, Boolean(message.hasDocument), Boolean(message.hasPhoto),
      message.mediaGroupId ?? null, message.messageDate ?? null, message.editDate ?? null,
      parsed.status, parsed.parserVersion, JSON.stringify(parsed),
    ],
  );

  if (rows[0]) return { id: rows[0].id, created: true };

  const existing = await query(
    'SELECT id FROM finance_messages WHERE chat_id = $1 AND message_id = $2',
    [String(message.chatId), Number(message.messageId)],
  );
  return { id: existing.rows[0]?.id ?? null, created: false };
}

/**
 * An edited message re-reads, but only ever updates the interpretation.
 *
 * The text is replaced because the EDIT is what the group now says — the edit
 * is the message. `captured_at` is left alone so the row still records when
 * Wenze first saw it.
 */
async function applyEdit(chatId, messageId, text, parsed) {
  const { rows } = await query(
    `UPDATE finance_messages
        SET text = $3, edit_date = NOW(), parse_status = $4,
            parser_version = $5, parse_json = $6
      WHERE chat_id = $1 AND message_id = $2
      RETURNING id`,
    [String(chatId), Number(messageId), text ?? null,
      parsed.status, parsed.parserVersion, JSON.stringify(parsed)],
  );
  return rows[0]?.id ?? null;
}

/**
 * Record what was read out of a message.
 *
 * `ON CONFLICT (message_ref_id, code_normalized) DO NOTHING` so re-reading a
 * message cannot double-count a code it already yielded.
 */
async function recordMoneycode(messageRefId, fields) {
  const { rows } = await query(
    `INSERT INTO finance_moneycodes (
       message_ref_id, code, code_normalized, amount, currency,
       issued_to, issued_to_normalized, sender_user_id, sender_name,
       issued_at, parser_version, confidence, duplicate_of_id, duplicate_reason
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (message_ref_id, code_normalized) DO NOTHING
     RETURNING id`,
    [
      messageRefId, fields.code, fields.codeNormalized,
      fields.amount ?? null, fields.currency || 'USD',
      fields.issuedTo ?? null, fields.issuedToNormalized ?? null,
      fields.senderUserId ?? null, fields.senderName ?? null,
      fields.issuedAt ?? null, fields.parserVersion, fields.confidence ?? null,
      fields.duplicateOfId ?? null, fields.duplicateReason ?? null,
    ],
  );
  return rows[0]?.id ?? null;
}

/**
 * The codes a duplicate decision needs to look at.
 *
 * Deliberately narrow: the exact code, OR the same amount to anyone inside the
 * window. Loading a whole history and filtering in JavaScript would read more
 * of a payments table than the question needs, every time a message arrives.
 */
async function findDuplicateCandidates({ codeNormalized, amount, since }) {
  const { rows } = await query(
    `SELECT id, code_normalized AS "codeNormalized", amount,
            issued_to_normalized AS "issuedToNormalized", issued_at AS "issuedAt"
       FROM finance_moneycodes
      WHERE ($1::text IS NOT NULL AND code_normalized = $1)
         OR ($2::numeric IS NOT NULL AND amount = $2 AND issued_at >= $3)
      ORDER BY issued_at DESC NULLS LAST
      LIMIT 200`,
    [codeNormalized ?? null, amount ?? null, since ?? new Date(0)],
  );
  return rows.map((r) => ({ ...r, amount: r.amount === null ? null : Number(r.amount) }));
}

/**
 * Counts for the admin and the health block.
 *
 * Throws on a real database failure; only a missing table answers "nothing
 * captured yet", for the reason database/financeSettings.js sets out at length.
 */
async function summariseCapture() {
  try {
    const { rows } = await query(
      `SELECT parse_status AS status, COUNT(*)::int AS count
         FROM finance_messages
        GROUP BY parse_status`,
    );
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.count]));
    const codes = await query(
      `SELECT COUNT(*)::int AS total,
              COUNT(duplicate_of_id)::int AS duplicates
         FROM finance_moneycodes`,
    );
    return {
      available: true,
      byStatus,
      total: rows.reduce((sum, r) => sum + r.count, 0),
      codes: codes.rows[0]?.total ?? 0,
      duplicates: codes.rows[0]?.duplicates ?? 0,
    };
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) {
      return { available: false, byStatus: {}, total: 0, codes: 0, duplicates: 0 };
    }
    throw err;
  }
}

module.exports = {
  captureMessage,
  applyEdit,
  recordMoneycode,
  findDuplicateCandidates,
  summariseCapture,
};
