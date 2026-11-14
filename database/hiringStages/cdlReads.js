'use strict';

/**
 * How each CDL read ended — one row per conversation and tagging message
 * (migration 0108; docs/architecture/hiring-cdl-reading.md). Written by
 * services/hiringStages/cdlStep.js only.
 *
 * NO VALUE OF THE CDL IS EVER HERE: the status, who read it (provider and
 * model), how many items were written or put in the comment, the item NAMES
 * written, and the deal and contact ids. Nothing else.
 *
 * A conversation with a `written` row is never read again. Any other ending
 * belongs to its tag: the same tag is not read twice (a conversation is read
 * again on every new reply once a person asked), a NEW tag may try again —
 * after the owner switched the reading on, chose a provider, or the post got a
 * better photo.
 */

const { query } = require('../pool');

const UNDEFINED_TABLE = '42P01';

function mapRead(row) {
  if (!row) return null;
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    id: Number(row.id),
    chatId: row.chat_id,
    rootMessageId: Number(row.root_message_id),
    requestMessageId: Number(row.request_message_id),
    status: row.status,
    providerKey: row.provider_key || null,
    model: row.model || null,
    itemsWritten: Number(row.items_written) || 0,
    itemsInComment: Number(row.items_in_comment) || 0,
    writtenItems: Array.isArray(row.written_items) ? row.written_items : [],
    nameFromCdl: Boolean(row.name_from_cdl),
    dealId: num(row.deal_id),
    contactId: num(row.contact_id),
    createdAt: row.created_at,
  };
}

/**
 * May this tag read the conversation's CDL? Not when the conversation's CDL
 * was already written, nor when this tag already had its read.
 */
async function mayRead(chatId, rootMessageId, requestMessageId) {
  const { rows } = await query(
    `SELECT 1 FROM hiring_stage_cdl_reads
      WHERE chat_id = $1 AND root_message_id = $2 AND (status = 'written' OR request_message_id = $3)
      LIMIT 1`,
    [String(chatId), Number(rootMessageId), Number(requestMessageId)],
  );
  return rows.length === 0;
}

/**
 * How this tag's read ended. Once per tag: a second record for the same tag
 * changes nothing. @returns {Promise<object|null>} the row, or null when one was already there
 */
async function recordRead({
  chatId, rootMessageId, requestMessageId, status, providerKey = null, model = null,
  itemsWritten = 0, itemsInComment = 0, writtenItems = [], nameFromCdl = false, dealId = null, contactId = null,
}) {
  const { rows } = await query(
    `INSERT INTO hiring_stage_cdl_reads (chat_id, root_message_id, request_message_id, status, provider_key, model,
       items_written, items_in_comment, written_items, name_from_cdl, deal_id, contact_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (chat_id, root_message_id, request_message_id) DO NOTHING
     RETURNING *`,
    [String(chatId), Number(rootMessageId), Number(requestMessageId), status, providerKey, model,
      Number(itemsWritten) || 0, Number(itemsInComment) || 0, writtenItems, nameFromCdl === true,
      dealId == null ? null : Number(dealId), contactId == null ? null : Number(contactId)],
  );
  return mapRead(rows[0]);
}

/** The newest reads, for Settings — counts and statuses only. */
async function listRecentReads(limit = 20) {
  const { rows } = await query(
    'SELECT * FROM hiring_stage_cdl_reads ORDER BY created_at DESC, id DESC LIMIT $1',
    [Math.max(1, Math.min(100, Number(limit) || 20))],
  );
  return rows.map(mapRead);
}

async function purgeOldCdlReads(days = 60) {
  try {
    const result = await query(
      'DELETE FROM hiring_stage_cdl_reads WHERE created_at < NOW() - make_interval(days => $1)',
      [Number(days)],
    );
    return result.rowCount || 0;
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) return 0;
    throw err;
  }
}

module.exports = {
  mapRead, mayRead, recordRead, listRecentReads, purgeOldCdlReads,
};
