'use strict';

/**
 * Monitoring → Logs (owner, 14 November 2026): every Bitrix change the app
 * made — who, what, why — and every attempt that was refused or failed.
 *
 *   GET /api/activity-log   a page of 50, newest first;
 *                           ?from= &to= (ISO dates) &trigger= &result= &search= &before=
 *
 * SUPER ADMINISTRATORS ONLY, by role (the owner's decision): the entries name
 * people and the deals they touched. Read-only — no retry, no revert. The
 * logic is services/activityLog/admin.js; this file only guards and answers.
 */
const express = require('express');
const service = require('../../services/activityLog/admin');
const { requireSuperAdmin } = require('../middleware/auth');

function createActivityLogRouter({ authMiddleware, activityLog = service }) {
  const router = express.Router();
  router.get('/', authMiddleware, requireSuperAdmin, async (req, res) => {
    try {
      res.json(await activityLog.listActivity(req.query || {}));
    } catch (err) {
      if (err instanceof service.FilterError) return res.status(400).json({ error: err.message });
      // A database error carries no value of ours, but keep only its class.
      console.error('[ACTIVITY-LOG API] list failed:', err && err.code ? err.code : 'error');
      return res.status(500).json({ error: 'Could not load the logs' });
    }
    return undefined;
  });
  return router;
}

module.exports = { createActivityLogRouter };
