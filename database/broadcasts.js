/**
 * Broadcast tracking (broadcasts, deliveries, button clicks).
 * Extracted verbatim from database/db.js; db.js re-exports these.
 */
const { query } = require('./pool');

// ─── Broadcast Tracking ───

async function createBroadcast(data) {
  const res = await query(
    `INSERT INTO broadcasts
      (type, message_text_en, message_text_ru, message_text_uz,
       media_items, media_position, parse_mode, buttons,
       target_type, target_driver_ids, target_languages, force_language,
       target_active_filter, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      data.type || 'regular',
      data.message_text_en || null,
      data.message_text_ru || null,
      data.message_text_uz || null,
      data.media_items ? JSON.stringify(data.media_items) : null,
      data.media_position || 'above',
      data.parse_mode || 'HTML',
      data.buttons ? JSON.stringify(data.buttons) : null,
      data.target_type || 'all',
      data.target_driver_ids || null,
      data.target_languages || null,
      data.force_language || null,
      data.target_active_filter || null,
      data.status || 'sent',
    ]
  );
  console.log(`[DB] Broadcast created: id=${res.rows[0].id}, type=${data.type || 'regular'}`);
  return res.rows[0];
}

async function createBroadcastDelivery(data) {
  const res = await query(
    `INSERT INTO broadcast_deliveries
      (broadcast_id, group_id, telegram_group_id, group_name, status, error_message)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      data.broadcast_id,
      data.group_id || null,
      data.telegram_group_id || null,
      data.group_name || null,
      data.status || 'sent',
      data.error_message || null,
    ]
  );
  return res.rows[0];
}

async function getBroadcasts(type) {
  const res = await query(
    `SELECT b.*,
       COUNT(bd.id) FILTER (WHERE bd.status = 'sent') AS sent_count,
       COUNT(bd.id) FILTER (WHERE bd.status = 'failed') AS failed_count
     FROM broadcasts b
     LEFT JOIN broadcast_deliveries bd ON bd.broadcast_id = b.id
     WHERE b.type = $1
     GROUP BY b.id
     ORDER BY b.created_at DESC
     LIMIT 50`,
    [type || 'regular']
  );
  return res.rows;
}

async function getBroadcastDeliveries(broadcastId) {
  const res = await query(
    `SELECT * FROM broadcast_deliveries WHERE broadcast_id = $1 ORDER BY sent_at ASC`,
    [broadcastId]
  );
  return res.rows;
}

async function saveBroadcastButtonClick(data) {
  const res = await query(
    `INSERT INTO broadcast_button_clicks
      (broadcast_id, button_index, button_label, driver_telegram_id,
       driver_username, driver_first_name, driver_last_name,
       group_telegram_id, group_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (broadcast_id, button_index, driver_telegram_id) DO NOTHING
     RETURNING *`,
    [
      data.broadcast_id,
      data.button_index,
      data.button_label || null,
      data.driver_telegram_id,
      data.driver_username || null,
      data.driver_first_name || null,
      data.driver_last_name || null,
      data.group_telegram_id || null,
      data.group_name || null,
    ]
  );
  return res.rows[0] || null; // null means duplicate
}

async function getBroadcastButtonClicks(broadcastId) {
  const res = await query(
    `SELECT * FROM broadcast_button_clicks WHERE broadcast_id = $1 ORDER BY clicked_at DESC`,
    [broadcastId]
  );
  return res.rows;
}


module.exports = {
  createBroadcast,
  createBroadcastDelivery,
  getBroadcasts,
  getBroadcastDeliveries,
  saveBroadcastButtonClick,
  getBroadcastButtonClicks,
};
