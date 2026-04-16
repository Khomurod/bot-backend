const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseUrl && config.databaseUrl.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : (config.databaseUrl && (config.databaseUrl.includes('supabase') || config.databaseUrl.includes('neon'))
      ? { rejectUnauthorized: false }
      : false),
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

/**
 * Initialize database tables from schema.sql
 */
async function initializeDatabase() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  try {
    await pool.query(schema);
    console.log('[DB] Database tables verified/created.');

    // Auto-tag employee group if EMPLOYEE_GROUP_ID is set
    if (config.employeeGroupId) {
      await pool.query(
        `UPDATE groups SET group_type = 'employee' WHERE telegram_group_id = $1 AND group_type != 'employee'`,
        [config.employeeGroupId]
      );
    }
  } catch (err) {
    console.error('[DB] Error initializing database:', err.message);
    throw err;
  }
}

/**
 * Query helper with logging
 */
async function query(text, params) {
  try {
    const result = await pool.query(text, params);
    return result;
  } catch (err) {
    console.error('[DB] Query error:', err.message, '\nQuery:', text);
    throw err;
  }
}

// ─── Groups ───

async function upsertGroup(telegramGroupId, groupName) {
  const res = await query(
    `INSERT INTO groups (telegram_group_id, group_name, active)
     VALUES ($1, $2, TRUE)
     ON CONFLICT (telegram_group_id)
     DO UPDATE SET group_name = EXCLUDED.group_name, active = TRUE
     RETURNING *`,
    [telegramGroupId, groupName]
  );
  console.log(`[DB] Group upserted: ${groupName} (${telegramGroupId})`);
  return res.rows[0];
}

async function getAllGroups() {
  const res = await query("SELECT * FROM groups WHERE group_type = 'driver' AND active = TRUE ORDER BY id");
  return res.rows;
}

async function deactivateGroup(telegramGroupId) {
  await query(
    'UPDATE groups SET active = FALSE WHERE telegram_group_id = $1',
    [telegramGroupId]
  );
  console.log(`[DB] Group deactivated: ${telegramGroupId}`);
}

async function getGroupByTelegramId(telegramGroupId) {
  const res = await query(
    'SELECT * FROM groups WHERE telegram_group_id = $1',
    [telegramGroupId]
  );
  return res.rows[0];
}

async function setGroupLanguage(groupId, language) {
  const res = await query(
    'UPDATE groups SET language = $1 WHERE id = $2 RETURNING *',
    [language, groupId]
  );
  return res.rows[0];
}

async function setGroupBirthday(groupId, birthday) {
  const res = await query(
    'UPDATE groups SET driver_birthday = $1 WHERE id = $2 RETURNING *',
    [birthday || null, groupId]
  );
  return res.rows[0];
}

async function getGroupsWithBirthdayToday(month, day) {
  const res = await query(
    `SELECT * FROM groups 
     WHERE group_type = 'driver' AND active = TRUE AND driver_birthday IS NOT NULL
     AND EXTRACT(MONTH FROM driver_birthday) = $1 
     AND EXTRACT(DAY FROM driver_birthday) = $2`,
    [month, day]
  );
  return res.rows;
}


// ─── Drivers ───

async function upsertDriver(telegramUserId, username, firstName, lastName) {
  const res = await query(
    `INSERT INTO drivers (telegram_user_id, username, first_name, last_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (telegram_user_id)
     DO UPDATE SET username = EXCLUDED.username,
                   first_name = EXCLUDED.first_name,
                   last_name = EXCLUDED.last_name
     RETURNING *`,
    [telegramUserId, username, firstName, lastName]
  );
  return res.rows[0];
}

async function getDriverByTelegramId(telegramUserId) {
  const res = await query(
    'SELECT * FROM drivers WHERE telegram_user_id = $1',
    [telegramUserId]
  );
  return res.rows[0];
}

// ─── Questions ───

