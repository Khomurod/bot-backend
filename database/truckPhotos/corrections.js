'use strict';

/**
 * What a correction needs to remember about a hand-over PDF (migration 0109):
 * which message in a chat is which report (`truck_photo_report_messages`),
 * what each version held (`truck_photo_report_items`), and the corrections a
 * person asked for (`truck_photo_reports.edits`, `version`).
 *
 * A NEW VERSION IS WRITTEN ONLY OVER THE VERSION IT WAS BUILT FROM
 * (`saveVersion`'s `WHERE version = $from`), so two corrections that raced
 * cannot both land; the queue runs them one at a time anyway
 * (services/truckPhotos/triggerHandler.js).
 *
 * Nothing here holds message text, a photo or a PDF.
 */

const { query } = require('../pool');
const { COLUMNS: PHOTO_COLUMNS, mapPhotoRow } = require('./photos');

/** The buffer's columns, from its alias `p`. */
const P_COLUMNS = PHOTO_COLUMNS.split(',').map((c) => `p.${c.trim()}`).join(', ');

const PLACES = Object.freeze(['truck', 'form', 'left_out', 'video']);

function mapReport(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    chatId: String(row.chat_id),
    groupId: row.group_id === null || row.group_id === undefined ? null : Number(row.group_id),
    groupName: row.group_name || null,
    triggerMessageId: Number(row.trigger_message_id),
    kind: row.kind,
    status: row.status,
    version: Number(row.version) || 1,
    edits: row.edits && typeof row.edits === 'object' ? row.edits : {},
    photosFrom: row.photos_from || null,
    photosUntil: row.photos_until || null,
    triggeredByName: row.triggered_by_name || null,
    createdAt: row.created_at || null,
  };
}

const REPORT_COLUMNS = `r.id, r.chat_id, r.group_id, g.group_name, r.trigger_message_id, r.kind, r.status,
  r.version, r.edits, r.photos_from, r.photos_until, r.triggered_by_name, r.created_at`;

/** The report a message in a chat belongs to: `{report, version, part}` or null. */
async function findByMessage(chatId, messageId) {
  const { rows } = await query(
    `SELECT ${REPORT_COLUMNS}, m.version AS message_version, m.part
       FROM truck_photo_report_messages m
       JOIN truck_photo_reports r ON r.id = m.report_id
       LEFT JOIN groups g ON g.id = r.group_id
      WHERE m.chat_id = $1::bigint AND m.message_id = $2`,
    [String(chatId), messageId],
  );
  if (!rows[0]) return null;
  return { report: mapReport(rows[0]), version: Number(rows[0].message_version), part: Number(rows[0].part) };
}

/** The report a hand-over word in a driver group made, or null. */
async function findByTrigger(chatId, triggerMessageId) {
  const { rows } = await query(
    `SELECT ${REPORT_COLUMNS} FROM truck_photo_reports r
       LEFT JOIN groups g ON g.id = r.group_id
      WHERE r.chat_id = $1::bigint AND r.trigger_message_id = $2`,
    [String(chatId), triggerMessageId],
  );
  return mapReport(rows[0]);
}

async function getReport(reportId) {
  const { rows } = await query(
    `SELECT ${REPORT_COLUMNS} FROM truck_photo_reports r
       LEFT JOIN groups g ON g.id = r.group_id
      WHERE r.id = $1`,
    [reportId],
  );
  return mapReport(rows[0]);
}

/**
 * What a version held, in PDF order, with each photo's buffer row: the photos
 * still kept (a photo deleted after 30 days takes its item with it).
 */
async function listItems(reportId, version) {
  const { rows } = await query(
    `SELECT i.place, i.position, i.kind AS sorted_kind, i.confidence, ${P_COLUMNS}
       FROM truck_photo_report_items i
       JOIN driver_group_photos p ON p.id = i.photo_id
      WHERE i.report_id = $1 AND i.version = $2
      ORDER BY p.sent_at, p.message_id`,
    [reportId, version],
  );
  return rows.map((r) => ({
    place: r.place,
    position: r.position === null ? null : Number(r.position),
    verdict: r.sorted_kind
      ? { kind: r.sorted_kind, what: null, confidence: r.confidence === null ? null : Number(r.confidence) }
      : null,
    photo: mapPhotoRow(r),
  }));
}

/** Buffer rows by id, in the order they were sent. */
async function getPhotos(photoIds) {
  const ids = (photoIds || []).map(Number).filter(Number.isInteger);
  if (!ids.length) return [];
  const { rows } = await query(
    `SELECT ${P_COLUMNS} FROM driver_group_photos p WHERE p.id = ANY($1::bigint[]) ORDER BY p.sent_at, p.message_id`,
    [ids],
  );
  return rows.map(mapPhotoRow);
}

/**
 * Remember what a version held and where it went: its items, and the
 * messages it became. Re-recording the same message or item is a no-op.
 *
 * @param {object} args
 * @param {Array<{photoId: number, place: string, position?: number|null, kind?: string|null, confidence?: number|null}>} [args.items]
 * @param {Array<{chatId: string|number, messageId: number, part: number}>} [args.messages]
 */
