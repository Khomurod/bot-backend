/**
 * Facebook integration surface:
 *   - internal server-to-server endpoints called by the Python leads engine
 *     (webhook ingest, lead retry, /connect command setup, SMS mirror);
 *   - the public /facebook/connect + OAuth flow pages (HTML);
 *   - the admin-guarded /leads-log and /retry/:id inspection endpoints.
 *
 * Routes use their full paths; the router is mounted at the app root so
 * matching behavior is identical to the previous inline definitions.
 */
const express = require('express');
const {
  createConnectSession,
  getSessionByToken,
  buildLoginRedirectForSession,
  finishOAuthCallback,
  connectSelectedPages,
  normalizeSelectedPageIds,
} = require('../../services/facebookConnectService');
const { getLeadsTelegram, sendLeadsMessage } = require('../../services/leadsTelegramClient');
const {
  handleTelegramSmsReply,
  registerSmsMirror,
} = require('../../services/facebookLeadSmsMirrorService');
const {
  enqueueVerifiedFacebookPayload,
  retryFacebookWebhookEvent,
  getFacebookWebhookLog,
} = require('../../services/facebookWebhookService');

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderFacebookCardPage(title, bodyHtml) {
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        --bg: #f3f0e8;
        --ink: #152033;
        --muted: #5d6675;
        --card: rgba(255, 255, 255, 0.84);
        --line: rgba(21, 32, 51, 0.12);
        --primary: #0f766e;
        --primary-ink: #ffffff;
        --accent: #d97706;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Georgia, "Times New Roman", serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(217, 119, 6, 0.18), transparent 35%),
          radial-gradient(circle at bottom right, rgba(15, 118, 110, 0.18), transparent 30%),
          linear-gradient(160deg, #fbf8f0 0%, var(--bg) 100%);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      .card {
        width: min(760px, 100%);
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 24px;
        padding: 28px;
        box-shadow: 0 24px 60px rgba(21, 32, 51, 0.14);
        backdrop-filter: blur(8px);
      }
      h1 {
        margin: 0 0 10px;
        font-size: clamp(30px, 4vw, 42px);
        line-height: 1.05;
      }
      p, li, label {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--muted);
        line-height: 1.55;
        font-size: 16px;
      }
      .group {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 18px;
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(15, 118, 110, 0.1);
        color: var(--primary);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-weight: 600;
      }
      .button, button {
        appearance: none;
        border: none;
        border-radius: 999px;
        padding: 14px 22px;
        background: var(--primary);
        color: var(--primary-ink);
        text-decoration: none;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 15px;
        font-weight: 700;
        cursor: pointer;
      }
      .button.secondary {
        background: transparent;
        color: var(--primary);
        border: 1px solid rgba(15, 118, 110, 0.26);
      }
      .stack {
        display: grid;
        gap: 16px;
      }
      .pages {
        display: grid;
        gap: 12px;
        margin: 20px 0;
      }
      .page {
        display: grid;
        gap: 6px;
        padding: 16px 18px;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.8);
      }
      .page strong {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--ink);
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-top: 20px;
      }
      .note {
        margin-top: 14px;
        padding: 14px 16px;
        border-left: 4px solid var(--accent);
        background: rgba(217, 119, 6, 0.08);
      }
      input[type="checkbox"] {
        inline-size: 18px;
        block-size: 18px;
        accent-color: var(--primary);
      }
      .checkbox-row {
        display: flex;
        gap: 12px;
        align-items: flex-start;
      }
      .pill {
        display: inline-block;
        margin-right: 8px;
        padding: 4px 10px;
        border-radius: 999px;
        background: rgba(21, 32, 51, 0.06);
        font-size: 12px;
        color: var(--ink);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      @media (max-width: 640px) {
        .card { padding: 22px; }
        .actions { flex-direction: column; }
        .button, button { width: 100%; text-align: center; }
      }
    </style>
  </head>
  <body>
    <div class="card">
      ${bodyHtml}
    </div>
  </body>
  </html>`;
}

function renderConnectLandingPage(session) {
  return renderFacebookCardPage(
    'Connect Facebook',
    `
      <div class="group">Telegram Group: ${escapeHtml(session.group_name || String(session.telegram_group_id))}</div>
      <h1>Connect Facebook Pages</h1>
      <p>Sign in with the Facebook account that manages the Pages you want to connect. After login, you can choose one or many Pages and route their leads into this Telegram group automatically.</p>
      <div class="note">
        <p style="margin:0;">This link is short-lived and tied to one Telegram group. If it expires, send <strong>/connect</strong> to <strong>WenzeLeadBots</strong> in the group again.</p>
      </div>
      <div class="actions">
        <a class="button" href="/facebook/oauth/start?session=${encodeURIComponent(session.session_token)}">Continue With Facebook</a>
      </div>
    `
  );
}

function renderPagePicker(session, profile, pages) {
  const pageCards = pages.map((page) => `
    <label class="page">
      <span class="checkbox-row">
        <input type="checkbox" name="page_id" value="${escapeHtml(page.id)}" checked>
        <span>
          <strong>${escapeHtml(page.name)}</strong><br>
          ${(page.tasks || []).map((task) => `<span class="pill">${escapeHtml(task)}</span>`).join('')}
        </span>
      </span>
    </label>
  `).join('');

  return renderFacebookCardPage(
    'Choose Pages',
    `
      <div class="group">Telegram Group: ${escapeHtml(session.group_name || String(session.telegram_group_id))}</div>
      <h1>Choose the Pages to connect</h1>
      <p>Signed in as <strong>${escapeHtml(profile?.name || session.oauth_user_name || 'Facebook user')}</strong>. Every Page you keep checked below will send new leads into this Telegram group.</p>
      <form method="POST" action="/facebook/connect/${encodeURIComponent(session.session_token)}/select-pages" class="stack">
        <div class="pages">
          ${pageCards}
        </div>
        <div class="actions">
          <button type="submit">Connect Selected Pages</button>
          <a class="button secondary" href="/facebook/connect/${encodeURIComponent(session.session_token)}">Start Over</a>
        </div>
      </form>
    `
  );
}

function renderConnectResultPage({ title, message, detailLines = [] }) {
  return renderFacebookCardPage(
    title,
    `
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      ${detailLines.length ? `<div class="note"><p style="margin:0; white-space:pre-line;">${escapeHtml(detailLines.join('\n'))}</p></div>` : ''}
    `
  );
}

function createFacebookConnectRoutes({ db, internalSharedSecretGuard, proxyAuthGuard }) {
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

  router.get('/facebook/connect/:sessionToken', async (req, res) => {
    try {
      const session = await getSessionByToken(req.params.sessionToken);
      res.send(renderConnectLandingPage(session));
    } catch (err) {
      res.status(400).send(
        renderConnectResultPage({
          title: 'Connect Link Unavailable',
          message: err.message,
        })
      );
    }
  });

  router.get('/facebook/oauth/start', async (req, res) => {
    try {
      const redirectUrl = await buildLoginRedirectForSession(req.query.session);
      res.redirect(302, redirectUrl);
    } catch (err) {
      res.status(400).send(
        renderConnectResultPage({
          title: 'Facebook Login Could Not Start',
          message: err.message,
        })
      );
    }
  });

  router.get('/facebook/oauth/callback', async (req, res) => {
    try {
      if (req.query.error) {
        throw new Error(req.query.error_description || req.query.error || 'Facebook login was cancelled');
      }
      const { session, profile, pages } = await finishOAuthCallback({
        state: req.query.state,
        code: req.query.code,
      });

      res.send(renderPagePicker(session, profile, pages));
    } catch (err) {
      console.error('[API] Facebook OAuth callback failed:', err.message);
      res.status(400).send(
        renderConnectResultPage({
          title: 'Facebook Login Failed',
          message: err.message,
        })
      );
    }
  });

  router.post('/facebook/connect/:sessionToken/select-pages', async (req, res) => {
    try {
      const selectedPageIds = normalizeSelectedPageIds(req.body.page_id);
      const { session, results } = await connectSelectedPages({
        sessionToken: req.params.sessionToken,
        selectedPageIds,
      });

      const successful = results.filter((result) => result.subscriptionStatus !== 'subscription_failed');
      const detailLines = results.map((result) => {
        const prefix = result.subscriptionStatus === 'subscription_failed' ? 'Failed' : 'Connected';
        const pageName = result.connection?.page_name || 'Unknown Page';
        const detail = result.subscriptionError ? ` (${result.subscriptionError})` : '';
        return `${prefix}: ${pageName}${detail}`;
      });

      try {
        await sendLeadsMessage(
          session.telegram_group_id,
          [
            'Facebook Page connection updated.',
            '',
            ...detailLines,
          ].join('\n')
        );
      } catch (sendErr) {
        console.error('[API] Could not post Facebook connect confirmation to Telegram:', sendErr.message);
        detailLines.push(`Telegram confirmation warning: ${sendErr.message}`);
      }

      res.send(
        renderConnectResultPage({
          title: successful.length ? 'Facebook Connected' : 'Facebook Connection Saved With Warnings',
          message: successful.length
            ? 'Your selected Pages are now connected to this Telegram group.'
            : 'The flow completed, but no Pages reported a clean subscription result. Review the details below.',
          detailLines,
        })
      );
    } catch (err) {
      console.error('[API] Facebook page selection failed:', err.message);
      res.status(400).send(
        renderConnectResultPage({
          title: 'Could Not Save Page Selection',
          message: err.message,
        })
      );
    }
  });

  router.get('/leads-log', proxyAuthGuard, async (req, res) => {
    try {
      const entries = await getFacebookWebhookLog(50);
      res.json({ count: entries.length, entries });
    } catch (err) {
      console.error('[API] Error loading Facebook leads log:', err.message);
      res.status(500).json({ error: 'Failed to load Facebook leads log', detail: err.message });
    }
  });

  router.get('/retry/:id', proxyAuthGuard, async (req, res) => {
    try {
      const event = await retryFacebookWebhookEvent(req.params.id);
      if (!event) {
        return res.status(404).json({ error: 'No Facebook webhook event found for that identifier' });
      }
      return res.json({ success: true, event });
    } catch (err) {
      console.error('[API] Error retrying Facebook webhook event:', err.message);
      return res.status(500).json({ error: 'Failed to retry Facebook webhook event', detail: err.message });
    }
  });

  return router;
}

module.exports = { createFacebookConnectRoutes };