async function createQuestion(translations, options, mediaItems, mediaPosition) {
  // translations: [{ language, question_text }]
  // options: [{ option_order, translations: [{ language, option_text }] }]
  // mediaItems: [{ file_id, media_type }] (optional array, up to 10)
  // mediaPosition: 'above' | 'below' (optional, defaults to 'above')

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const qRes = await client.query(
      `INSERT INTO questions (media_position) VALUES ($1) RETURNING *`,
      [mediaPosition || 'above']
    );
    const question = qRes.rows[0];

    // Insert question translations
    for (const t of translations) {
      await client.query(
        `INSERT INTO question_translations (question_id, language, question_text)
         VALUES ($1, $2, $3)`,
        [question.id, t.language, t.question_text]
      );
    }

    // Insert options and their translations
    for (const opt of options) {
      const oRes = await client.query(
        `INSERT INTO options (question_id, option_order)
         VALUES ($1, $2) RETURNING *`,
        [question.id, opt.option_order]
      );
      const option = oRes.rows[0];

      for (const t of opt.translations) {
        await client.query(
          `INSERT INTO option_translations (option_id, language, option_text)
           VALUES ($1, $2, $3)`,
          [option.id, t.language, t.option_text]
        );
      }
    }

    // Insert media items (if any)
    if (mediaItems && mediaItems.length > 0) {
      for (let i = 0; i < mediaItems.length; i++) {
        const m = mediaItems[i];
        await client.query(
          `INSERT INTO question_media (question_id, file_id, media_type, sort_order)
           VALUES ($1, $2, $3, $4)`,
          [question.id, m.file_id, m.media_type || 'photo', i]
        );
      }
    }

    await client.query('COMMIT');
    console.log(`[DB] Question created: id=${question.id}, media=${mediaItems?.length || 0} file(s)`);
    return question;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DB] Error creating question (rolled back):', err.message);
    throw err;
  } finally {
    client.release();
  }
}

async function getActiveQuestions() {
  const res = await query(
    `SELECT q.id, q.created_at, q.active,
            json_agg(DISTINCT jsonb_build_object(
              'language', qt.language,
              'question_text', qt.question_text
            )) AS translations
     FROM questions q
     LEFT JOIN question_translations qt ON qt.question_id = q.id
     WHERE q.active = TRUE
     GROUP BY q.id
     ORDER BY q.id DESC`
  );
  return res.rows;
}

async function getAllQuestions() {
  const res = await query(
    `SELECT q.id, q.created_at, q.active, q.media_position,
            (SELECT COUNT(*) FROM question_media qm WHERE qm.question_id = q.id)::int AS media_count,
            json_agg(DISTINCT jsonb_build_object(
              'language', qt.language,
              'question_text', qt.question_text
            )) AS translations
     FROM questions q
     LEFT JOIN question_translations qt ON qt.question_id = q.id
     GROUP BY q.id
     ORDER BY q.id DESC`
  );
  return res.rows;
}

async function getQuestionWithOptions(questionId) {
  const qRes = await query(
    `SELECT q.*, json_agg(DISTINCT jsonb_build_object(
        'language', qt.language,
        'question_text', qt.question_text
     )) AS translations
     FROM questions q
     LEFT JOIN question_translations qt ON qt.question_id = q.id
     WHERE q.id = $1
     GROUP BY q.id`,
    [questionId]
  );

  if (qRes.rows.length === 0) return null;
  const question = qRes.rows[0];

  const oRes = await query(
    `SELECT o.id, o.option_order,
            json_agg(jsonb_build_object(
              'language', ot.language,
              'option_text', ot.option_text
            )) AS translations
     FROM options o
     LEFT JOIN option_translations ot ON ot.option_id = o.id
     WHERE o.question_id = $1
     GROUP BY o.id
     ORDER BY o.option_order`,
    [questionId]
  );

  // Fetch media items ordered by sort_order
  const mRes = await query(
    `SELECT file_id, media_type, sort_order
     FROM question_media
     WHERE question_id = $1
     ORDER BY sort_order ASC`,
    [questionId]
  );

  question.options = oRes.rows;
  question.media_items = mRes.rows; // [{ file_id, media_type, sort_order }]
  return question;
}

