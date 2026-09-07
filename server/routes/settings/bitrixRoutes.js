'use strict';

/**
 * Bitrix24 settings, status and diagnosis — admin API.
 *
 *   GET  /bitrix           → the configuration, with no secret in it
 *   PUT  /bitrix           → save it (Settings → RingCentral → Bitrix24)
 *   POST /bitrix/diagnose  → the stepwise chain check
 *
 * Bitrix used to be configured only by environment variables on the host, so a
 * wrong assignee id or a rotated webhook meant a deploy by whoever holds the
 * Render dashboard — while RingCentral, ELD and GMaps are entered here. Now it
 * has the same home: database/bitrix.js keeps one encrypted row, and the DB
 * row wins over env for anything that has been saved.
 *
 * THE WEBHOOK URL IS A SECRET (the Bitrix inbound webhook's path IS its
 * credential), so nothing here returns it — only its host. Not even a masked
 * tail: the tail is part of the token.
 */
const express = require('express');
const { getBitrixSettingsForAdmin, updateBitrixSettings } = require('../../../database/bitrix');
const { diagnoseBitrix } = require('../../../services/bitrix24DiagnosticsService');
const { isBitrixConfigured } = require('../../../services/bitrix24Service');

/**
 * The admin view plus what the panel needs to judge it. The assignee is
 * reported as RESOLVED, so a name typed there reads as "ignored" instead of
 * looking like it works — that is the production mistake this surface exists
 * to make visible.
 */
function describe(settings, configured) {
  const raw = String(settings.assignedById || '').trim();
  const numeric = Number(raw);
  const usable = Number.isFinite(numeric) && numeric > 0;
  return {
    ...settings,
    configured,
    assignedById: usable ? numeric : null,
    assignedByIdRaw: raw,
    assignedByIdIgnored: Boolean(raw) && !usable,
    dealCategoryId: settings.dealCategoryId || null,
    dealStageId: settings.dealStageId || null,
  };
}

async function currentSettings() {
  const [settings, configured] = await Promise.all([getBitrixSettingsForAdmin(), isBitrixConfigured()]);
  return describe(settings, configured);
}

function createBitrixSettingsRouter({ authMiddleware }) {
  const router = express.Router();

  router.get('/bitrix', authMiddleware, async (req, res) => {
    try {
      res.json({ settings: await currentSettings() });
    } catch (err) {
      console.error('[SETTINGS API] bitrix load failed:', err.message);
      res.status(500).json({ error: 'Failed to load Bitrix24 settings' });
    }
  });

  /**
   * Save. Validation failures (a name where a user id belongs, an entity that
   * is neither lead nor deal, a webhook that is not a Bitrix REST URL) come back
   * as 400 with the reason; the row is untouched when any field is rejected.
   */
  router.put('/bitrix', authMiddleware, async (req, res) => {
    try {
      await updateBitrixSettings(req.body || {});
      res.json({ settings: await currentSettings() });
    } catch (err) {
      if (err.statusCode === 400) return res.status(400).json({ error: err.message });
      console.error('[SETTINGS API] bitrix save failed:', err.message);
      return res.status(500).json({ error: 'Failed to save Bitrix24 settings' });
    }
  });

  /**
   * Stepwise diagnosis: configuration → reachable and scoped → field map →
   * recruiter coverage → the assignee readback the SMS sender depends on →
   * what has actually happened to recent leads.
   */
  router.post('/bitrix/diagnose', authMiddleware, async (req, res) => {
    try {
      // A nonsense window falls back to the default rather than silently
      // becoming a 1-day one: -5 days is a typo, not a request for yesterday.
      const requested = Number.parseInt(req.body?.days, 10);
      const days = Number.isInteger(requested) && requested > 0 ? Math.min(90, requested) : 14;
      return res.json(await diagnoseBitrix({ days }));
    } catch (err) {
      console.error('[SETTINGS API] bitrix diagnose failed:', err.message);
      // A diagnostic that cannot run is itself the finding, so it answers 200
      // with a failed step rather than an error the panel renders as a crash.
      return res.json({
        ok: false,
        steps: [{ label: 'Diagnostic', ok: false, detail: err.message }],
      });
    }
  });

  return router;
}

module.exports = { createBitrixSettingsRouter, describe };
