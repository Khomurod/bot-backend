'use strict';

/**
 * Admin → Settings → AI → "What Wenze learned from you".
 *
 *   GET    /ai/lessons                      every lesson (live first), the
 *                                           question out now, and the counts
 *   DELETE /ai/lessons/:id                  take a lesson back (kept, marked
 *                                           removed — never deleted)
 *   POST   /ai/lessons/questions/skip       skip the question out now, so the
 *                                           next one can be asked
 *
 * The "Ask me when unsure" switch is `learningEnabled` on PUT /ai, with the
 * other AI settings. See docs/architecture/ai-learning.md.
 */
const express = require('express');

const lessons = require('../../../database/aiLessons');
const { insertAdminAudit } = require('../../../database/adminAudit');
const { invalidateLessons } = require('../../../services/ai/learning/hooks');
const { askNextQuestion } = require('../../../services/ai/learning/askOwner');
const { SCOPE_LABELS } = require('../../../lib/ai/lessons');
const { sendFailure } = require('../../middleware/failureResponse');

function audit(req, action, entityId, values) {
  return insertAdminAudit({
    adminId: req.admin?.id ?? null,
    roleKeys: req.admin?.roleKeys || [],
    action,
    entityType: 'ai_lessons',
    entityId: String(entityId),
    oldValues: null,
    newValues: values,
  }).catch(() => null);
}

function createAiLessonsRouter({ authMiddleware }) {
  const router = express.Router();

  router.get('/ai/lessons', authMiddleware, async (req, res) => {
    try {
      const [list, current, counts] = await Promise.all([
        lessons.listLessonsForAdmin(),
        lessons.currentQuestion(),
        lessons.summariseQuestions(),
      ]);
      res.json({ lessons: list, current, counts, scopes: SCOPE_LABELS });
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to load the lessons', logPrefix: '[AI LESSONS]' });
    }
  });

  router.delete('/ai/lessons/:id', authMiddleware, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'A lesson id is required' });
    try {
      const removed = await lessons.removeLesson(id, req.admin?.username || null);
      if (!removed) return res.status(404).json({ error: 'No such lesson, or it was already removed' });
      invalidateLessons(removed.scope);
      await audit(req, 'ai_lesson.remove', id, { scope: removed.scope, source: removed.source });
      return res.json({ lesson: removed });
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to remove the lesson', logPrefix: '[AI LESSONS]' });
    }
  });

  router.post('/ai/lessons/questions/skip', authMiddleware, async (req, res) => {
    try {
      const current = await lessons.currentQuestion();
      if (!current) return res.status(404).json({ error: 'No question is waiting for an answer' });
      const skipped = await lessons.skipQuestion(current.id, { telegramUserId: null });
      if (skipped) await audit(req, 'ai_learning_question.skip', current.id, { capability: current.capability });
      const next = await askNextQuestion();
      return res.json({ skipped: Boolean(skipped), next });
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to skip the question', logPrefix: '[AI LESSONS]' });
    }
  });

  return router;
}

module.exports = { createAiLessonsRouter };
