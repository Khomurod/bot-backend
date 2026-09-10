/**
 * The person layer's admin surface — who a driver IS, and populating it.
 *
 *   GET  /identity/coverage          how much of the fleet has a person (read)
 *   GET  /identity/people/:id        one person: every chat, every truck (read)
 *   GET  /identity/backfill/preview  what a backfill WOULD do, writing nothing (read)
 *   POST /identity/backfill          run it (APPLY gate)
 *
 * The backfill exists as a route because the alternative was a shell on the
 * production host. It is the Stage 1 backfill unchanged — a dry run by default,
 * re-runnable, telegram_user_id links only — followed by the stamp of every
 * pre-existing row from the associations it created. Applying it sits on the
 * same permission as applying a correction: it writes fleet records.
 */
const express = require('express');

const { getPersonIdentity, summariseIdentityCoverage } = require('../../../database/driverPeople');
const { runIdentityBackfill } = require('../../../services/identity/personResolver');
const { sendFailure } = require('../../middleware/failureResponse');

function positiveIntParam(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function createIdentityRouter({ authMiddleware, applyMiddleware }) {
  const router = express.Router();

  router.get('/identity/coverage', authMiddleware, async (req, res) => {
    try {
      res.json({ coverage: await summariseIdentityCoverage() });
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to read identity coverage', logPrefix: '[IDENTITY]' });
    }
  });

  router.get('/identity/people/:id', authMiddleware, async (req, res) => {
    const id = positiveIntParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid person id' });
    try {
      const person = await getPersonIdentity(id);
      return person ? res.json({ person }) : res.status(404).json({ error: 'No such person' });
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to load the person', logPrefix: '[IDENTITY]' });
    }
  });

  router.get('/identity/backfill/preview', authMiddleware, async (req, res) => {
    try {
      res.json(await runIdentityBackfill({ apply: false }));
    } catch (err) {
      sendFailure(res, err, { message: 'The backfill preview failed', logPrefix: '[IDENTITY]' });
    }
  });

  router.post('/identity/backfill', applyMiddleware, async (req, res) => {
    try {
      const result = await runIdentityBackfill({ apply: true });
      console.log(`[IDENTITY] Backfill applied by ${req.admin?.username || 'admin'}:`, JSON.stringify(result.applied));
      res.json(result);
    } catch (err) {
      sendFailure(res, err, { message: 'The backfill failed', logPrefix: '[IDENTITY]' });
    }
  });

  return router;
}

module.exports = { createIdentityRouter };
