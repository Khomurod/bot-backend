'use strict';

/**
 * Offers to rename a placeholder Bitrix deal ("No name"), and what a person
 * answered (migration 0104). services/hiringStages/rename.js is the only
 * writer.
 *
 * Like a stage proposal: RESERVED before it is shown (offered once per
 * conversation and deal; at most one open per conversation), and a press is
 * a CLAIM — `pending → applying` in one UPDATE — so a second press is told it
 * was already answered. `applying` goes to `applied`, `declined`, `stale`, or
 * back to `pending` when Bitrix could not be asked. Who pressed is kept in
 * `decided_by_*`; `title_written` says this offer's TITLE write went through.
 */

const { query } = require('../pool');

const UNDEFINED_TABLE = '42P01';

function mapRename(row) {
  if (!row) return null;
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    id: Number(row.id),
    chatId: row.chat_id,
    rootMessageId: Number(row.root_message_id),
    dealId: Number(row.deal_id),
    categoryId: row.category_id ?? null,
    fromTitle: row.from_title,
    toName: row.to_name,
    status: row.status,
    contactId: num(row.contact_id),
    contactRenamed: Boolean(row.contact_renamed),
    titleWritten: Boolean(row.title_written),
    botMessageId: num(row.bot_message_id),
    decidedByName: row.decided_by_name || null,
    decidedAt: row.decided_at || null,
    lastError: row.last_error || null,
    createdAt: row.created_at,
  };
}

async function getRename(id) {
  const { rows } = await query('SELECT * FROM hiring_stage_renames WHERE id = $1', [Number(id)]);
  return mapRename(rows[0]);
}

/**
 * Reserve the offer for this conversation and deal. A send Telegram refused
 * earlier (`unsent`) is offered again.
 * @returns the row, or null when it was offered before, or another rename is open
 */
async function reserveRename(r) {
  try {
    const { rows } = await query(
      `INSERT INTO hiring_stage_renames (chat_id, root_message_id, deal_id, category_id, from_title, to_name, contact_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (chat_id, root_message_id, deal_id) DO UPDATE
          SET status = 'pending', from_title = EXCLUDED.from_title, to_name = EXCLUDED.to_name,
              last_error = NULL, updated_at = NOW()
        WHERE hiring_stage_renames.status = 'unsent'
       RETURNING *`,
      [
        String(r.chatId), Number(r.rootMessageId), Number(r.dealId), r.categoryId ?? null,
        String(r.fromTitle ?? ''), String(r.toName), r.contactId ?? null,
      ],
    );
    return mapRename(rows[0]);
  } catch (err) {
    if (err && err.code === '23505') return null; // another rename is open in this conversation
    throw err;
  }
}

async function recordSent(id, botMessageId) {
  await query(
    'UPDATE hiring_stage_renames SET bot_message_id = $2, updated_at = NOW() WHERE id = $1',
    [Number(id), Number(botMessageId)],
  );
}

/**
 * This offer's TITLE write was confirmed by Bitrix — recorded at once, while
 * the press still holds the claim, so a press that then fails at the contact
 * never writes the title twice, and a person's own identical rename is never
 * mistaken for the bot's.
 */
async function markTitleWritten(id) {
  await query(
    `UPDATE hiring_stage_renames SET title_written = TRUE, updated_at = NOW()
      WHERE id = $1 AND status = 'applying'`,
    [Number(id)],
  );
}

/**
 * Move a rename from one status to another, only if it is still in `from`.
 * @returns the updated row, or null when somebody else got there first
 */
async function transition(id, from, to, extra = {}) {
  const { rows } = await query(
    `UPDATE hiring_stage_renames
        SET status = $3,
            decided_by_user_id = COALESCE($4, decided_by_user_id),
            decided_by_name = COALESCE($5, decided_by_name),
            decided_at = CASE WHEN $3 IN ('applied', 'declined', 'stale') THEN NOW() ELSE decided_at END,
            last_error = $6,
            contact_renamed = COALESCE($7, contact_renamed),
            contact_id = COALESCE($8, contact_id),
            updated_at = NOW()
      WHERE id = $1 AND status = ANY($2::text[])
      RETURNING *`,
    [
      Number(id), [].concat(from), to, extra.userId ?? null, extra.userName ?? null, extra.error ?? null,
      extra.contactRenamed ?? null, extra.contactId ?? null,
    ],
  );
  return mapRename(rows[0]);
}

/** A driver's name: deleted at sixty days, like the proposals. Open ones are kept. */
async function purgeOldRenames(days = 60) {
  try {
    const result = await query(
      `DELETE FROM hiring_stage_renames
        WHERE created_at < NOW() - make_interval(days => $1)
          AND status NOT IN ('pending', 'applying')`,
      [Number(days)],
    );
    return result.rowCount || 0;
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) return 0;
    throw err;
  }
}

module.exports = {
  getRename, reserveRename, recordSent, markTitleWritten, transition, purgeOldRenames,
};
