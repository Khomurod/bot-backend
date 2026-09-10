/**
 * Driver Home-Time Tracking — database façade.
 *
 * RE-EXPORT ONLY. A dozen services and routes import `database/homeTime`, so
 * this path stays the stable public seam while the queries live in focused
 * modules grouped by what they own:
 *
 *   ./homeTime/settings.js     the two single-row settings tables
 *   ./homeTime/driverState.js  one row per group: home or on the road, since when
 *   ./homeTime/roadHistory.js  completed road legs + the atomic bonus claim
 *   ./homeTime/requests.js     the request state machine (pending → decided)
 *   ./homeTime/integrity.js    the boot-time guard for "one open stay per group"
 *   ./homeTime/notices.js      the manager-notice outbox (told once, durably)
 *   ./homeTimeClarification.js the restart-safe reminder sweep and claims
 *   ./homeTimeExpiry.js        stale-request expiry (imported directly)
 *
 * Nothing but re-exports belongs here — see CLAUDE.md → Module design. Add new
 * queries to the module that owns the table, then surface them below.
 */
const settings = require('./homeTime/settings');
const driverState = require('./homeTime/driverState');
const roadHistory = require('./homeTime/roadHistory');
const requests = require('./homeTime/requests');
const integrity = require('./homeTime/integrity');
const notices = require('./homeTime/notices');
const clarification = require('./homeTimeClarification');

module.exports = {
  // Status vocabularies (owned by ./homeTime/requests.js and the clarification worker)
  AWAITING_STATUSES: requests.AWAITING_STATUSES,
  OPEN_CLARIFICATION_STATUSES: requests.OPEN_CLARIFICATION_STATUSES,
  OPEN_REQUEST_STATUSES: requests.OPEN_REQUEST_STATUSES,

  // Manager notices — the three home-time events, each delivered exactly once
  enqueueNotice: notices.enqueueNotice,
  noticeExists: notices.noticeExists,
  claimNoticeById: notices.claimNoticeById,
  claimDueNotices: notices.claimDueNotices,
  reapExhaustedNotices: notices.reapExhaustedNotices,
  markNoticeDelivered: notices.markNoticeDelivered,
  markNoticeFailed: notices.markNoticeFailed,
  releaseNoticeClaim: notices.releaseNoticeClaim,
  countFailedNotices: notices.countFailedNotices,
  listNoticesForPerson: notices.listNoticesForPerson,

  // Settings rows
  getHomeTimeSettings: settings.getHomeTimeSettings,
  updateHomeTimeSettings: settings.updateHomeTimeSettings,
  getBotAccessSettings: settings.getBotAccessSettings,
  updateBotAccessSettings: settings.updateBotAccessSettings,

  // Current per-group home/road state
  getDriverHomeStatus: driverState.getDriverHomeStatus,
  upsertDriverHomeStatus: driverState.upsertDriverHomeStatus,
  setRoadBonusWeeksNotified: driverState.setRoadBonusWeeksNotified,
  listOnRoadStatuses: driverState.listOnRoadStatuses,
  touchDriverHomeStatus: driverState.touchDriverHomeStatus,
  listCurrentStatuses: driverState.listCurrentStatuses,
  setDriverHomeStateSince: driverState.setDriverHomeStateSince,
  setDriverHomeState: driverState.setDriverHomeState,

  // Completed road legs, home stays, efficiency and the road-bonus claim
  insertRoadHistory: roadHistory.insertRoadHistory,
  getOpenHomeStay: roadHistory.getOpenHomeStay,
  listOpenHomeStays: roadHistory.listOpenHomeStays,
  closeHomeStay: roadHistory.closeHomeStay,
  listCyclesForEfficiency: roadHistory.listCyclesForEfficiency,
  listUnpostedRoadBonuses: roadHistory.listUnpostedRoadBonuses,
  claimRoadBonusPost: roadHistory.claimRoadBonusPost,
  unclaimRoadBonusPost: roadHistory.unclaimRoadBonusPost,
  listRoadHistory: roadHistory.listRoadHistory,
  getRoadHistoryById: roadHistory.getRoadHistoryById,
  updateRoadHistory: roadHistory.updateRoadHistory,
  deleteRoadHistory: roadHistory.deleteRoadHistory,

  // Integrity guard (boot)
  ensureOpenStayIndex: integrity.ensureOpenStayIndex,

  // Request lifecycle
  insertHomeTimeRequest: requests.insertHomeTimeRequest,
  updateHomeTimeRequestFields: requests.updateHomeTimeRequestFields,
  getHomeTimeRequestById: requests.getHomeTimeRequestById,
  getPendingHomeTimeRequestForGroup: requests.getPendingHomeTimeRequestForGroup,
  getOpenHomeTimeRequestForGroup: requests.getOpenHomeTimeRequestForGroup,
  getOpenClarificationForGroup: requests.getOpenClarificationForGroup,
  getAwaitingDatesHomeTimeRequestForGroup: requests.getAwaitingDatesHomeTimeRequestForGroup,
  getApprovedHomeTimeRequestForGroup: requests.getApprovedHomeTimeRequestForGroup,
  findDecidedRequestNearDate: requests.findDecidedRequestNearDate,
  fulfillAwaitingHomeTimeRequest: requests.fulfillAwaitingHomeTimeRequest,
  setHomeTimeClarificationMessage: requests.setHomeTimeClarificationMessage,
  markHomeTimeAcknowledged: requests.markHomeTimeAcknowledged,
  expireOpenClarificationsForGroup: requests.expireOpenClarificationsForGroup,
  decideHomeTimeRequest: requests.decideHomeTimeRequest,
  setHomeTimeRequestMessage: requests.setHomeTimeRequestMessage,
  findHomeTimeRequestByWindow: requests.findHomeTimeRequestByWindow,
  listHomeTimeRequests: requests.listHomeTimeRequests,

  // Clarification reminder worker (atomic claims)
  cancelHomeTimeReminderSchedule: clarification.cancelHomeTimeReminderSchedule,
  listDueHomeTimeReminders: clarification.listDueHomeTimeReminders,
  claimHomeTimeReminder: clarification.claimHomeTimeReminder,
  markHomeTimeClarificationUnanswered: clarification.markHomeTimeClarificationUnanswered,
};