async function deactivateQuestion(questionId) {
  await query('UPDATE questions SET active = FALSE WHERE id = $1', [questionId]);
}

// ─── Responses ───

async function saveResponse(driverId, groupId, questionId, optionId) {
  const res = await query(
    `INSERT INTO responses (driver_id, group_id, question_id, option_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (driver_id, question_id) DO NOTHING
     RETURNING *`,
    [driverId, groupId, questionId, optionId]
  );
  if (res.rows.length === 0) {
    console.log(`[DB] Duplicate response ignored: driver=${driverId}, question=${questionId}`);
    return null; // duplicate
  }
  console.log(`[DB] Response saved: driver=${driverId}, question=${questionId}, option=${optionId}`);
  return res.rows[0];
}

async function getQuestionResponses(questionId) {
  const res = await query(
    `SELECT r.*, d.username, d.first_name, d.last_name,
            g.group_name, g.language AS group_language,
            qt.question_text AS english_question,
            ot.option_text AS english_option
     FROM responses r
     JOIN drivers d ON d.id = r.driver_id
     JOIN groups g ON g.id = r.group_id
     LEFT JOIN question_translations qt ON qt.question_id = r.question_id AND qt.language = 'en'
     LEFT JOIN option_translations ot ON ot.option_id = r.option_id AND ot.language = 'en'
     WHERE r.question_id = $1
     ORDER BY r.answered_at DESC`,
    [questionId]
  );
  return res.rows;
}

// ─── Admins ───

async function getAdminByUsername(username) {
  const res = await query('SELECT * FROM admins WHERE username = $1', [username]);
  return res.rows[0];
}

async function createAdmin(username, passwordHash) {
  const res = await query(
    `INSERT INTO admins (username, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING *`,
    [username, passwordHash]
  );
  return res.rows[0];
}

// ─── Scheduled Messages ───

async function getAllDriverGroups() {
  const res = await query("SELECT * FROM groups WHERE group_type = 'driver' AND active = TRUE ORDER BY id");
  return res.rows;
}

async function createScheduledMessage(data) {
  const res = await query(
    `INSERT INTO scheduled_messages
      (message_text_en, message_text_ru, message_text_uz,
       media_file_id, media_type, media_position,
       target_type, target_driver_ids, target_languages,
       force_language, scheduled_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending')
     RETURNING *`,
    [
      data.message_text_en, data.message_text_ru || null, data.message_text_uz || null,
      data.media_file_id || null, data.media_type || null, data.media_position || 'above',
      data.target_type || 'all', data.target_driver_ids || null, data.target_languages || null,
      data.force_language || null, data.scheduled_at,
    ]
  );
  console.log(`[DB] Scheduled message created: id=${res.rows[0].id}, at=${data.scheduled_at}`);
  return res.rows[0];
}

async function getPendingScheduledMessages() {
  const res = await query(
    `SELECT * FROM scheduled_messages
     WHERE status = 'pending' AND scheduled_at <= NOW()
     ORDER BY scheduled_at ASC`
  );
  return res.rows;
}

async function getAllScheduledMessages() {
  const res = await query(
    `SELECT * FROM scheduled_messages ORDER BY created_at DESC`
  );
  return res.rows;
}

async function getScheduledMessageById(id) {
  const res = await query('SELECT * FROM scheduled_messages WHERE id = $1', [id]);
  return res.rows[0];
}

async function updateScheduledMessageStatus(id, status) {
  const res = await query(
    'UPDATE scheduled_messages SET status = $1 WHERE id = $2 RETURNING *',
    [status, id]
  );
  return res.rows[0];
}

async function deleteScheduledMessage(id) {
  await query('DELETE FROM scheduled_messages WHERE id = $1', [id]);
}

async function getGroupsByIds(ids) {
  if (!ids || ids.length === 0) return [];
  const res = await query(
    `SELECT * FROM groups WHERE id = ANY($1) AND group_type = 'driver' AND active = TRUE ORDER BY id`,
    [ids]
  );
  return res.rows;
}

