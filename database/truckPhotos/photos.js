'use strict';

/**
 * The photos remembered from driver groups — `driver_group_photos`.
 *
 * WHY A BUFFER AT ALL. A bot cannot read a chat's history: when somebody
 * writes `outbound`, the photos before it are only available if the bot kept
 * them as they arrived. So while Truck Photos is on, every photo, every
 * picture sent "as a file" and every video (`kind = 'video'`, with its length
 * and its preview's file id — the PDF lists videos as links) in a driver group
 * is remembered here.
 *
 * TELEGRAM FILE IDS ONLY, NEVER BYTES. A file id is a few dozen characters and
 * lets this bot download the picture again when a PDF is made; the bytes stay
 * in Telegram. The database's monthly transfer allowance is the reason
 * (docs/brief/database-transfer.md): the write has no RETURNING, and the read
 * is bounded to one chat's last few hours.
 *
 * Deleted after 30 days by the hourly data-retention pass
 * (services/operations/dataRetention.js, `truckPhotoDays`).
 */

const { query } = require('../pool');

/** One chat's photos over a day are a few dozen; this is a ceiling, not a working size. */
const MAX_ROWS = 500;

function mapRow(row) {
  return {
    id: Number(row.id),
    chatId: String(row.chat_id),
    groupId: row.group_id === null || row.group_id === undefined ? null : Number(row.group_id),
    messageId: Number(row.message_id),
    mediaGroupId: row.media_group_id || null,
    fromUserId: row.from_user_id === null || row.from_user_id === undefined ? null : String(row.from_user_id),
    fromName: row.from_name || null,
    fileId: row.file_id,
    fileUniqueId: row.file_unique_id || null,
    kind: row.kind,
    width: row.width === null || row.width === undefined ? null : Number(row.width),
    height: row.height === null || row.height === undefined ? null : Number(row.height),
    fileSize: row.file_size === null || row.file_size === undefined ? null : Number(row.file_size),
    durationSeconds: row.duration_seconds === null || row.duration_seconds === undefined ? null : Number(row.duration_seconds),
    thumbFileId: row.thumb_file_id || null,
    sentAt: row.sent_at instanceof Date ? row.sent_at : new Date(row.sent_at),
    reportId: row.report_id === null || row.report_id === undefined ? null : Number(row.report_id),
  };
}

const COLUMNS = `id, chat_id, group_id, message_id, media_group_id, from_user_id, from_name, file_id,
  file_unique_id, kind, width, height, file_size, duration_seconds, thumb_file_id, sent_at, report_id`;

/**
 * Remember one photo. Telegram redelivers updates, so a second sighting of the
 * same message changes nothing.
 *
 * @returns {Promise<boolean>} true when it was new
 */
async function upsertPhoto(photo) {
  const result = await query(
    `INSERT INTO driver_group_photos
       (chat_id, group_id, message_id, media_group_id, from_user_id, from_name, file_id,
        file_unique_id, kind, width, height, file_size, sent_at, duration_seconds, thumb_file_id)
     VALUES ($1::bigint, $2, $3, $4, $5::bigint, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (chat_id, message_id) DO NOTHING`,
    [
      photo.chatId, photo.groupId, photo.messageId, photo.mediaGroupId ?? null, photo.fromUserId ?? null,
      photo.fromName ?? null, photo.fileId, photo.fileUniqueId ?? null, photo.kind,
      photo.width ?? null, photo.height ?? null, photo.fileSize ?? null, photo.sentAt,
      photo.durationSeconds ?? null, photo.thumbFileId ?? null,
    ],
  );
  return (result.rowCount || 0) > 0;
}

/** The remembered photo that is this message, or null. */
async function getPhotoByMessage(chatId, messageId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM driver_group_photos WHERE chat_id = $1::bigint AND message_id = $2`,
    [String(chatId), messageId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * One chat's photos and videos sent at or after `since` — and, when `until`
 * is given, no later than it (a reply to an old photo looks around that photo,
 * not at everything since) — oldest first.
 */
async function listPhotosSince(chatId, since, limit = MAX_ROWS, until = null) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM driver_group_photos
      WHERE chat_id = $1::bigint AND sent_at >= $2
        AND ($4::timestamptz IS NULL OR sent_at <= $4::timestamptz)
      ORDER BY sent_at, message_id
      LIMIT $3`,
    [String(chatId), since, Math.min(Math.max(Number(limit) || MAX_ROWS, 1), MAX_ROWS), until],
  );
  return rows.map(mapRow);
}

/**
 * These photos went out in report `reportId`. A photo already in another
 * report keeps that one — the first PDF it went out in is the one it belongs to.
 */
async function markPhotosInReport(photoIds, reportId) {
  const ids = (photoIds || []).map(Number).filter(Number.isInteger);
  if (!ids.length) return 0;
  const result = await query(
    `UPDATE driver_group_photos SET report_id = $2
      WHERE id = ANY($1::bigint[]) AND report_id IS NULL`,
    [ids, reportId],
  );
  return result.rowCount || 0;
}

module.exports = {
  MAX_ROWS,
  upsertPhoto,
  getPhotoByMessage,
  listPhotosSince,
  markPhotosInReport,
  __mapRowForTests: mapRow,
};
