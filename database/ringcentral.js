/**
 * RingCentral recruiter-call KPIs — database façade.
 *
 * RE-EXPORT ONLY. Routes and services import `database/ringcentral`, so the
 * path stays the stable public seam while the code lives in focused modules
 * with a strictly one-way dependency direction:
 *
 *   ./ringcentral/kpiMath.js     PURE scoring arithmetic (no database at all)
 *   ./ringcentral/secrets.js     decrypt-safely / mask, shared by the two below
 *   ./ringcentral/leaderboardCache.js  the public board's kept answer (a leaf)
 *   ./ringcentral/settings.js    the settings row + its cache (sole owner)
 *   ./ringcentral/recruiters.js  recruiter rows and per-recruiter credentials
 *   ./ringcentral/recruiterRosters.js  the narrow lists background passes read
 *   ./ringcentral/calls.js       raw call records (upsert, unchanged ones skipped)
 *   ./ringcentral/kpiQueries.js  totals windows of calls in SQL, scores via kpiMath
 *   ./ringcentral/connectSessions.js  the short-lived recruiter login links
 *
 * Nothing but re-exports belongs here — see CLAUDE.md → Module design. The keys
 * below are listed EXPLICITLY rather than spread: several sibling modules export
 * helpers to each other (getSettingsRow, toAdminRecruiter, rollupRecruiterKpis,
 * recruiterSecretSets, the leaderboard cache's read-through and invalidation)
 * that are internal to this package and must not become public API by accident.
 */
const kpiMath = require('./ringcentral/kpiMath');
const settings = require('./ringcentral/settings');
const recruiters = require('./ringcentral/recruiters');
const rosters = require('./ringcentral/recruiterRosters');
const calls = require('./ringcentral/calls');
const kpiQueries = require('./ringcentral/kpiQueries');
const connectSessions = require('./ringcentral/connectSessions');

module.exports = {
  // Pure KPI arithmetic
  DEFAULT_TARGET_TALK_SECONDS: kpiMath.DEFAULT_TARGET_TALK_SECONDS,
  formatTalkLabel: kpiMath.formatTalkLabel,
  resolveThresholds: kpiMath.resolveThresholds,
  buildTargets: kpiMath.buildTargets,
  summarizeCalls: kpiMath.summarizeCalls,
  computeRecruiterKpis: kpiMath.computeRecruiterKpis,

  // Settings row and credentials
  getRcConfig: settings.getRcConfig,
  getRcSettingsForAdmin: settings.getRcSettingsForAdmin,
  updateRcSettings: settings.updateRcSettings,
  markSyncResult: settings.markSyncResult,
  invalidateSettingsCache: settings.invalidateSettingsCache,

  // Recruiters
  normalizePhone: recruiters.normalizePhone,
  normalizeBitrixUserId: recruiters.normalizeBitrixUserId,
  recruiterCanSendSms: recruiters.recruiterCanSendSms,
  hasMappedSmsSenders: recruiters.hasMappedSmsSenders,
  listRecruiters: recruiters.listRecruiters,
  listRecruitersForAdmin: recruiters.listRecruitersForAdmin,
  getRecruiterById: recruiters.getRecruiterById,
  resolveRecruiterRcAuth: recruiters.resolveRecruiterRcAuth,
  createRecruiter: recruiters.createRecruiter,
  updateRecruiter: recruiters.updateRecruiter,
  deleteRecruiter: recruiters.deleteRecruiter,
  getRecruiterByNormalizedNumber: recruiters.getRecruiterByNormalizedNumber,
  getRecruiterByBitrixUserId: recruiters.getRecruiterByBitrixUserId,

  // The narrow lists background passes read (see recruiterRosters.js)
  listRecruitersWithOwnCredentials: rosters.listRecruitersWithOwnCredentials,
  listRecruiterSmsExtensions: rosters.listRecruiterSmsExtensions,
  listRecruitersForCallSync: rosters.listRecruitersForCallSync,

  // Per-recruiter RingCentral OAuth credentials
  storeRecruiterOAuthTokens: recruiters.storeRecruiterOAuthTokens,
  updateRecruiterRcIdentity: recruiters.updateRecruiterRcIdentity,
  updateRecruiterRefreshToken: recruiters.updateRecruiterRefreshToken,
  markRecruiterAuthError: recruiters.markRecruiterAuthError,
  clearRecruiterOAuth: recruiters.clearRecruiterOAuth,

  // Recruiter RingCentral login links
  createRcConnectSession: connectSessions.createRcConnectSession,
  getRcConnectSessionByToken: connectSessions.getRcConnectSessionByToken,
  getRcConnectSessionByOAuthState: connectSessions.getRcConnectSessionByOAuthState,
  setRcConnectSessionOAuthState: connectSessions.setRcConnectSessionOAuthState,
  completeRcConnectSession: connectSessions.completeRcConnectSession,
  markRcConnectSessionError: connectSessions.markRcConnectSessionError,
  expireOldRcConnectSessions: connectSessions.expireOldRcConnectSessions,

  // Call records and KPI reads
  upsertCall: calls.upsertCall,
  getRecruiterStats: kpiQueries.getRecruiterStats,
  getRecruiterStatsRange: kpiQueries.getRecruiterStatsRange,
  getPublicRecruiterStats: kpiQueries.getPublicRecruiterStats,
};
