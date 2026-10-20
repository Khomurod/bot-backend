'use strict';

/**
 * What the recruiting group said — the store behind Safety Approvals.
 *
 * `text` IS THE RECORD, verbatim, as in database/financeMessages.js. Photos and
 * documents are Telegram file ids: the bytes stay in Telegram, and only this
 * bot can fetch them.
 *
 * CAPTURE IS IDEMPOTENT BY THE DATABASE. Telegram redelivers; the unique key
 * (chat_id, message_id) makes a second delivery an update, never a second row.
 * An EDIT replaces text and files — the edit is what the group now says — and
 * leaves `captured_at` as the moment the bot first saw the message.
 *
 * NOTHING HERE LOGS MESSAGE TEXT. These rows carry drivers' names and phones.
 */

const { query } = require('../pool');

const UNDEFINED_TABLE = '42P01';

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    chatId: row.chat_id,
    messageId: Number(row.message_id),
    threadId: row.thread_id === null ? null : Number(row.thread_id),
    mediaGroupId: row.media_group_id || null,
    fromUserId: row.from_user_id === null ? null : String(row.from_user_id),
    fromName: row.from_name || null,
    text: row.text ?? null,
    photos: Array.isArray(row.photos) ? row.photos : [],
    documents: Array.isArray(row.documents) ? row.documents : [],
    replyToMessageId: row.reply_to_message_id === null ? null : Number(row.reply_to_message_id),
    sentAt: row.sent_at || null,
    editedAt: row.edited_at || null,
  };
}

/**
 * Store a shaped message (lib/safetyApprovals/messageShape.js).
 * @returns {Promise<{id: number, created: boolean}>}
 */
async function upsertMessage(m) {
  const { rows } = await query(
    `INSERT INTO safety_approval_messages (
       chat_id, message_id, thread_id, media_group_id, from_user_id, from_name,
       text, photos, documents, reply_to_message_id, sent_at, edited_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)
     ON CONFLICT (chat_id, message_id) DO UPDATE
        SET text = EXCLUDED.text,
            photos = EXCLUDED.photos,
            documents = EXCLUDED.documents,
            reply_to_message_id = COALESCE(EXCLUDED.reply_to_message_id,
                                           safety_approval_messages.reply_to_message_id),
            edited_at = COALESCE(EXCLUDED.edited_at, safety_approval_messages.edited_at)
     RETURNING id, (xmax = 0) AS created`,
    [
      String(m.chatId), Number(m.messageId), m.threadId ?? null, m.mediaGroupId ?? null,
      m.fromUserId ?? null, m.fromName ?? null, m.text ?? null,
      JSON.stringify(m.photos || []), JSON.stringify(m.documents || []),
      m.replyToMessageId ?? null, m.sentAt ?? null, m.editedAt ?? null,
    ],
  );
  return { id: Number(rows[0].id), created: Boolean(rows[0].created) };
}

async function getMessage(chatId, messageId) {
  const { rows } = await query(
    'SELECT * FROM safety_approval_messages WHERE chat_id = $1 AND message_id = $2',
    [String(chatId), Number(messageId)],
  );
  return mapRow(rows[0]);
}

/** Every item of one album, in the order they were sent. */
async function getMediaGroup(chatId, mediaGroupId) {
  if (!mediaGroupId) return [];
  const { rows } = await query(
    `SELECT * FROM safety_approval_messages
      WHERE chat_id = $1 AND media_group_id = $2
      ORDER BY message_id
      LIMIT 20`,
    [String(chatId), String(mediaGroupId)],
  );
  return rows.map(mapRow);
}

/**
 * The same person's messages close in time to one of theirs that are not
 * replies to anything: a recruiter who sends the photos and then the text as
 * two messages has still made one post.
 */
async function listSenderMessagesAround({ chatId, fromUserId, at, seconds, limit = 12 }) {
  if (!fromUserId || !at) return [];
  const { rows } = await query(
    `SELECT * FROM safety_approval_messages
      WHERE chat_id = $1 AND from_user_id = $2
        AND reply_to_message_id IS NULL
        AND sent_at BETWEEN $3::timestamptz - make_interval(secs => $4)
                        AND $3::timestamptz + make_interval(secs => $4)
      ORDER BY message_id
      LIMIT $5`,
    [String(chatId), String(fromUserId), at, Number(seconds), Number(limit)],
  );
  return rows.map(mapRow);
}

/**
 * What the Safety people said in reply to a post: their direct replies to any
 * message of it, and the other items of any album those replies belong to (a
 * client may mark only one item of a reply album as the reply).
 */
async function listSafetyReplies({ chatId, postMessageIds, safetyUserIds, limit = 30 }) {
  if (!postMessageIds?.length || !safetyUserIds?.length) return [];
  const { rows } = await query(
    `WITH direct AS (
       SELECT id, media_group_id FROM safety_approval_messages
        WHERE chat_id = $1
          AND reply_to_message_id = ANY($2::bigint[])
          AND from_user_id = ANY($3::bigint[])
     )
     SELECT * FROM safety_approval_messages
      WHERE chat_id = $1
        AND (id IN (SELECT id FROM direct)
             OR (media_group_id IS NOT NULL
                 AND media_group_id IN (SELECT media_group_id FROM direct WHERE media_group_id IS NOT NULL)
                 AND from_user_id = ANY($3::bigint[])))
      ORDER BY message_id
      LIMIT $4`,
    [String(chatId), postMessageIds.map(Number), safetyUserIds.map(String), Number(limit)],
  );
  return rows.map(mapRow);
}

/** Recruiting chatter is not kept forever. Returns how many rows went. */
async function purgeOldMessages(days = 60) {
  try {
    const result = await query(
      `DELETE FROM safety_approval_messages
        WHERE captured_at < NOW() - make_interval(days => $1)`,
      [Number(days)],
    );
    return result.rowCount || 0;
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) return 0;
    throw err;
  }
}

module.exports = {
  upsertMessage,
  getMessage,
  getMediaGroup,
  listSenderMessagesAround,
  listSafetyReplies,
  purgeOldMessages,
  // database/hiringStages/threads.js reads the same rows.
  mapMessageRow: mapRow,
  __mapRowForTests: mapRow,
};
