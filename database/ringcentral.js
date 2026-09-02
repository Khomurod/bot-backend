/**
 * RingCentral recruiter-call KPIs — database façade.
 *
 * RE-EXPORT ONLY. Routes and services import `database/ringcentral`, so the
 * path stays the stable public seam while the code lives in focused modules
 * with a strictly one-way dependency direction:
 *
 *   ./ringcentral/kpiMath.js     PURE scoring arithmetic (no database at all)
 *   ./ringcentral/secrets.js     decrypt-safely / mask, shared by the two below
 *   ./ringcentral/settings.js    the settings row + its cache (sole owner)
 *   ./ringcentral/recruiters.js  recruiter rows and per-recruiter credentials
 *   ./ringcentral/calls.js       raw call records (idempotent upsert)
 *   ./ringcentral/kpiQueries.js  reads windows of calls, scores via kpiMath
 *
 * Nothing but re-exports belongs here — see CLAUDE.md → Module design. The keys
 * below are listed EXPLICITLY rather than spread: several sibling modules export
 * helpers to each other (getSettingsRow, toAdminRecruiter, rollupRecruiterKpis,
 * recruiterSecretSets) that were file-internal before the split and must not
 * become public API by accident.
 */
const kpiMath = require('./ringcentral/kpiMath');
const settings = require('./ringcentral/settings');
const recruiters = require('./ringcentral/recruiters');
const calls = require('./ringcentral/calls');
const kpiQueries = require('./ringcentral/kpiQueries');

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
  listRecruiters: recruiters.listRecruiters,
  listRecruitersForAdmin: recruiters.listRecruitersForAdmin,
  getRecruiterById: recruiters.getRecruiterById,
  resolveRecruiterRcAuth: recruiters.resolveRecruiterRcAuth,
  createRecruiter: recruiters.createRecruiter,
  updateRecruiter: recruiters.updateRecruiter,
  deleteRecruiter: recruiters.deleteRecruiter,
  getRecruiterByNormalizedNumber: recruiters.getRecruiterByNormalizedNumber,

  // Call records and KPI reads
  upsertCall: calls.upsertCall,
  getRecruiterStats: kpiQueries.getRecruiterStats,
  getRecruiterStatsRange: kpiQueries.getRecruiterStatsRange,
};
