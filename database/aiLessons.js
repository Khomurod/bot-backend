'use strict';

/**
 * The questions Wenze asks the owner when it is not sure, and the lessons kept
 * from the answers. Migration 0083; see docs/architecture/ai-learning.md.
 *
 * ONE QUESTION OUT AT A TIME. `currentQuestion` is what the ask pass checks
 * before sending the next, and `answerQuestion` / `skipQuestion` only move a
 * row that is still `asked` — so a redelivered reply, or a second operator a
 * second later, changes nothing.
 *
 * A LESSON IS TAKEN BACK, NEVER DELETED. `removeLesson` sets `removed_at`; the
 * row stays, so "Wenze stopped doing X because of a lesson, removed on the 3rd"
 * is still readable.
 */
const { query } = require('./pool');

function mapQuestion(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    capability: row.capability,
    subjectKey: row.subject_key,
    context: row.context,
    ask: row.ask,
    confidence: row.confidence == null ? null : Number(row.confidence),
    status: row.status,
    askedAt: row.asked_at || null,
    answeredAt: row.answered_at || null,
    answerText: row.answer_text || null,
    lessonId: row.lesson_id == null ? null : Number(row.lesson_id),
    createdAt: row.created_at,
  };
}

function mapLesson(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    scope: row.scope,
    source: row.source,
    about: row.about,
    statement: row.statement,
    understoodAs: row.understood_as || null,
    questionId: row.question_id == null ? null : Number(row.question_id),
    createdByName: row.created_by_name || null,
    createdAt: row.created_at,
    removedAt: row.removed_at || null,
    removedBy: row.removed_by || null,
  };
}

/**
 * Queue a question. The same (capability, subject) is never queued twice, so a
 * thread that keeps being unclear is one question, not one per message.
 * @returns {Promise<object|null>} the new row, or null when already known
 */
async function queueQuestion({ capability, subjectKey, context, ask, confidence = null }) {
  const res = await query(
    `INSERT INTO ai_learning_questions (capability, subject_key, context, ask, confidence)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (capability, subject_key) DO NOTHING
     RETURNING *`,
    [capability, String(subjectKey), context, ask,
      confidence == null || !Number.isFinite(Number(confidence)) ? null : Math.round(Number(confidence))]
  );
  return mapQuestion(res.rows[0]);
}

/** The question out now and not yet answered, if any. */
async function currentQuestion() {
  const res = await query(
    `SELECT * FROM ai_learning_questions WHERE status = 'asked' ORDER BY asked_at LIMIT 1`
  );
  return mapQuestion(res.rows[0]);
}

/** The oldest question still waiting to be asked. */
async function nextQueuedQuestion() {
  const res = await query(
    `SELECT * FROM ai_learning_questions WHERE status = 'queued' ORDER BY created_at, id LIMIT 1`
  );
  return mapQuestion(res.rows[0]);
}

/** Queued → asked. Only a queued row moves, so two passes cannot both send it. */
async function markAsked(id) {
  const res = await query(
    `UPDATE ai_learning_questions SET status = 'asked', asked_at = NOW()
      WHERE id = $1 AND status = 'queued' RETURNING *`,
    [id]
  );
  return mapQuestion(res.rows[0]);
}

/** Asked → queued again, when the send could not even be recorded. */
async function unmarkAsked(id) {
  await query(
    `UPDATE ai_learning_questions SET status = 'queued', asked_at = NULL
      WHERE id = $1 AND status = 'asked' AND answered_at IS NULL`,
    [id]
  );
}

async function getQuestion(id) {
  const res = await query('SELECT * FROM ai_learning_questions WHERE id = $1', [id]);
  return mapQuestion(res.rows[0]);
}

/**
 * Asked → answered, once. The claim comes before the lesson is written, so a
 * redelivered reply finds nothing to claim and writes nothing.
 * @returns {Promise<object|null>} the claimed question, or null when already settled
 */
async function claimAnswer(id, { answerText, telegramUserId }) {
  const res = await query(
    `UPDATE ai_learning_questions
        SET status = 'answered', answered_at = NOW(), answer_text = $2,
            answered_by_telegram_id = $3
      WHERE id = $1 AND status = 'asked'
      RETURNING *`,
    [id, answerText, telegramUserId == null ? null : String(telegramUserId)]
  );
  return mapQuestion(res.rows[0]);
}

/** Asked → skipped, once. */
async function skipQuestion(id, { telegramUserId }) {
  const res = await query(
    `UPDATE ai_learning_questions
        SET status = 'skipped', answered_at = NOW(), answered_by_telegram_id = $2
      WHERE id = $1 AND status = 'asked'
      RETURNING *`,
    [id, telegramUserId == null ? null : String(telegramUserId)]
  );
  return mapQuestion(res.rows[0]);
}

async function addLesson({
  scope, source, about, statement, understoodAs = null, questionId = null,
  createdByTelegramId = null, createdByName = null,
}) {
  const res = await query(
    `INSERT INTO ai_lessons
       (scope, source, about, statement, understood_as, question_id, created_by_telegram_id, created_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [scope, source, about, statement, understoodAs, questionId,
      createdByTelegramId == null ? null : String(createdByTelegramId), createdByName]
  );
  const lesson = mapLesson(res.rows[0]);
  if (lesson && questionId) {
    await query('UPDATE ai_learning_questions SET lesson_id = $2 WHERE id = $1', [questionId, lesson.id]);
  }
  return lesson;
}

/** The lessons a prompt in this scope is given, newest first. */
async function listActiveLessons(scope, { limit = 40 } = {}) {
  const res = await query(
    `SELECT * FROM ai_lessons WHERE scope = $1 AND removed_at IS NULL
      ORDER BY created_at DESC, id DESC LIMIT $2`,
    [scope, limit]
  );
  return res.rows.map(mapLesson);
}

/** Everything, for the admin screen: live lessons first, then removed ones. */
async function listLessonsForAdmin({ limit = 200 } = {}) {
  const res = await query(
    `SELECT * FROM ai_lessons
      ORDER BY (removed_at IS NULL) DESC, created_at DESC, id DESC
      LIMIT $1`,
    [limit]
  );
  return res.rows.map(mapLesson);
}

/** @returns {Promise<object|null>} the removed lesson, or null when unknown or already removed */
async function removeLesson(id, removedBy = null) {
  const res = await query(
    `UPDATE ai_lessons SET removed_at = NOW(), removed_by = $2
      WHERE id = $1 AND removed_at IS NULL RETURNING *`,
    [id, removedBy]
  );
  return mapLesson(res.rows[0]);
}

/** Counts for the admin screen: how many wait, which one is out. */
async function summariseQuestions() {
  const res = await query(
    `SELECT status, COUNT(*)::int AS n FROM ai_learning_questions GROUP BY status`
  );
  const counts = { queued: 0, asked: 0, answered: 0, skipped: 0 };
  for (const row of res.rows) counts[row.status] = row.n;
  return counts;
}

module.exports = {
  queueQuestion,
  currentQuestion,
  nextQueuedQuestion,
  markAsked,
  unmarkAsked,
  getQuestion,
  claimAnswer,
  skipQuestion,
  addLesson,
  listActiveLessons,
  listLessonsForAdmin,
  removeLesson,
  summariseQuestions,
};
