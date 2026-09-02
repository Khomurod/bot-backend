/**
 * The public /facebook/connect + OAuth pages a recruiter walks through to
 * attach their Facebook Pages: landing page, redirect to Meta, callback, and
 * the page picker that finishes the connection.
 *
 * These are the only UNGUARDED routes in this area, which is why the session
 * token in the URL is the credential: facebookConnectService issues it,
 * expires it and validates it on every step. This module renders and delegates
 * — it makes no authorization decision of its own.
 *
 * Split out of server/routes/facebookConnectRoutes.js.
 */
const express = require('express');
const {
  getSessionByToken,
  buildLoginRedirectForSession,
  finishOAuthCallback,
  connectSelectedPages,
  normalizeSelectedPageIds,
} = require('../../../services/facebookConnectService');
const { sendLeadsMessage } = require('../../../services/leadsTelegramClient');
const {
  renderConnectLandingPage,
  renderPagePicker,
  renderConnectResultPage,
} = require('./connectPages');

function createFacebookOauthRoutes() {
  const router = express.Router();

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

  return router;
}

module.exports = { createFacebookOauthRoutes };
