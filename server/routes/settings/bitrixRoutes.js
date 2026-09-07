'use strict';

/**
 * Bitrix24 status and diagnosis — admin API.
 *
 * There was no admin visibility into Bitrix at all: it was configured entirely
 * by environment variables and reported only through server logs. That was
 * survivable while Bitrix was a second destination for a lead. It is not now
 * that the lead's Bitrix ASSIGNEE decides which recruiter's number texts the
 * driver — a portal that never assigns, or an assignee nobody mapped, quietly
 * sends every lead out from the shared number.
 *
 * So this mirrors the per-number RingCentral Diagnose the operator already
 * knows: one button, one ordered list of checks, each with what to do about it.
 *
 * THE WEBHOOK URL IS A SECRET (the Bitrix inbound webhook's path IS its
 * credential), so nothing here returns it — only its host.
 *
 * Read-only: it creates nothing in Bitrix and changes nothing here.
 */
const express = require('express');
const config = require('../../../config/config');
const { diagnoseBitrix, webhookHost } = require('../../../services/bitrix24DiagnosticsService');
const { isBitrixConfigured, getBitrixMapperConfig } = require('../../../services/bitrix24Service');

function createBitrixSettingsRouter({ authMiddleware }) {
  const router = express.Router();

  /** The shape of the configuration, with no secret in it. */
  router.get('/bitrix', authMiddleware, (req, res) => {
    try {
      const mapper = getBitrixMapperConfig();
      const assignedByRaw = String(mapper.assignedById || '').trim();
      const assignedById = Number(assignedByRaw);
      res.json({
        settings: {
          enabled: Boolean(config.bitrix24Enabled),
          configured: isBitrixConfigured(),
          webhookHost: webhookHost(),
          entity: mapper.entity,
          sourceId: mapper.sourceId,
          // Reported as resolved, so a name typed here reads as "ignored"
          // instead of looking like it works.
          assignedById: Number.isFinite(assignedById) && assignedById > 0 ? assignedById : null,
          assignedByIdRaw: assignedByRaw,
          assignedByIdIgnored: Boolean(assignedByRaw) && !(Number.isFinite(assignedById) && assignedById > 0),
          assigneeWaitMs: config.bitrix24AssigneeWaitMs,
          dealCategoryId: mapper.dealCategoryId || null,
          dealStageId: mapper.dealStageId || null,
        },
      });
    } catch (err) {
      console.error('[SETTINGS API] bitrix load failed:', err.message);
      res.status(500).json({ error: 'Failed to load Bitrix24 settings' });
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

module.exports = { createBitrixSettingsRouter };
