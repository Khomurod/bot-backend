/**
 * Route Control — public façade.
 *
 * The ONLY entry point other parts of the app should use. Nothing inside this
 * package may require this file (or ../routeControlService): dependencies flow
 * one way, façade → focused modules → database/integrations → pure helpers.
 *
 * Assigns a Google Maps directions link to a driver group (parsing the link and
 * computing route geometry via the Routes API), then periodically compares the
 * driver's live GPS to that route and warns the driver group when they drift off
 * it. All Google calls are server-side and gated on Settings → GMaps — except
 * destination auto-completion, which runs regardless (see monitor.js).
 */
const { classifyTelegramPhotoError, classifyTelegramEditError } = require('./errors');
const {
  destinationCoordFromPolyline, parseRouteLink,
} = require('./geometryService');
const {
  cleanAddressText, estimatedCaptionLength, describeTrackingStartCondition,
  buildDriverGroupRouteMessage, buildOffRouteMessage,
} = require('./messageFormatter');
const { buildDeliveryMessageList, parseDeliveryMessages } = require('./deliveryRecords');
const {
  normalizeTrackingOptions, evaluateTrackingStart, startTrackingNow,
} = require('./trackingStartService');
const { evaluateAssignment } = require('./deviationMonitor');
const { monitorSettingsFromConfig } = require('./monitorSettings');
const { evaluateDestinationCompletion, runCompletionCheckNow } = require('./completionService');
const {
  assignRoute, cancelActiveRoutesForGroup, computeGeometryForAssignment,
} = require('./assignmentService');
const { sendDriverGroupRouteMessage } = require('./screenshotDelivery');
const { updateDriverGroupRouteMessage } = require('./telegramMessageEditor');
const {
  runRouteMonitorCheck, tick, startRouteControlService, stopRouteControlService,
} = require('./monitor');

module.exports = {
  // ── Pure decision functions (unit-tested without DB / network / Telegram) ──
  evaluateAssignment,
  evaluateDestinationCompletion,
  destinationCoordFromPolyline,
  evaluateTrackingStart,
  normalizeTrackingOptions,
  cleanAddressText,
  describeTrackingStartCondition,
  classifyTelegramPhotoError,
  classifyTelegramEditError,
  buildDeliveryMessageList,
  parseDeliveryMessages,
  estimatedCaptionLength,
  buildDriverGroupRouteMessage,
  buildOffRouteMessage,
  monitorSettingsFromConfig,

  // ── Assignment lifecycle ──
  parseRouteLink,
  assignRoute,
  cancelActiveRoutesForGroup,
  computeGeometryForAssignment,
  startTrackingNow,

  // ── Telegram delivery ──
  sendDriverGroupRouteMessage,
  updateDriverGroupRouteMessage,

  // ── Monitoring ──
  runRouteMonitorCheck,
  runCompletionCheckNow,
  startRouteControlService,
  stopRouteControlService,
  tick,
};
