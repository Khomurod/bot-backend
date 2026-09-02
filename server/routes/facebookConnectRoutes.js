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
 *   ./facebookConnect/inspectionRoutes.js  /leads-log, /retry/:id (admin guard)
 *
 * The three groups have three DIFFERENT authorization models — internal shared
 * secret, session-token-in-URL, and the admin proxy guard — which is the reason
 * they are separate modules rather than one router: each file carries exactly
 * one guard, so a route cannot quietly end up behind the wrong one.
 */
const express = require('express');

const { createFacebookInternalRoutes } = require('./facebookConnect/internalRoutes');
const { createFacebookOauthRoutes } = require('./facebookConnect/oauthRoutes');
const { createFacebookInspectionRoutes } = require('./facebookConnect/inspectionRoutes');

function createFacebookConnectRoutes({ db, internalSharedSecretGuard, proxyAuthGuard }) {
  const router = express.Router();

  router.use(createFacebookInternalRoutes({ db, internalSharedSecretGuard }));
  router.use(createFacebookOauthRoutes());
  router.use(createFacebookInspectionRoutes({ proxyAuthGuard }));

  return router;
}

module.exports = { createFacebookConnectRoutes };
