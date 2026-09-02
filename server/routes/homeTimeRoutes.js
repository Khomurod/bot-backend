/**
 * Driver Home-Time Tracking — admin API router façade.
 *
 * Mounted at /api/home-time (JWT auth, like the other admin endpoints). The
 * tracker itself is event-driven from the bot; this router only exposes the
 * dashboard, the manual edits and the settings.
 *
 * RE-EXPORT / COMPOSITION ONLY. Each area owns a sub-router that registers the
 * SAME relative paths it always did, so every admin-panel URL is unchanged:
 *
 *   ./homeTime/rowShaping.js        PURE row shaping shared by two screens
 *   ./homeTime/trackerRoutes.js     /overview, /efficiency, /status, /history
 *   ./homeTime/importRoutes.js      /import-screenshots(+/apply)
 *   ./homeTime/settingsRoutes.js    /settings
 *   ./homeTime/groupAccessRoutes.js /group-access*, /access-settings
 *
 * Registration ORDER is the one the file always had, and it is load-bearing:
 * the decision routes and the request routes are added to THIS router before
 * the sub-routers, so `PUT /requests/:id` reaches the request handler and can
 * never be claimed by the settings validator. A previous refactor collapsed
 * those two endpoints — settings saves 404'd while request edits silently
 * rewrote global settings — which is why
 * tests/homeTimeRoutesSeparation*.test.js guard exactly this wiring.
 */
const express = require('express');

const { registerHomeTimeDecisionRoutes } = require('./homeTimeDecisionRoutes');
const { registerHomeTimeRequestRoutes } = require('./homeTimeRequestRoutes');
const { resolveDriverType, buildDirectoryIndex } = require('./homeTime/rowShaping');
const { createHomeTimeTrackerRoutes } = require('./homeTime/trackerRoutes');
const { createHomeTimeImportRoutes } = require('./homeTime/importRoutes');
const { createHomeTimeSettingsRoutes } = require('./homeTime/settingsRoutes');
const { createHomeTimeGroupAccessRoutes } = require('./homeTime/groupAccessRoutes');

function createHomeTimeRouter({ authMiddleware }) {
  const router = express.Router();

  // Approve / decline a pending request from the admin panel.
  registerHomeTimeDecisionRoutes(router, { authMiddleware });

  // Request endpoints (list / create / correct). They live in their own module
  // so the request handlers and the SETTINGS handler can never be confused for
  // one another again. They only ever write home_time_requests.
  registerHomeTimeRequestRoutes(router, {
    authMiddleware, buildDirectoryIndex, resolveDriverType,
  });

  router.use(createHomeTimeTrackerRoutes({ authMiddleware }));
  router.use(createHomeTimeImportRoutes({ authMiddleware }));
  router.use(createHomeTimeSettingsRoutes({ authMiddleware }));
  router.use(createHomeTimeGroupAccessRoutes({ authMiddleware }));

  return router;
}

module.exports = { createHomeTimeRouter };
