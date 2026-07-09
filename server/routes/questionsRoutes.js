/**
 * Survey questions admin routes: CRUD, send-to-groups, send-test, plus the
 * per-question response listing and the translation helper endpoint.
 *
 * Routes use their full paths; the router is mounted at the app root so
 * matching behavior is identical to the previous inline definitions.
 */
const express = require('express');
const { getNormalizedMediaItemsFromBody } = require('./helpers/broadcastBodyHelpers');

function createQuestionsRoutes({
  db,
  authMiddleware,
  sendQuestionToGroups,
  sendTestQuestion,
  translateBatch,
}) {
  const router = express.Router();

  // GET /api/questions
  router.get('/api/questions', authMiddleware, async (req, res) => {
    try {
      const questions = await db.getAllQuestions();
      res.json(questions);
    } catch (err) {
      console.error('[API] Error fetching questions:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/questions/:id
  router.get('/api/questions/:id', authMiddleware, async (req, res) => {
    try {
      const question = await db.getQuestionWithOptions(req.params.id);
      if (!question) {
        return res.status(404).json({ error: 'Question not found' });
      }
      res.json(question);
    } catch (err) {
      console.error('[API] Error fetching question:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // POST /api/questions
  router.post('/api/questions', authMiddleware, async (req, res) => {
    try {
      const { translations, options } = req.body;

      // Validate translations
      if (!translations || !Array.isArray(translations) || translations.length === 0) {
        return res.status(400).json({ error: 'Translations are required' });
      }

      // Ensure all 3 languages are present
      const langs = translations.map((t) => t.language);
      if (!langs.includes('en') || !langs.includes('ru') || !langs.includes('uz')) {
        return res.status(400).json({ error: 'Translations for en, ru, and uz are required' });
      }

      // Validate options
      if (!options || !Array.isArray(options) || options.length === 0) {
        return res.status(400).json({ error: 'At least one option is required' });
      }

      for (const opt of options) {
        if (!opt.translations || opt.translations.length < 3) {
          return res.status(400).json({ error: 'Each option must have translations for en, ru, and uz' });
        }
      }

      // Optional media items — validate if provided
      let mediaItems = null;
      try {
        mediaItems = getNormalizedMediaItemsFromBody(req.body);
      } catch (mediaErr) {
        return res.status(400).json({ error: mediaErr.message });
      }

      const mediaPosition = req.body.media_position;
      if (mediaPosition && !['above', 'below'].includes(mediaPosition)) {
        return res.status(400).json({ error: 'media_position must be above or below' });
      }

      const question = await db.createQuestion(translations, options, mediaItems, mediaPosition || 'above');
      const full = await db.getQuestionWithOptions(question.id);
      res.status(201).json(full);
    } catch (err) {
      console.error('[API] Error creating question:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // PUT /api/questions/:id/deactivate
  router.put('/api/questions/:id/deactivate', authMiddleware, async (req, res) => {
    try {
      await db.deactivateQuestion(req.params.id);
      res.json({ success: true });
    } catch (err) {
      console.error('[API] Error deactivating question:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // POST /api/questions/:id/send
  router.post('/api/questions/:id/send', authMiddleware, async (req, res) => {
    try {
      const questionId = parseInt(req.params.id, 10);
      const results = await sendQuestionToGroups(questionId);
      res.json(results);
    } catch (err) {
      console.error('[API] Error sending question:', err.message);
      res.status(500).json({ error: err.message || 'Server error' });
    }
  });

  // POST /api/questions/send-test
  router.post('/api/questions/send-test', authMiddleware, async (req, res) => {
    try {
      const { question_en, options_en } = req.body;

      if (!question_en || !question_en.trim()) {
        return res.status(400).json({ error: 'English question text is required' });
      }

      if (!options_en || !Array.isArray(options_en) || options_en.length < 2) {
        return res.status(400).json({ error: 'At least 2 English options are required' });
      }

      const emptyOpt = options_en.find((o) => !o || !o.trim());
      if (emptyOpt !== undefined) {
        return res.status(400).json({ error: 'All options must have non-empty English text' });
      }

      let mediaItems = null;
      const mediaPosition = req.body.media_position || 'above';
      try {
        mediaItems = getNormalizedMediaItemsFromBody(req.body);
      } catch (mediaErr) {
        return res.status(400).json({ error: mediaErr.message });
      }

      await sendTestQuestion(question_en.trim(), options_en.map((o) => o.trim()), mediaItems, mediaPosition);
      res.json({ success: true });
    } catch (err) {
      console.error('[API] Error sending test question:', err.message);
      res.status(500).json({ error: err.message || 'Failed to send test question' });
    }
  });

  // ─── Translation Routes ───

  // POST /api/translate
  router.post('/api/translate', authMiddleware, async (req, res) => {
    try {
      const { source_language, target_languages, text_blocks } = req.body;

      // Validate input
      if (!text_blocks || !Array.isArray(text_blocks) || text_blocks.length === 0) {
        return res.status(400).json({ error: 'text_blocks array is required' });
      }

      if (text_blocks.length > 20) {
        return res.status(400).json({ error: 'Maximum 20 text blocks allowed per request' });
      }

      const totalLength = text_blocks.reduce((sum, t) => sum + (t?.length || 0), 0);
      if (totalLength > 4096) {
        return res.status(400).json({ error: 'Total text exceeds 4096 character limit' });
      }

      const targets = target_languages || ['ru', 'uz'];
      const validLangs = ['ru', 'uz'];
      for (const lang of targets) {
        if (!validLangs.includes(lang)) {
          return res.status(400).json({ error: `Invalid target language: ${lang}` });
        }
      }

      const result = {};
      for (const lang of targets) {
        result[lang] = await translateBatch(text_blocks, lang);
      }

      res.json(result);
    } catch (err) {
      // The integrated AI (Groq/Gemini) has no key configured — tell the admin
      // exactly what to fix instead of a generic failure.
      if (err.code === 'AI_NOT_CONFIGURED') {
        return res.status(503).json({ error: err.message });
      }
      console.error('[API] Translation error:', err.message);
      res.status(500).json({ error: 'Translation failed. Please try again.' });
    }
  });

  // ─── Responses Routes ───

  // GET /api/responses/:questionId
  router.get('/api/responses/:questionId', authMiddleware, async (req, res) => {
    try {
      const responses = await db.getQuestionResponses(req.params.questionId);
      res.json(responses);
    } catch (err) {
      console.error('[API] Error fetching responses:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
}

module.exports = { createQuestionsRoutes };
