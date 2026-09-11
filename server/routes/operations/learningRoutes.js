/**
 * Operations → what Wenze has suggested about its own rules.
 *
 * WHAT CHANGED HERE, AND WHY IT IS STILL SAFE. Accepting used to write a word
 * in a table and change nothing — the previous comment in this file said so and
 * treated it as the safety property. It is half of one. The guarantee worth
 * keeping is that AI cannot change a business rule BY ITSELF, and that is kept
 * by requiring an administrator's confirmation, not by making the confirmation
 * inert. Somebody who accepted "switch automatic correction off for this check"
 * reasonably believed they had switched it off. They had not.
 *
 * So accepting now runs the suggestion's registered action WHEN IT HAS ONE, and
 * says plainly when it does not:
 *
 *   accepted_active   a setting was changed; `applied_before` holds what it was
 *   accepted_manual   agreement recorded; a person still has to do the thing
 *
 * THE APPLY GATE, not the read gate, guards accept and revert — the same
 * distinction the corrections routes make between seeing a proposal and
 * changing a record. And the registry those actions come from holds exactly
 * one: turn a check's automatic correction OFF. There is nothing in it that
 * turns automation on, and nothing that touches pay, employment, hiring, start
 * dates, safety discipline or code.
 */
const express = require('express');

const store = require('../../../database/operationalLearning');
const decision = require('../../../services/operations/learningDecision');
const { sendFailure } = require('../../middleware/failureResponse');

/** `/decide` keeps only the decisions that change nothing by themselves. */
const DECISIONS = ['dismissed', 'proposed'];

function createLearningRouter({ authMiddleware, applyMiddleware = authMiddleware }) {
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
          // Accepting goes through /accept, which may actually change a
          // setting and therefore needs the apply gate. Routing it here would
          // make the confirmation one careless click wide.
          error: `Status must be one of: ${DECISIONS.join(', ')}. Use /accept to accept.`,
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

  /**
   * Accept. Runs the registered action when there is one; records agreement
   * when there is not, and says which happened.
   */
  router.post('/learning/:id/accept', applyMiddleware, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'A valid suggestion id is required.' });
      }
      const out = await decision.acceptSuggestion(id, {
        admin: { ...(req.admin || {}), ip: req.ip },
        note: typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : null,
      });
      if (!out) return res.status(404).json({ error: 'No such suggestion.' });
      return res.json(out);
    } catch (err) {
      return sendFailure(res, err, {
        message: 'Failed to accept the suggestion', logPrefix: '[LEARNING]',
      });
    }
  });

  /** Undo one that was applied, from the values it recorded before changing them. */
  router.post('/learning/:id/revert', applyMiddleware, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'A valid suggestion id is required.' });
      }
      const out = await decision.revertSuggestion(id, {
        admin: { ...(req.admin || {}), ip: req.ip },
        note: typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : null,
      });
      if (!out) return res.status(404).json({ error: 'No such suggestion.' });
      return res.json(out);
    } catch (err) {
      return sendFailure(res, err, {
        message: 'Failed to undo the suggestion', logPrefix: '[LEARNING]',
      });
    }
  });

  return router;
}

module.exports = { createLearningRouter, DECISIONS };
