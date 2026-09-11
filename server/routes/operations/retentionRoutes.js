/**
 * Operations → who the company may be about to lose.
 *
 * READ AND ACKNOWLEDGE, and nothing else. There is deliberately no endpoint
 * that records a decision about a driver, no field for a note about their
 * performance, and no way to mark somebody a lost cause. The screen exists so
 * that a dispatcher rings a driver who has been out five weeks with an
 * unanswered home request — and a screen that also let them file an opinion
 * would, within a month, be a performance record nobody agreed to.
 *
 * Acknowledging means "we know, we are on it". It buys silence until the
 * situation gets materially worse, never indefinitely — see `shouldNotify` in
 * database/retentionAssessments.js.
 */
const express = require('express');

const store = require('../../../database/retentionAssessments');
const { sendFailure } = require('../../middleware/failureResponse');

function createRetentionRouter({ authMiddleware }) {
  const router = express.Router();

  router.get('/retention', authMiddleware, async (req, res) => {
    try {
      const [assessments, summary] = await Promise.all([
        store.listAssessments({
          level: req.query.level || null,
          limit: Number(req.query.limit) || 50,
        }),
        store.summariseRetention(),
      ]);
      res.json({ assessments, summary });
    } catch (err) {
      sendFailure(res, err, {
        message: 'Failed to load the retention list', logPrefix: '[RETENTION]',
      });
    }
  });

  /** "We know." Pass `acknowledged: false` to undo it. */
  router.post('/retention/:id/acknowledge', authMiddleware, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'A valid assessment id is required.' });
      }
      const by = req.body?.acknowledged === false
        ? null
        : (req.admin?.username || 'an administrator');
      const row = await store.acknowledge(id, by);
      if (!row) return res.status(404).json({ error: 'No such assessment.' });
      return res.json({ assessment: row });
    } catch (err) {
      return sendFailure(res, err, {
        message: 'Failed to update the assessment', logPrefix: '[RETENTION]',
      });
    }
  });

  return router;
}

module.exports = { createRetentionRouter };
