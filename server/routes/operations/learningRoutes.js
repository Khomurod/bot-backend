/**
 * Operations → what Wenze has suggested about its own rules.
 *
 * TWO ENDPOINTS, AND NEITHER OF THEM CHANGES ANYTHING. Read the proposals, and
 * record a decision about one. `accepted` means "yes, that is a good idea" — it
 * does not switch a check off, edit a threshold or touch a setting. Whatever the
 * suggestion proposed is still done by hand, on purpose.
 *
 * That is the owner's line held in the shape of the API: important business
 * rules must not change permanently without an administrator confirming, and
 * an endpoint that both proposed and applied would make the confirmation a
 * formality one careless click wide.
 */
const express = require('express');

const store = require('../../../database/operationalLearning');
const { sendFailure } = require('../../middleware/failureResponse');

const DECISIONS = ['accepted', 'dismissed', 'proposed'];

function createLearningRouter({ authMiddleware }) {
  const router = express.Router();

  router.get('/learning', authMiddleware, async (req, res) => {
    try {
      const [suggestions, summary] = await Promise.all([
        store.listSuggestions({
          status: req.query.status || null,
          limit: Number(req.query.limit) || 50,
        }),
        store.summariseSuggestions(),
      ]);
      res.json({ suggestions, summary });
    } catch (err) {
      sendFailure(res, err, {
        message: 'Failed to load the suggestions', logPrefix: '[LEARNING]',
      });
    }
  });

  router.post('/learning/:id/decide', authMiddleware, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'A valid suggestion id is required.' });
      }
      const status = String(req.body?.status || '');
      if (!DECISIONS.includes(status)) {
        return res.status(400).json({
          error: `Status must be one of: ${DECISIONS.join(', ')}.`,
          field: 'status',
        });
      }
      const row = await store.decideSuggestion(id, {
        status,
        decidedBy: req.admin?.username || 'an administrator',
        note: typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : null,
      });
      if (!row) return res.status(404).json({ error: 'No such suggestion.' });
      return res.json({ suggestion: row });
    } catch (err) {
      return sendFailure(res, err, {
        message: 'Failed to record the decision', logPrefix: '[LEARNING]',
      });
    }
  });

  return router;
}

module.exports = { createLearningRouter, DECISIONS };
