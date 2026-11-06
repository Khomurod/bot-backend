'use strict';

/**
 * Truck Photos — admin API (Settings → Truck Photos), under `admin.full_access`
 * like every settings route (server/api.js mounts /api/settings behind it).
 *
 * Where an administrator names the ONE person the hand-over PDFs go to, proves
 * the bot can reach them, sets how far back a plain `outbound` looks, and
 * switches the feature on.
 *
 * A BOT CANNOT START A CONVERSATION. Telegram refuses to message a person who
 * has never opened the bot and pressed Start (403 "bot can't initiate
 * conversation with a user"), and the PDFs would go nowhere. So "Send test
 * message" is the proof: it says in words what Telegram answered, and only a
 * message that actually arrived lets the switch go on (the store refuses
 * otherwise, and so does the table's CHECK).
 *
 * Errors carry an `error` key; the test's verdict — reached or not, and why —
 * comes back with 200. Nothing returned holds a PDF or a photo: none are kept.
 */

const express = require('express');
const settingsStore = require('../../../database/truckPhotos/settings');
const reports = require('../../../database/truckPhotos/reports');
const { cleanTelegramError } = require('../../../lib/telegram/telegramErrors');
const { sendFailure } = require('../../middleware/failureResponse');

const LOG = { logPrefix: '[SETTINGS API]' };
const TEST_TEXT = '✅ Wenze will send you the truck photo PDFs here: one when a truck is handed over '
  + '("outbound") and one when it comes back ("inbound").';

async function botName(telegram) {
  try {
    const me = await telegram.getMe();
    return me?.username ? `@${me.username}` : 'the bot';
  } catch (_) {
    return 'the bot';
  }
}

/** What Telegram's refusal means, in words an administrator can act on. */
async function explainRefusal(err, telegram) {
  const code = err?.response?.error_code;
  const desc = String(err?.response?.description || err?.description || '').toLowerCase();
  if (code === 403 && /initiate conversation|can't initiate/.test(desc)) {
    return {
      reason: 'not_started',
      message: `This person has not pressed Start on the bot yet. Ask them to open ${await botName(telegram)} `
        + 'in Telegram and press Start, then send the test message again.',
    };
  }
  if (code === 403 && /blocked/.test(desc)) {
    return {
      reason: 'blocked',
      message: 'This person has blocked the bot. They need to open it, unblock it (Restart), and then you can '
        + 'send the test message again.',
    };
  }
  if (code === 403 && /deactivated/.test(desc)) {
    return { reason: 'deactivated', message: 'This Telegram account has been deleted.' };
  }
  if (code === 403 && /bots can't send messages to bots/.test(desc)) {
    return { reason: 'bot', message: 'That id belongs to a bot, not a person.' };
  }
  if (code === 400 && /chat not found/.test(desc)) {
    return {
      reason: 'unknown_user',
      message: 'Telegram does not know this id. Check the number — it is the person\'s own Telegram id, '
        + 'not a group\'s — and that they have pressed Start on the bot.',
    };
  }
  return { reason: 'refused', message: `Telegram refused the message: ${cleanTelegramError(err)}` };
}

function shapeReport(r) {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    groupName: r.groupName,
    triggeredByName: r.triggeredByName,
    photoCount: r.photoCount,
    videoCount: r.videoCount,
    excludedCount: r.excludedCount,
    parts: r.parts,
    reason: r.reason,
    aiAssisted: r.aiAssisted,
    createdAt: r.createdAt,
    sentAt: r.sentAt,
  };
}

function createTruckPhotoSettingsRouter({ authMiddleware, telegram }) {
  const router = express.Router();

  router.get('/truck-photos', authMiddleware, async (req, res) => {
    try {
      const [settings, recent] = await Promise.all([
        settingsStore.getTruckPhotoSettings(),
        reports.listRecentReports(20),
      ]);
      res.json({ settings, recent: recent.map(shapeReport) });
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to read the Truck Photos settings', ...LOG });
    }
  });

  router.put('/truck-photos', authMiddleware, async (req, res) => {
    try {
      const body = req.body || {};
      const patch = {};
      if (body.enabled !== undefined) patch.enabled = body.enabled === true;
      if (body.recipientTelegramId !== undefined) patch.recipientTelegramId = body.recipientTelegramId;
      if (body.lookbackHours !== undefined) patch.lookbackHours = body.lookbackHours;
      const saved = await settingsStore.updateTruckPhotoSettings(patch, req.admin?.id ?? null);
      return res.json(saved);
    } catch (err) {
      if (err instanceof settingsStore.TruckPhotoSettingsError) {
        return res.status(400).json({ error: err.message });
      }
      return sendFailure(res, err, { message: 'Failed to save the Truck Photos settings', ...LOG });
    }
  });

  /** Message the saved recipient, to prove the bot can reach them. */
  router.post('/truck-photos/test-message', authMiddleware, async (req, res) => {
    let settings;
    try {
      settings = await settingsStore.getTruckPhotoSettings();
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to read the Truck Photos settings', ...LOG });
    }
    if (!settings.recipientTelegramId) return res.status(400).json({ error: 'Save the recipient first.' });
    if (!telegram) return res.status(503).json({ error: 'The bot is not running.' });
    try {
      await telegram.sendMessage(settings.recipientTelegramId, TEST_TEXT);
    } catch (err) {
      return res.json({ ok: false, ...(await explainRefusal(err, telegram)) });
    }
    try {
      const saved = await settingsStore.markRecipientVerified(settings.recipientTelegramId);
      if (!saved) {
        return res.json({
          ok: false, reason: 'changed', message: 'The recipient was changed meanwhile. Send the test message again.',
        });
      }
      return res.json({ ok: true, settings: saved });
    } catch (err) {
      return sendFailure(res, err, { message: 'The message arrived, but it could not be recorded', ...LOG });
    }
  });

  return router;
}

module.exports = { createTruckPhotoSettingsRouter, explainRefusal };
