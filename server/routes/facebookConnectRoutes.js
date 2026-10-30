/**
 * Facebook integration surface — router façade.
 *
 * COMPOSITION ONLY. Mounted at the app root, and each sub-router keeps the FULL
 * paths the routes always had, so matching behavior is identical to the
 * previous single file:
 *
 *   ./facebookConnect/connectPages.js      PURE HTML for the connect flow
 *   ./facebookConnect/internalRoutes.js    /api/internal/facebook/* (shared secret)
 *   ./facebookConnect/oauthRoutes.js       /facebook/connect + /facebook/oauth/* (public)
 *
 * The two groups have two DIFFERENT authorization models — internal shared
 * secret and session-token-in-URL — which is the reason they are separate
 * modules rather than one router: each file carries exactly one guard, so a
 * route cannot quietly end up behind the wrong one. (The admin-guarded
 * `/leads-log` and `/retry/:id` went on 2026-10-30: they duplicated
 * `/api/facebook-leads/webhook-log`, which Customer Inquiries → Activity Log
 * uses, and the retry changed state on a GET.)
 */
const express = require('express');

const { createFacebookInternalRoutes } = require('./facebookConnect/internalRoutes');
const { createFacebookOauthRoutes } = require('./facebookConnect/oauthRoutes');

function createFacebookConnectRoutes({ db, internalSharedSecretGuard }) {
  const router = express.Router();

  router.use(createFacebookInternalRoutes({ db, internalSharedSecretGuard }));
  router.use(createFacebookOauthRoutes());

  return router;
}

module.exports = { createFacebookConnectRoutes };
