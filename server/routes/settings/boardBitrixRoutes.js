'use strict';

/**
 * Settings → Dispatcher Board → Board ↔ Bitrix check.
 *
 *   GET  /board-bitrix          → the switch, counts by kind, whether a question
 *                                 is out, the last pass — counts only, no names
 *   PUT  /board-bitrix/enabled  → the ON/OFF switch; ON runs a pass at once
 *   PUT  /board-bitrix/sync     → off / dry-run / explicitly confirmed live
 *   POST /board-bitrix/schema/approve → approve a twice-seen structural candidate
 *   POST /board-bitrix/run      → one pass now (rate-limited: it reads Bitrix)
 *
 * The logic is services/boardBitrix/admin.js. Live writes can change STAGE_ID
 * only and remain off until explicitly confirmed.
 */
const express = require('express');
const service = require('../../../services/boardBitrix/admin');
const { createRateLimiter } = require('../../middleware/rateLimit');

const RUN_WINDOW_MS = 10 * 60 * 1000;
const RUN_MAX_PER_WINDOW = 6;

const who = (req) => (req.admin && req.admin.username) || null;

function failed(res, err, what) {
  if (err.statusCode === 400) return res.status(400).json({ error: err.message });
  console.error(`[SETTINGS API] board-bitrix ${what} failed:`, String(err.message).slice(0, 200));
  return res.status(500).json({ error: `Failed to ${what} the Board ↔ Bitrix check` });
}

function createBoardBitrixSettingsRouter({ authMiddleware, adminService = service, runLimiter = null }) {
  const router = express.Router();
  const limitRuns = runLimiter || createRateLimiter({
    windowMs: RUN_WINDOW_MS,
    max: RUN_MAX_PER_WINDOW,
    message: 'Too many checks in a few minutes — each one reads Bitrix. Wait a little and try again.',
  });

  router.get('/board-bitrix', authMiddleware, async (req, res) => {
    try {
      return res.json({ settings: await adminService.getView() });
    } catch (err) {
      return failed(res, err, 'load');
    }
  });

  router.put('/board-bitrix/enabled', authMiddleware, async (req, res) => {
    try {
      return res.json({ settings: await adminService.setEnabled(req.body?.enabled, { by: who(req) }) });
    } catch (err) {
      return failed(res, err, 'switch');
    }
  });

  router.put('/board-bitrix/sync', authMiddleware, async (req, res) => {
    try {
      return res.json({
        settings: await adminService.setSyncSettings(req.body || {}, { by: who(req) }),
      });
    } catch (err) {
      return failed(res, err, 'configure status sync');
    }
  });

  router.post('/board-bitrix/schema/approve', authMiddleware, async (req, res) => {
    try {
      return res.json({
        settings: await adminService.approveSchema(req.body || {}, { by: who(req) }),
      });
    } catch (err) {
      return failed(res, err, 'approve schema');
    }
  });

  router.post('/board-bitrix/run', authMiddleware, limitRuns, async (req, res) => {
    try {
      return res.json(await adminService.runNow());
    } catch (err) {
      return failed(res, err, 'run');
    }
  });

  return router;
}

module.exports = { createBoardBitrixSettingsRouter };
