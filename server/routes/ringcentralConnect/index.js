'use strict';

/**
 * The public /ringcentral/connect + OAuth pages a recruiter walks through to
 * attach their own RingCentral number: landing page, redirect to RingCentral,
 * and the callback that stores the result.
 *
 * UNGUARDED ON PURPOSE, and safe to be. A recruiter has no admin session, so
 * the single-use session token in the URL is the credential:
 * services/ringCentralConnectService issues it, expires it, binds the callback
 * to it with `oauth_state`, and consumes it on success. This module renders and
 * delegates — it makes no authorization decision of its own, and it never puts
 * a token, a code or a secret into the page it returns.
 */
const express = require('express');
const {
  getConnectSession,
  buildConnectRedirect,
  finishConnectCallback,
} = require('../../../services/ringCentralConnectService');
const {
  renderConnectLandingPage,
  renderConnectResultPage,
} = require('./pages');

function createRingCentralConnectRoutes() {
  const router = express.Router();

  router.get('/ringcentral/connect/:sessionToken', async (req, res) => {
    try {
      const { session, recruiter } = await getConnectSession(req.params.sessionToken);
      res.send(renderConnectLandingPage({
        session,
        recruiter,
        startUrl: `/ringcentral/oauth/start?session=${encodeURIComponent(session.session_token)}`,
      }));
    } catch (err) {
      res.status(400).send(renderConnectResultPage({
        title: 'RingCentral Link Unavailable',
        message: err.message,
      }));
    }
  });

  router.get('/ringcentral/oauth/start', async (req, res) => {
    try {
      res.redirect(302, await buildConnectRedirect(req.query.session));
    } catch (err) {
      console.error('[API] RingCentral OAuth start failed:', err.message);
      res.status(400).send(renderConnectResultPage({
        title: 'RingCentral Sign-in Could Not Start',
        message: err.message,
      }));
    }
  });

  router.get('/ringcentral/oauth/callback', async (req, res) => {
    try {
      if (req.query.error) {
        throw new Error(req.query.error_description || req.query.error || 'RingCentral sign-in was cancelled.');
      }
      const { recruiter, extension, created, warning } = await finishConnectCallback({
        state: req.query.state,
        code: req.query.code,
      });

      res.send(renderConnectResultPage({
        title: warning ? 'RingCentral Connected With A Warning' : 'RingCentral Connected',
        message: created
          ? 'Your number is now on the platform. Leads assigned to you in Bitrix24 will be texted from it.'
          : 'Your RingCentral account is connected. Leads assigned to you in Bitrix24 will be texted from your number.',
        facts: [
          { label: 'Recruiter', value: recruiter?.name },
          { label: 'Sending number', value: recruiter?.phone_number },
          { label: 'RingCentral user', value: extension?.name },
          { label: 'Extension', value: extension?.extensionNumber },
        ],
        warning,
      }));
    } catch (err) {
      console.error('[API] RingCentral OAuth callback failed:', err.message);
      res.status(400).send(renderConnectResultPage({
        title: 'RingCentral Sign-in Failed',
        message: err.message,
      }));
    }
  });

  return router;
}

module.exports = { createRingCentralConnectRoutes };
