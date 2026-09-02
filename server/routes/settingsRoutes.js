/**
 * Admin Settings API — router façade.
 *
 * Mounted once at `/api/settings` by server/api.js. Each domain owns its own
 * sub-router and registers the SAME relative paths it always did, so every
 * existing admin-panel URL is unchanged:
 *
 *   ./settings/eldRoutes.js           /eld*            Samsara + Drive HoS keys
 *   ./settings/ringcentralRoutes.js   /ringcentral*    credentials + KPI targets
 *   ./settings/messageGroupRoutes.js  /message-groups  per-category routing
 *   ./settings/gmapsRoutes.js         /gmaps*          Route Control's Maps key
 *   ./settings/safetyEventRoutes.js   /safety-events*  dashcam music overlay
 *   ./settings/bolPodRoutes.js        /bol-pod*        document forwarding
 *
 * Two conventions hold across all of them: `authMiddleware` guards every route
 * (these read and write credentials), and a stored secret is NEVER returned in
 * full — reads mask it and only a per-domain `test` endpoint exercises it.
 */
const express = require('express');

const { createEldSettingsRouter } = require('./settings/eldRoutes');
const { createRingCentralSettingsRouter } = require('./settings/ringcentralRoutes');
const { createMessageGroupSettingsRouter } = require('./settings/messageGroupRoutes');
const { createGmapsSettingsRouter } = require('./settings/gmapsRoutes');
const { createSafetyEventSettingsRouter } = require('./settings/safetyEventRoutes');
const { createBolPodSettingsRouter } = require('./settings/bolPodRoutes');

function createSettingsRouter({ authMiddleware, telegram = null }) {
  const router = express.Router();
  const deps = { authMiddleware, telegram };

  router.use(createEldSettingsRouter(deps));
  router.use(createRingCentralSettingsRouter(deps));
  router.use(createMessageGroupSettingsRouter(deps));
  router.use(createGmapsSettingsRouter(deps));
  router.use(createSafetyEventSettingsRouter(deps));
  router.use(createBolPodSettingsRouter(deps));

  return router;
}

module.exports = { createSettingsRouter };
