'use strict';

/**
 * Which notice the bot already posted about a conversation in the Bitrix
 * topic (migration 0100): "created in Bitrix", "two people match", "Bitrix
 * error". RESERVED BEFORE THE SEND, like the approvals topic's announcements:
 * a re-read of the same conversation finds the key taken and posts nothing; a
 * send Telegram refused gives the key back.
 */

const { query } = require('../pool');

const UNDEFINED_TABLE = '42P01';

/** @returns {Promise<number|null>} the reservation's id, or null when already posted */
async function reserve(chatId, rootMessageId, key) {
  const { rows } = await query(
    `INSERT INTO hiring_stage_notices (chat_id, root_message_id, notice_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (chat_id, root_message_id, notice_key) DO NOTHING
     RETURNING id`,
    [String(chatId), Number(rootMessageId), String(key).slice(0, 80)],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

async function recordSent(id, botMessageId) {
  await query('UPDATE hiring_stage_notices SET bot_message_id = $2 WHERE id = $1', [Number(id), Number(botMessageId)]);
}

async function release(id) {
  await query('DELETE FROM hiring_stage_notices WHERE id = $1', [Number(id)]);
}

async function purgeOldNotices(days = 60) {
  try {
    const result = await query(
      'DELETE FROM hiring_stage_notices WHERE created_at < NOW() - make_interval(days => $1)',
      [Number(days)],
    );
    return result.rowCount || 0;
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) return 0;
    throw err;
  }
}

module.exports = {
  reserve, recordSent, release, purgeOldNotices,
};