async function recordVersion({
  reportId, version, items = [], messages = [],
}) {
  const kept = items.filter((i) => Number.isInteger(Number(i.photoId)) && PLACES.includes(i.place));
  if (kept.length) {
    await query(
      `INSERT INTO truck_photo_report_items (report_id, version, photo_id, place, position, kind, confidence)
       SELECT $1, $2, x.photo_id, x.place, x.position, x.kind, x.confidence
         FROM jsonb_to_recordset($3::jsonb)
              AS x(photo_id BIGINT, place TEXT, position INTEGER, kind TEXT, confidence SMALLINT)
       ON CONFLICT (report_id, version, photo_id) DO NOTHING`,
      [reportId, version, JSON.stringify(kept.map((i) => ({
        photo_id: Number(i.photoId),
        place: i.place,
        position: i.position ?? null,
        kind: i.kind ?? null,
        confidence: Number.isFinite(Number(i.confidence)) && i.confidence !== null ? Math.round(Number(i.confidence)) : null,
      })))],
    );
  }
  await recordMessages({ reportId, version, messages });
}

async function recordMessages({ reportId, version, messages = [] }) {
  const kept = messages.filter((m) => m && Number.isInteger(Number(m.messageId)) && m.chatId !== undefined && m.chatId !== null);
  if (!kept.length) return;
  await query(
    `INSERT INTO truck_photo_report_messages (chat_id, message_id, report_id, version, part)
     SELECT x.chat_id, x.message_id, $1, $2, x.part
       FROM jsonb_to_recordset($3::jsonb) AS x(chat_id BIGINT, message_id BIGINT, part INTEGER)
     ON CONFLICT (chat_id, message_id) DO NOTHING`,
    [reportId, version, JSON.stringify(kept.map((m) => ({
      chat_id: String(m.chatId), message_id: Number(m.messageId), part: Number(m.part) || 0,
    })))],
  );
}

/** The newest PDF message of a report in a chat (its first part), to reply under. */
async function latestPdfMessage(reportId, chatId) {
  const { rows } = await query(
    `SELECT message_id FROM truck_photo_report_messages
      WHERE report_id = $1 AND chat_id = $2::bigint AND part >= 1
      ORDER BY version DESC, part ASC
      LIMIT 1`,
    [reportId, String(chatId)],
  );
  return rows[0] ? Number(rows[0].message_id) : null;
}

/** The time the photos were first chosen from. */
async function saveWindow(reportId, { from, until }) {
  await query(
    'UPDATE truck_photo_reports SET photos_from = $2, photos_until = $3 WHERE id = $1',
    [reportId, from || null, until || null],
  );
}

/**
 * Write the next version over the one it was built from. `kind` may change
 * (outbound ↔ inbound); `cancelled` closes the report.
 *
 * @returns {Promise<boolean>} false when another version landed first
 */
async function saveVersion(reportId, {
  fromVersion, kind, status = 'sent', edits, correctedByName = null, reason = null,
  photoCount = 0, excludedCount = 0, parts = 0, videoCount = 0, aiAssisted = false, aiProvider = null,
}) {
  const result = await query(
    `UPDATE truck_photo_reports
        SET version = version + 1, kind = $3, status = $4, edits = $5::jsonb,
            corrected_at = NOW(), corrected_by_name = $6, reason = $7,
            photo_count = $8, excluded_count = $9, parts = $10, video_count = $11,
            ai_assisted = ai_assisted OR $12, ai_provider = COALESCE($13, ai_provider),
            sent_at = CASE WHEN $4 = 'sent' THEN NOW() ELSE sent_at END
      WHERE id = $1 AND version = $2`,
    [reportId, fromVersion, kind, status, JSON.stringify(edits || {}), correctedByName, reason,
      photoCount, excludedCount, parts, videoCount, Boolean(aiAssisted), aiProvider],
  );
  return (result.rowCount || 0) > 0;
}

/**
 * The photos in a report are exactly `photoIds` now: those are marked as sent
 * in it (never one another report already sent), and its photos that are no
 * longer in it are freed for the next word.
 */
async function setReportPhotos(reportId, photoIds) {
  const ids = (photoIds || []).map(Number).filter(Number.isInteger);
  await query(
    `UPDATE driver_group_photos SET report_id = NULL
      WHERE report_id = $1 AND NOT (id = ANY($2::bigint[]))`,
    [reportId, ids],
  );
  if (!ids.length) return;
  await query(
    `UPDATE driver_group_photos SET report_id = $2
      WHERE id = ANY($1::bigint[]) AND (report_id IS NULL OR report_id = $2)`,
    [ids, reportId],
  );
}

module.exports = {
  PLACES,
  findByMessage,
  findByTrigger,
  getReport,
  listItems,
  getPhotos,
  recordVersion,
  recordMessages,
  latestPdfMessage,
  saveWindow,
  saveVersion,
  setReportPhotos,
};
