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
 *   ./settings/samsaraRoutes.js       /samsara*        Samsara connection + video recovery
 *   ./settings/safetyEventRoutes.js   /safety-events*  dashcam music overlay
 *   ./settings/retiredLeftoversRoutes.js /retired-leftovers*  removed-feature cleanup
 *   ./settings/financeRoutes.js       /finance*        the Finance Monitor's group
 *   ./settings/safetyApprovalRoutes.js /safety-approvals* Safety's hire decisions
 *
 * Two conventions hold across all of them: `authMiddleware` guards every route
 * (these read and write credentials), and a stored secret is NEVER returned in
 * full — reads mask it and only a per-domain `test` endpoint exercises it.
 */
const express = require('express');

const { createEldSettingsRouter } = require('./settings/eldRoutes');
const { createRingCentralSettingsRouter } = require('./settings/ringcentralRoutes');
const { createMessageGroupSettingsRouter } = require('./settings/messageGroupRoutes');
const { createDispatchBoardSettingsRouter } = require('./settings/dispatchBoardRoutes');
const { createSamsaraSettingsRouter } = require('./settings/samsaraRoutes');
const { createSafetyEventSettingsRouter } = require('./settings/safetyEventRoutes');
const { createBitrixSettingsRouter } = require('./settings/bitrixRoutes');
const { createAiSettingsRouter } = require('./settings/aiRoutes');
const { createAiPolicyRouter } = require('./settings/aiPolicyRoutes');
const { createNotificationSettingsRouter } = require('./settings/notificationRoutes');
const { createControlSettingsRouter } = require('./settings/controlRoutes');
const { createRetiredLeftoversRouter } = require('./settings/retiredLeftoversRoutes');
const { createRecruitingHoursRouter } = require('./settings/recruitingHoursRoutes');
const { createFinanceSettingsRouter } = require('./settings/financeRoutes');
const { createSafetyApprovalSettingsRouter } = require('./settings/safetyApprovalRoutes');

function createSettingsRouter({ authMiddleware, telegram = null }) {
  const router = express.Router();
  const deps = { authMiddleware, telegram };

  router.use(createEldSettingsRouter(deps));
  router.use(createRingCentralSettingsRouter(deps));
  router.use(createMessageGroupSettingsRouter(deps));
  router.use(createDispatchBoardSettingsRouter(deps));
  router.use(createSamsaraSettingsRouter(deps));
  router.use(createSafetyEventSettingsRouter(deps));
  router.use(createBitrixSettingsRouter(deps));
  router.use(createAiSettingsRouter(deps));
  router.use(createNotificationSettingsRouter(deps));
  router.use(createControlSettingsRouter(deps));
  router.use(createAiPolicyRouter(deps));
  router.use(createRetiredLeftoversRouter(deps));
  router.use(createRecruitingHoursRouter(deps));
  router.use(createFinanceSettingsRouter(deps));
  router.use(createSafetyApprovalSettingsRouter(deps));

  return router;
}

module.exports = { createSettingsRouter };
