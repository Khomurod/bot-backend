'use strict';

/**
 * Settings → Facebook ↔ Bitrix — the Meta Conversions API for CRM credentials.
 *
 *   GET  /meta-crm          → status, dataset id and its source, the token's
 *                             last four characters only, the last run
 *   POST /meta-crm/test     → checks a–d on UNSAVED values (rate-limited: it
 *                             calls Meta and Bitrix)
 *   PUT  /meta-crm          → save; re-proves check (a) on the server and stores
 *                             nothing that fails it; switches the sync on
 *   PUT  /meta-crm/enabled  → the ON/OFF switch; nothing stored is removed
 *
 * THE TOKEN TRAVELS ONLY IN A REQUEST BODY, is never in a response, and never
 * in a log line: a failure is logged with the token taken out of its message.
 * The logic is services/metaCrm/settingsService.js.
 */
const express = require('express');
const service = require('../../../services/metaCrm/settingsService');
const { createRateLimiter } = require('../../middleware/rateLimit');
const { redactSecret } = require('../../../lib/security/redactSecret');

const TEST_WINDOW_MS = 5 * 60 * 1000;
const TEST_MAX_PER_WINDOW = 10;

const who = (req) => (req.admin && req.admin.username) || null;

function failed(res, req, err, what) {
  if (err.statusCode === 400) {
    return res.status(400).json({ error: err.message, ...(err.check ? { check: err.check } : {}) });
  }
  console.error(`[SETTINGS API] meta-crm ${what} failed:`, redactSecret(err.message, req.body?.token));
  return res.status(500).json({ error: `Failed to ${what} the Facebook ↔ Bitrix settings` });
}

function createMetaCrmSettingsRouter({ authMiddleware, settingsService = service, testLimiter = null }) {
  const router = express.Router();
  const limitTests = testLimiter || createRateLimiter({
    windowMs: TEST_WINDOW_MS,
    max: TEST_MAX_PER_WINDOW,
    message: 'Too many tests in a few minutes — each one asks Meta and Bitrix. Wait a little and test again.',
  });

  router.get('/meta-crm', authMiddleware, async (req, res) => {
    try {
      return res.json({ settings: await settingsService.getSettingsView() });
    } catch (err) {
      return failed(res, req, err, 'load');
    }
  });

  router.post('/meta-crm/test', authMiddleware, limitTests, async (req, res) => {
    try {
      return res.json(await settingsService.testSettings(req.body || {}));
    } catch (err) {
      return failed(res, req, err, 'test');
    }
  });

  router.put('/meta-crm', authMiddleware, async (req, res) => {
    try {
      return res.json({ settings: await settingsService.saveSettings(req.body || {}, { by: who(req) }) });
    } catch (err) {
      return failed(res, req, err, 'save');
    }
  });

  router.put('/meta-crm/enabled', authMiddleware, async (req, res) => {
    try {
      return res.json({ settings: await settingsService.setEnabled(req.body?.enabled, { by: who(req) }) });
    } catch (err) {
      return failed(res, req, err, 'switch');
    }
  });

  return router;
}

module.exports = { createMetaCrmSettingsRouter, TEST_MAX_PER_WINDOW, TEST_WINDOW_MS };
