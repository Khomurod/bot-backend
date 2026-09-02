/**
 * Trailer Department — department settings and the Telegram group test.
 *
 * THE REMINDER GATE: reminders_enabled cannot be turned on until BOTH
 * notification groups have been test-messaged successfully. Enabling them
 * blind is how a company ends up with overdue notices going to an empty chat
 * or, worse, the wrong one — so the check is server-side, not a panel hint.
 *
 * Split out of server/routes/trailerDepartmentRoutes.js.
 */
'use strict';

const express = require('express');
const storage = require('../../../services/trailerStorageService');
const { asyncRoute } = require('./shared');

function createTrailerDepartmentSettingsRoutes({ db, requirePermission, telegram }) {
  const router = express.Router();

  // storage_configured stays TRUE now: uploads always work, because with no
  // Supabase bucket the files go into the database. storage_backend tells the
  // settings screen which one is actually in use.
  router.get(
    '/api/trailer-department/settings',
    requirePermission('trailer_settings.manage'),
    asyncRoute(async (_req, res) => res.json({
      settings: await db.getTrailerSettings(),
      storage_configured: storage.isConfigured(),
      storage_backend: storage.activeBackend(),
      supabase_configured: storage.isSupabaseConfigured(),
    })),
  );

  router.put(
    '/api/trailer-department/settings',
    requirePermission('trailer_settings.manage'),
    asyncRoute(async (req, res) => {
      if (req.body?.reminders_enabled) {
        const current = await db.getTrailerSettings();
        if (!current.payment_group_tested_at || !current.overdue_group_tested_at) {
          return res.status(409).json({
            error: 'Test both Telegram groups successfully before enabling reminders.',
          });
        }
      }
      res.json({ settings: await db.updateTrailerSettings(req.body || {}) });
    }),
  );

  router.post(
    '/api/trailer-department/settings/test/:target',
    requirePermission('trailer_settings.manage'),
    asyncRoute(async (req, res) => {
      const settings = await db.getTrailerSettings();
      const payment = req.params.target === 'payment';
      const chatId = payment
        ? settings.payment_confirmation_group_id
        : settings.overdue_reminder_group_id;
      if (!chatId) return res.status(400).json({ error: 'Configure the Telegram group first.' });

      const sent = await telegram.sendMessage(
        chatId,
        `Trailer Department ${payment ? 'payment confirmation' : 'overdue reminder'} test — configuration is working.`,
      );
      // Stamped only AFTER the send succeeded — this timestamp is what unlocks
      // the reminder gate above.
      await db.markTrailerSettingsGroupTested(req.params.target);
      res.json({ sent: true, message_id: sent.message_id });
    }),
  );

  return router;
}

module.exports = { createTrailerDepartmentSettingsRoutes };
