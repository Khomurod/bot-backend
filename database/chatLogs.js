/**
 * Chat logs and the bot-sent message registry.
 * Extracted verbatim from database/db.js; db.js re-exports these.
 *
 * The pinned-message snapshots and the group recent loads lived here until the
 * pinned-load reading was removed (October 2026,
 * docs/architecture/retired-dispatch-eta.md). Their tables are droppable in
 * Settings -> Retired feature leftovers.
 */
const { query } = require('./pool');

// ─── Chat Logs ───

async function logChatMessage(groupId, telegramUserId, senderName, messageText, telegramMessageId = null) {
  await query(
    `INSERT INTO chat_logs (group_id, telegram_user_id, telegram_message_id, sender_name, message_text)
     VALUES ($1, $2, $3, $4, $5)`,
    [groupId, telegramUserId, telegramMessageId, senderName, messageText]
  );
}

async function recordBotSentMessage({
  telegramChatId,
  telegramMessageId,
  sentAt = null,
  messageText = null,
  contentKind = 'other',
  sourceMethod = null,
}) {
  const res = await query(
    `INSERT INTO bot_sent_messages (
       telegram_chat_id, telegram_message_id, sent_at, message_text,
       content_kind, source_method
     )
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (telegram_chat_id, telegram_message_id)
     DO UPDATE SET
       sent_at = COALESCE(EXCLUDED.sent_at, bot_sent_messages.sent_at),
       message_text = COALESCE(EXCLUDED.message_text, bot_sent_messages.message_text),
       content_kind = EXCLUDED.content_kind,
       source_method = COALESCE(EXCLUDED.source_method, bot_sent_messages.source_method),
       updated_at = NOW()
     RETURNING *`,
    [
      telegramChatId,
      telegramMessageId,
      sentAt,
      messageText,
      contentKind,
      sourceMethod,
    ]
  );
  return res.rows[0] || null;
}

async function getBotSentMessage(telegramChatId, telegramMessageId) {
  const res = await query(
    `SELECT b.*,
            (
              SELECT g.group_name FROM groups g
              WHERE g.telegram_group_id = b.telegram_chat_id
              LIMIT 1
            ) AS chat_title
       FROM bot_sent_messages b
      WHERE b.telegram_chat_id = $1
        AND b.telegram_message_id = $2
        AND b.deleted_at IS NULL
      LIMIT 1`,
    [telegramChatId, telegramMessageId]
  );
  return res.rows[0] || null;
}

async function findBotSentMessagesForForward({
  sentAt,
  messageText,
  telegramChatId = null,
  toleranceSeconds = 5,
}) {
  if (!sentAt || messageText == null) return [];

  const safeTolerance = Number.isInteger(toleranceSeconds)
    ? Math.min(Math.max(toleranceSeconds, 0), 30)
    : 5;
  const params = [sentAt, safeTolerance, messageText];
  let chatClause = '';
  if (telegramChatId != null) {
    params.push(telegramChatId);
    chatClause = `AND b.telegram_chat_id = $${params.length}`;
  }

  const res = await query(
    `SELECT b.*,
            (
              SELECT g.group_name FROM groups g
              WHERE g.telegram_group_id = b.telegram_chat_id
              LIMIT 1
            ) AS chat_title
       FROM bot_sent_messages b
      WHERE b.deleted_at IS NULL
        AND b.sent_at BETWEEN ($1::timestamptz - make_interval(secs => $2::int))
                          AND ($1::timestamptz + make_interval(secs => $2::int))
        AND b.message_text = $3
        ${chatClause}
      ORDER BY ABS(EXTRACT(EPOCH FROM (b.sent_at - $1::timestamptz))) ASC,
               b.id DESC
      LIMIT 2`,
    params
  );
  return res.rows;
}

async function updateBotSentMessageContent(
  telegramChatId,
  telegramMessageId,
  messageText,
  contentKind
) {
  const res = await query(
    `UPDATE bot_sent_messages
        SET message_text = $3,
            content_kind = $4,
            edited_at = NOW(),
            updated_at = NOW()
      WHERE telegram_chat_id = $1
        AND telegram_message_id = $2
      RETURNING *`,
    [telegramChatId, telegramMessageId, messageText, contentKind]
  );
  return res.rows[0] || null;
}

async function markBotSentMessageDeleted(telegramChatId, telegramMessageId) {
  const res = await query(
    `UPDATE bot_sent_messages
        SET deleted_at = NOW(),
            updated_at = NOW()
      WHERE telegram_chat_id = $1
        AND telegram_message_id = $2
      RETURNING *`,
    [telegramChatId, telegramMessageId]
  );
  return res.rows[0] || null;
}

