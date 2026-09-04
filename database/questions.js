/**
 * Survey questions + responses.
 * Extracted verbatim from database/db.js; database/db.js re-exports these so
 * every existing `require('./db')` / `require('../database/db')` keeps working.
 */
const { pool, query } = require('./pool');

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
            ot.option_text AS english_option,
            ot_pick.option_text AS response_text,
            r.answered_at AS created_at
     FROM responses r
     JOIN drivers d ON d.id = r.driver_id
     JOIN groups g ON g.id = r.group_id
     LEFT JOIN question_translations qt ON qt.question_id = r.question_id AND qt.language = 'en'
     LEFT JOIN option_translations ot ON ot.option_id = r.option_id AND ot.language = 'en'
     LEFT JOIN LATERAL (
       SELECT option_text
       FROM option_translations ot2
       WHERE ot2.option_id = r.option_id
       ORDER BY CASE WHEN ot2.language = 'en' THEN 0 ELSE 1 END, ot2.id ASC
       LIMIT 1
     ) ot_pick ON TRUE
     WHERE r.question_id = $1
     ORDER BY r.answered_at DESC`,
    [questionId]
  );
  return res.rows;
}


module.exports = {
  createQuestion,
  getActiveQuestions,
  getAllQuestions,
  getQuestionWithOptions,
  deactivateQuestion,
  saveResponse,
  getQuestionResponses,
};
