/**
 * Internal server-to-server endpoints called by the Python leads engine
 * (leads-bot/): webhook ingest, lead retry, /connect command setup, SMS mirror
 * registration and the Telegram SMS reply relay.
 *
 * Every route is behind internalSharedSecretGuard — these are NOT public. They
 * keep their full paths (/api/internal/facebook/*) because the Python side
 * calls them by absolute URL.
 *
 * Split out of server/routes/facebookConnectRoutes.js.
 */
const express = require('express');
const { createConnectSession } = require('../../../services/facebookConnectService');
const { getLeadsTelegram, sendLeadsMessage } = require('../../../services/leadsTelegramClient');
const {
  handleTelegramSmsReply,
  registerSmsMirror,
} = require('../../../services/facebookLeadSmsMirrorService');
const {
  enqueueVerifiedFacebookPayload,
  retryFacebookWebhookEvent,
} = require('../../../services/facebookWebhookService');

function createFacebookInternalRoutes({ db, internalSharedSecretGuard }) {
  const router = express.Router();

  router.post('/api/internal/facebook/webhook-events', internalSharedSecretGuard, async (req, res) => {
    try {
      const result = await enqueueVerifiedFacebookPayload(req.body || {});
      res.json({ status: 'accepted', ...result });
    } catch (err) {
      console.error('[API] Facebook internal webhook ingest failed:', err.message);
      res.status(500).json({ error: 'Failed to ingest Facebook webhook payload', detail: err.message });
    }
  });

  router.post('/api/internal/facebook/retry-leadgen', internalSharedSecretGuard, async (req, res) => {
    try {
      const leadgenId = String(req.body?.leadgenId || req.body?.leadgen_id || '').trim();
      if (!leadgenId) {
        return res.status(400).json({ error: 'leadgenId is required' });
      }
      const event = await retryFacebookWebhookEvent(leadgenId);
      if (!event) {
        return res.status(404).json({ error: 'No webhook event found for that leadgen id' });
      }
      return res.json({ status: 'queued', event });
    } catch (err) {
      console.error('[API] Facebook internal retry-leadgen failed:', err.message);
      return res.status(500).json({ error: 'Failed to queue lead retry', detail: err.message });
    }
  });

  router.post('/api/internal/facebook/connect-command', internalSharedSecretGuard, async (req, res) => {
    try {
      const telegramGroupId = Number(req.body?.telegramGroupId);
      const groupName = typeof req.body?.groupName === 'string' ? req.body.groupName : 'Unknown';
      if (!Number.isFinite(telegramGroupId)) {
        return res.status(400).json({ error: 'telegramGroupId is required' });
      }

      const { connectUrl, session } = await createConnectSession({
        telegramGroupId,
        groupName,
        requestedBy: {
          id: req.body?.requestedBy?.id || null,
          name: req.body?.requestedBy?.name || 'Unknown',
        },
      });

      const existingConnections = await db.getFacebookPageConnectionsByTelegramGroupId(telegramGroupId);
      return res.json({
        status: 'ok',
        connectUrl,
        sessionToken: session.session_token,
        existingPages: existingConnections.map((page) => ({
          pageId: page.page_id,
          pageName: page.page_name,
          isActive: page.is_active,
        })),
      });
    } catch (err) {
      console.error('[API] Facebook connect command setup failed:', err.message);
      return res.status(500).json({ error: 'Could not create Facebook connect session', detail: err.message });
    }
  });

  router.post('/api/internal/facebook/register-sms-mirror', internalSharedSecretGuard, async (req, res) => {
    try {
      const telegramChatId = req.body?.telegramChatId;
      const telegramMessageId = Number(req.body?.telegramMessageId);
      const driverPhone = req.body?.driverPhone;
      const smsBody = req.body?.smsBody;
      const sourceType = req.body?.sourceType || 'outbound_auto';

      if (telegramChatId == null || telegramChatId === '') {
        return res.status(400).json({ error: 'telegramChatId is required' });
      }
      if (!Number.isFinite(telegramMessageId)) {
        return res.status(400).json({ error: 'telegramMessageId is required' });
      }

      const result = await registerSmsMirror({
        telegramChatId,
        telegramMessageId,
        driverPhone,
        smsBody,
        sourceType,
      });
      return res.json({ status: 'ok', ...result });
    } catch (err) {
      const status = err.statusCode || 500;
      if (status >= 500) {
        console.error('[API] Facebook register-sms-mirror failed:', err.message);
      }
      return res.status(status).json({
        error: err.message || 'Failed to register SMS mirror',
      });
    }
  });

  router.post('/api/internal/facebook/telegram-sms-reply', internalSharedSecretGuard, async (req, res) => {
    try {
      const telegramChatId = req.body?.telegramChatId;
      const replyToMessageId = Number(req.body?.replyToMessageId);
      const replyText = req.body?.replyText;
      const userReplyMessageId = req.body?.userReplyMessageId != null
        ? Number(req.body.userReplyMessageId)
        : null;

      if (telegramChatId == null || telegramChatId === '') {
        return res.status(400).json({ error: 'telegramChatId is required' });
      }
      if (!Number.isFinite(replyToMessageId)) {
        return res.status(400).json({ error: 'replyToMessageId is required' });
      }

      const telegram = getLeadsTelegram();
      const result = await handleTelegramSmsReply(telegram, {
        telegramChatId,
        replyToMessageId,
        replyText,
        userReplyMessageId: Number.isFinite(userReplyMessageId) ? userReplyMessageId : null,
      });
      return res.json({ status: 'ok', ...result });
    } catch (err) {
      const status = err.statusCode || 500;
      if (status >= 500) {
        console.error('[API] Facebook telegram-sms-reply failed:', err.message);
      }
      return res.status(status).json({
        error: err.message || 'Failed to send SMS reply',
        detail: err.smsResult?.detail || null,
      });
    }
  });

  return router;
}

module.exports = { createFacebookInternalRoutes };