/**
 * Admin registry browser: newest bot-sent messages first, with optional
 * chat / free-text / date-range filters and pagination. Returns the page of
 * rows plus the total row count so the UI can paginate. Each row carries the
 * matching group_name (when known) as chat_title.
 */
async function listBotSentMessages({
  chatId = null,
  search = null,
  dateFrom = null,
  dateTo = null,
  includeDeleted = true,
  limit = 50,
  offset = 0,
} = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const where = [];
  const params = [];
  if (chatId != null && String(chatId).trim() !== '') {
    params.push(String(chatId).trim());
    where.push(`b.telegram_chat_id = $${params.length}`);
  }
  if (search != null && String(search).trim() !== '') {
    params.push(`%${String(search).trim()}%`);
    where.push(`b.message_text ILIKE $${params.length}`);
  }
  if (dateFrom) {
    params.push(dateFrom);
    where.push(`b.sent_at >= $${params.length}::timestamptz`);
  }
  if (dateTo) {
    params.push(dateTo);
    where.push(`b.sent_at <= $${params.length}::timestamptz`);
  }
  if (!includeDeleted) where.push('b.deleted_at IS NULL');
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const countRes = await query(
    `SELECT COUNT(*)::int AS total FROM bot_sent_messages b ${whereClause}`,
    params
  );
  const total = countRes.rows[0]?.total || 0;

  params.push(safeLimit);
  const limitIdx = params.length;
  params.push(safeOffset);
  const offsetIdx = params.length;

  const res = await query(
    `SELECT b.*,
            (
              SELECT g.group_name FROM groups g
              WHERE g.telegram_group_id = b.telegram_chat_id
              LIMIT 1
            ) AS chat_title
       FROM bot_sent_messages b
       ${whereClause}
      ORDER BY b.sent_at DESC NULLS LAST, b.id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );
  return { messages: res.rows, total, limit: safeLimit, offset: safeOffset };
}

async function getBotSentMessageById(id) {
  const res = await query(
    `SELECT b.*,
            (
              SELECT g.group_name FROM groups g
              WHERE g.telegram_group_id = b.telegram_chat_id
              LIMIT 1
            ) AS chat_title
       FROM bot_sent_messages b
      WHERE b.id = $1
      LIMIT 1`,
    [id]
  );
  return res.rows[0] || null;
}

/**
 * Record an admin edit: store the replacement text as the current text and in
 * last_edit_text, and stamp edited_at. Keyed by (chat, message) so the service
 * can call it right after a successful Telegram edit.
 */
async function markBotSentMessageEdited(telegramChatId, telegramMessageId, newText) {
  const res = await query(
    `UPDATE bot_sent_messages
        SET message_text = $3,
            last_edit_text = $3,
            edited_at = NOW(),
            updated_at = NOW()
      WHERE telegram_chat_id = $1
        AND telegram_message_id = $2
      RETURNING *`,
    [telegramChatId, telegramMessageId, newText]
  );
  return res.rows[0] || null;
}

async function getChatLogsForGroup(groupId, daysBack) {
  const res = await query(
    `SELECT c.*,
            g.group_name,
            g.telegram_group_id
     FROM chat_logs c
     JOIN groups g ON c.group_id = g.id
     WHERE c.group_id = $1 AND c.created_at >= NOW() - ($2 || ' days')::INTERVAL
     ORDER BY c.created_at ASC`,
    [groupId, daysBack]
  );
  return res.rows;
}

async function getChatLogsForActiveDriverGroups(daysBack) {
  const res = await query(
    `SELECT c.*,
            g.group_name,
            g.telegram_group_id
     FROM chat_logs c
     JOIN groups g ON c.group_id = g.id
     WHERE g.group_type = 'driver'
       AND g.active = TRUE
       AND c.created_at >= NOW() - ($1 || ' days')::INTERVAL
     ORDER BY c.created_at ASC`,
    [daysBack]
  );
  return res.rows;
}

async function deleteOldChatLogs(daysOld) {
  const res = await query(
    `DELETE FROM chat_logs WHERE created_at < NOW() - ($1 || ' days')::INTERVAL`,
    [daysOld]
  );
  return res.rowCount || 0;
}


module.exports = {
  logChatMessage,
  recordBotSentMessage,
  getBotSentMessage,
  findBotSentMessagesForForward,
  updateBotSentMessageContent,
  markBotSentMessageDeleted,
  listBotSentMessages,
  getBotSentMessageById,
  markBotSentMessageEdited,
  getChatLogsForGroup,
  getChatLogsForActiveDriverGroups,
  deleteOldChatLogs,
};
