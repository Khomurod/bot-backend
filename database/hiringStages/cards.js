'use strict';

/**
 * One card per candidate conversation in the Bitrix topic (migration 0101):
 * which Telegram message it is now, the one-line history under the name, and
 * the question it shows with its buttons. services/hiringStages/card.js is
 * the only writer.
 *
 * Every change is one UPDATE (the history is appended in SQL, never read and
 * written back), so the worker and a button press touching the same card do
 * not lose each other's line.
 */

const { query } = require('../pool');

const UNDEFINED_TABLE = '42P01';

function mapCard(row) {
  if (!row) return null;
  return {
    chatId: row.chat_id,
    rootMessageId: Number(row.root_message_id),
    messageId: row.message_id === null || row.message_id === undefined ? null : Number(row.message_id),
    driverName: row.driver_name || null,
    history: Array.isArray(row.history) ? row.history : [],
    currentText: row.current_text || null,
    currentKeyboard: row.current_keyboard || null,
    // A second, smaller question that stays while the stage question changes (migration 0104).
    asideText: row.aside_text || null,
    asideKeyboard: row.aside_keyboard || null,
  };
}

async function getCard(chatId, rootMessageId) {
  const { rows } = await query(
    'SELECT * FROM hiring_stage_cards WHERE chat_id = $1 AND root_message_id = $2',
    [String(chatId), Number(rootMessageId)],
  );
  return mapCard(rows[0]);
}

/** The card, created if new; its name is set once and never replaced. */
async function ensureCard(chatId, rootMessageId, driverName) {
  const { rows } = await query(
    `INSERT INTO hiring_stage_cards (chat_id, root_message_id, driver_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (chat_id, root_message_id) DO UPDATE
        SET driver_name = COALESCE(hiring_stage_cards.driver_name, EXCLUDED.driver_name)
     RETURNING *`,
    [String(chatId), Number(rootMessageId), driverName || null],
  );
  return mapCard(rows[0]);
}

/**
 * Change a card in one statement: append a history line, replace (or clear)
 * the question or the aside, record the message it now is. Omitted fields
 * are kept.
 */
async function updateCard(chatId, rootMessageId, {
  line, current, aside, messageId,
} = {}) {
  const setCurrent = current !== undefined;
  const setAside = aside !== undefined;
  const { rows } = await query(
    `UPDATE hiring_stage_cards
        SET history = CASE WHEN $3::text IS NULL THEN history ELSE history || to_jsonb($3::text) END,
            current_text = CASE WHEN $4 THEN $5 ELSE current_text END,
            current_keyboard = CASE WHEN $4 THEN $6::jsonb ELSE current_keyboard END,
            message_id = COALESCE($7, message_id),
            aside_text = CASE WHEN $8 THEN $9 ELSE aside_text END,
            aside_keyboard = CASE WHEN $8 THEN $10::jsonb ELSE aside_keyboard END,
            updated_at = NOW()
      WHERE chat_id = $1 AND root_message_id = $2
      RETURNING *`,
    [
      String(chatId), Number(rootMessageId), line ?? null, setCurrent,
      setCurrent ? (current?.text ?? null) : null,
      setCurrent && current?.keyboard ? JSON.stringify(current.keyboard) : null,
      messageId ?? null,
      setAside,
      setAside ? (aside?.text ?? null) : null,
      setAside && aside?.keyboard ? JSON.stringify(aside.keyboard) : null,
    ],
  );
  return mapCard(rows[0]);
}

async function purgeOldCards(days = 60) {
  try {
    const result = await query(
      'DELETE FROM hiring_stage_cards WHERE updated_at < NOW() - make_interval(days => $1)',
      [Number(days)],
    );
    return result.rowCount || 0;
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) return 0;
    throw err;
  }
}

module.exports = {
  getCard, ensureCard, updateCard, purgeOldCards,
};
