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

/**
 * The captured messages, for the Finance page — THE ONE PLACE TEXT IS READ OUT.
 *
 * Everything else in this feature answers with counts. This does not, because a
 * person reconciling money codes has to see the message, and the alternative is
 * the scrolling this feature exists to replace. It is guarded by being reachable
 * only through an admin-gated route.
 */
async function listMessages({ limit = 50, status = null } = {}) {
  const { rows } = await query(
    `SELECT id, chat_id AS "chatId", message_id AS "messageId",
            sender_name AS "senderName", sender_username AS "senderUsername",
            text, has_document AS "hasDocument", has_photo AS "hasPhoto",
            message_date AS "messageDate", edit_date AS "editDate",
            parse_status AS "parseStatus", parser_version AS "parserVersion", parse_json AS "parseJson"
       FROM finance_messages
      WHERE ($2::text IS NULL OR parse_status = $2)
      ORDER BY message_date DESC NULLS LAST, id DESC
      LIMIT $1`,
    [limit, status],
  );
  return rows;
}

/** The money codes, newest first, optionally only the flagged repeats. */
async function listMoneycodes({ limit = 50, duplicatesOnly = false } = {}) {
  const { rows } = await query(
    `SELECT c.id, c.message_ref_id AS "messageRefId", c.code, c.amount, c.currency,
            c.issued_to AS "issuedTo", c.issued_at AS "issuedAt",
            c.sender_name AS "senderName", c.duplicate_of_id AS "duplicateOfId",
            c.duplicate_reason AS "duplicateReason", c.parser_version AS "parserVersion",
            m.chat_id AS "chatId", m.message_id AS "messageId"
       FROM finance_moneycodes c
       JOIN finance_messages m ON m.id = c.message_ref_id
      WHERE ($2::boolean IS NOT TRUE OR c.duplicate_of_id IS NOT NULL)
      ORDER BY c.issued_at DESC NULLS LAST, c.id DESC
      LIMIT $1`,
    [limit, duplicatesOnly],
  );
  return rows.map((r) => ({ ...r, amount: r.amount === null ? null : Number(r.amount) }));
}

/**
 * Re-read one stored message with the CURRENT parser.
 *
 * This is what makes "capture first, codify second" a workflow rather than a
 * slogan: the text was kept verbatim precisely so a tightened parser could be
 * run over it later. The text itself is NEVER touched — only the interpretation
 * beside it — and the caller supplies nothing but an id.
 *
 * IT UPDATES THE INTERPRETATION AND NOTHING ELSE. Persisting a code the
 * re-read found is the CALLER's job, because deciding whether a code is a
 * duplicate needs the settings window and this layer depends on nothing above
 * it. `services/finance/captureService.reparseCapturedMessage` is that caller,
 * and the route calls it rather than this — a re-read that quietly left the
 * money-code table behind is exactly what this returns enough detail to avoid.
 *
 * @returns `{ id, before, after, parsed, senderName, senderUserId, messageDate }`,
 *   or null when there is no such message.
 */
async function reparseMessage(id, { parse } = {}) {
  const parser = parse || require('../lib/finance/moneycode').parseMoneycodeMessage;
  const existing = await query(
    `SELECT id, text, parse_status,
            sender_user_id AS "senderUserId", sender_name AS "senderName",
            message_date AS "messageDate"
       FROM finance_messages WHERE id = $1`,
    [id],
  );
  const row = existing.rows[0];
  if (!row) return null;

  const parsed = parser(row.text);
  await query(
    `UPDATE finance_messages
        SET parse_status = $2, parser_version = $3, parse_json = $4
      WHERE id = $1`,
    [id, parsed.status, parsed.parserVersion, JSON.stringify(parsed)],
  );
  return {
    id: row.id,
    before: row.parse_status,
    after: parsed.status,
    parsed,
    senderUserId: row.senderUserId,
    senderName: row.senderName,
    messageDate: row.messageDate,
  };
}

/**
 * Bring an ALREADY-recorded code into line with a fresher reading of the same
 * message.
 *
 * `recordMoneycode` stays strictly "record it if it is not there" — a repeat
 * returns null, and a test pins that, because idempotent recording is what
 * makes a redelivery harmless. But a tightened parser re-reading the same text
 * can legitimately reach a different amount, and leaving the old one beside a
 * corrected parse would make the Money codes tab disagree with the message it
 * came from. So the refresh is its own explicit call.
 *
 * THE TEXT IS NEVER TOUCHED, and neither is `issued_at` or the sender: those
 * describe the event, not the reading of it.
 */
async function updateMoneycodeInterpretation(messageRefId, codeNormalized, fields) {
  const { rows } = await query(
    `UPDATE finance_moneycodes
        SET code = $3, amount = $4, currency = $5, parser_version = $6,
            confidence = $7, duplicate_of_id = $8, duplicate_reason = $9
      WHERE message_ref_id = $1 AND code_normalized = $2
      RETURNING id`,
    [
      messageRefId, codeNormalized, fields.code,
      fields.amount ?? null, fields.currency || 'USD', fields.parserVersion,
      fields.confidence ?? null, fields.duplicateOfId ?? null,
      fields.duplicateReason ?? null,
    ],
  );
  return rows[0]?.id ?? null;
}

module.exports = {
  listMessages,
  listMoneycodes,
  reparseMessage,
  captureMessage,
  applyEdit,
  recordMoneycode,
  updateMoneycodeInterpretation,
  findDuplicateCandidates,
  summariseCapture,
};
