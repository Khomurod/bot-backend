/**
 * Admin → teaching Wenze what it may tell a candidate.
 *
 * The shape of this API is the safety property. There is no endpoint that
 * writes an active fact in one call: a statement becomes a PROPOSAL with
 * Wenze's reading attached, and a second, explicit request from a person makes
 * it live. A candidate quoted a wrong pay rate is a real problem for a real
 * person, and one careless POST should not be able to cause it.
 */
const express = require('express');

const store = require('../../database/recruitingKnowledge');
const { proposeFromStatement } = require('../../services/recruiting/teach');
const { sendFailure } = require('../middleware/failureResponse');

function createRecruitingKnowledgeRouter({ authMiddleware }) {
  const router = express.Router();

  router.get('/recruiting-knowledge', authMiddleware, async (req, res) => {
    try {
      const [entries, summary] = await Promise.all([
        store.listKnowledgeForAdmin({ status: req.query.status || null }),
        store.summariseKnowledge(),
      ]);
      res.json({ entries, summary });
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to load what Wenze knows', logPrefix: '[TEACH]' });
    }
  });

  /**
   * Say something in plain language. Answers with Wenze's reading and a
   * proposal id. NOTHING is in use yet — that is the whole point.
   */
  router.post('/recruiting-knowledge', authMiddleware, async (req, res) => {
    try {
      const out = await proposeFromStatement(req.body?.statement, {
        proposedBy: req.admin?.username || null,
      });
      return res.status(201).json({
        proposal: out.proposal,
        understoodAs: out.reading.understoodAs,
        kind: out.reading.kind,
        topic: out.reading.topic,
        replaces: out.replaces,
        aiAssisted: out.reading.aiAssisted,
        // Said plainly in the response, so a client cannot present this as done.
        applied: false,
      });
    } catch (err) {
      if (/a little more/.test(err.message || '')) {
        return res.status(400).json({ error: err.message });
      }
      return sendFailure(res, err, { message: 'Failed to read that', logPrefix: '[TEACH]' });
    }
  });

  /** Agree with the reading. This is the only thing that puts a fact into use. */
  router.post('/recruiting-knowledge/:id/confirm', authMiddleware, async (req, res) => {
    try {
      const entry = await store.confirmKnowledge(Number(req.params.id), {
        confirmedBy: req.admin?.username || null,
      });
      return res.json({ entry });
    } catch (err) {
      if (/No such|already/.test(err.message || '')) {
        return res.status(409).json({ error: err.message });
      }
      return sendFailure(res, err, { message: 'Failed to confirm', logPrefix: '[TEACH]' });
    }
  });

  router.post('/recruiting-knowledge/:id/reject', authMiddleware, async (req, res) => {
    try {
      const entry = await store.rejectKnowledge(Number(req.params.id), {
        reason: req.body?.reason || null, rejectedBy: req.admin?.username || null,
      });
      if (!entry) return res.status(409).json({ error: 'That is no longer waiting for a decision.' });
      return res.json({ entry });
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to reject', logPrefix: '[TEACH]' });
    }
  });

  /** Take something out of use. The row stays; nothing is ever deleted. */
  router.post('/recruiting-knowledge/:id/retire', authMiddleware, async (req, res) => {
    try {
      const entry = await store.retireKnowledge(Number(req.params.id), {
        retiredBy: req.admin?.username || null,
      });
      if (!entry) return res.status(409).json({ error: 'That is not currently in use.' });
      return res.json({ entry });
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to retire', logPrefix: '[TEACH]' });
    }
  });

  /** What a fact used to say, all the way back. */
  router.get('/recruiting-knowledge/:id/history', authMiddleware, async (req, res) => {
    try {
      return res.json({ history: await store.knowledgeHistory(Number(req.params.id)) });
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to load the history', logPrefix: '[TEACH]' });
    }
  });

  return router;
}

module.exports = { createRecruitingKnowledgeRouter };