async function getGroupsByLanguages(languages) {
  if (!languages || languages.length === 0) return [];
  const res = await query(
    `SELECT * FROM groups WHERE language = ANY($1) AND group_type = 'driver' AND active = TRUE ORDER BY id`,
    [languages]
  );
  return res.rows;
}

// ─── Broadcast Tracking ───

async function createBroadcast(data) {
  const res = await query(
    `INSERT INTO broadcasts
      (type, message_text_en, message_text_ru, message_text_uz,
       media_items, media_position, parse_mode, buttons,
       target_type, target_driver_ids, target_languages, force_language, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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

// ─── Chat Logs ───

async function logChatMessage(groupId, telegramUserId, senderName, messageText) {
  await query(
    `INSERT INTO chat_logs (group_id, telegram_user_id, sender_name, message_text)
     VALUES ($1, $2, $3, $4)`,
    [groupId, telegramUserId, senderName, messageText]
  );
}

async function getChatLogsForGroup(groupId, daysBack) {
  const res = await query(
    `SELECT * FROM chat_logs
     WHERE group_id = $1 AND created_at >= NOW() - ($2 || ' days')::INTERVAL
     ORDER BY created_at ASC`,
    [groupId, daysBack]
  );
  return res.rows;
}

async function deleteOldChatLogs(daysOld) {
  await query(
    `DELETE FROM chat_logs WHERE created_at < NOW() - ($1 || ' days')::INTERVAL`,
    [daysOld]
  );
}

async function getRecentChatLogs(limit = 50) {
  const res = await query(
    `SELECT c.id, c.sender_name, c.message_text, c.created_at, g.group_name
     FROM chat_logs c
     JOIN groups g ON c.group_id = g.id
     ORDER BY c.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return res.rows;
}


async function upsertEmployeeBirthday(firstName, lastName, birthday) {
  const res = await query(
    `INSERT INTO employee_birthdays (first_name, last_name, birthday)
     VALUES ($1, $2, $3)
     ON CONFLICT (first_name, last_name) DO UPDATE SET birthday = EXCLUDED.birthday
     RETURNING *`,
    [firstName, lastName, birthday]
  );
  return res.rows[0];
}

async function getAllEmployeeBirthdays() {
  const res = await query('SELECT * FROM employee_birthdays ORDER BY created_at DESC');
  return res.rows;
}

async function getEmployeesWithBirthdayToday(month, day) {
  const res = await query(
    `SELECT * FROM employee_birthdays 
     WHERE EXTRACT(MONTH FROM birthday) = $1 AND EXTRACT(DAY FROM birthday) = $2`,
    [month, day]
  );
  return res.rows;
}

module.exports = {
  pool,
  query,
  initializeDatabase,
  // Groups
  upsertGroup,
  getAllGroups,
  getAllDriverGroups,
  getGroupByTelegramId,
  setGroupLanguage,
  setGroupBirthday,
  getGroupsWithBirthdayToday,
  getGroupsByIds,
  getGroupsByLanguages,
  deactivateGroup,
  // Drivers
  upsertDriver,
  getDriverByTelegramId,
  // Questions
  createQuestion,
  getActiveQuestions,
  getAllQuestions,
  getQuestionWithOptions,
  deactivateQuestion,
  // Responses
  saveResponse,
  getQuestionResponses,
  // Admins
  getAdminByUsername,
  createAdmin,
  // Scheduled Messages
  createScheduledMessage,
  getPendingScheduledMessages,
  getAllScheduledMessages,
  getScheduledMessageById,
  updateScheduledMessageStatus,
  deleteScheduledMessage,
  // Broadcast Tracking
  createBroadcast,
  createBroadcastDelivery,
  getBroadcasts,
  getBroadcastDeliveries,
  saveBroadcastButtonClick,
  getBroadcastButtonClicks,
  // Chat Logs
  logChatMessage,
  getChatLogsForGroup,
  deleteOldChatLogs,
  getRecentChatLogs,
  // Employee Birthdays
  upsertEmployeeBirthday,
  getAllEmployeeBirthdays,
  getEmployeesWithBirthdayToday,
};
