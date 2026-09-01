/**
 * 75¢/mile Driver Raise Approval service — round lifecycle, weekly schedule,
 * and the public surface the routes and `index.js` import.
 *
 * Flow:
 *  - Admin manages dispatch teams + the company drivers each team covers, and a
 *    settings row (enable/disable, OTP channel, weekly schedule, rates, link TTL).
 *  - On a schedule (or "Send now"), a round is opened with a tokenized public
 *    link and the review REQUEST is posted to the Dispatch Rate Review group.
 *  - A dispatcher opens the link, picks their team, verifies via an OTP (Gmail or
 *    RingCentral SMS), and marks which drivers qualify for the 75¢ rate.
 *  - On submit, the response is recorded (who approved/disapproved) and the
 *    RESULT is posted to the Driver Raise Results (accounting) group.
 *
 * TWO INDEPENDENT TELEGRAM DESTINATIONS, two different audiences, both
 * admin-configured in Settings → Telegram Groups:
 *   request → message category 'dispatchReview'  (dispatch does the work)
 *   result  → message category 'raiseResults'    (accounting pays the rate)
 * Neither is a fallback for the other. An admin may point both at the same
 * group, but the app must never do that on its own. A missing request group is a
 * hard configuration error (no round is opened, nothing is sent); a missing
 * results group NEVER loses the dispatcher's saved submission — it is logged and
 * reported instead. See ./raise/notifications.js.
 *
 * Sleep/restart-safe: the weekly auto-send is idempotent via service_runs.
 *
 * The focused modules behind this file (dependencies flow one way — nothing in
 * services/raise/ requires this file):
 *   ./raise/errors.js         stable error code + HTTP status
 *   ./raise/notifications.js  the two Telegram destinations + message text
 *   ./raise/teamRoster.js     dispatch teams: drivers, members, backfill
 *   ./raise/dispatcherFlow.js the tokenized public link flow (info/OTP/submit)
 */
const { DateTime } = require('luxon');
const crypto = require('node:crypto');
const db = require('../database/db');
const ra = require('../database/raiseApproval');
const config = require('../config/config');
const { serviceError } = require('./raise/errors');
const notifications = require('./raise/notifications');
const teamRoster = require('./raise/teamRoster');
const dispatcherFlow = require('./raise/dispatcherFlow');
const { computeNextWeeklyOccurrence, describeWeeklySchedule } = require('./scheduledMessageUtils');
const { createDueTimeWakeTimer } = require('./dueTimeWakeTimer');

// The weekly round stores next_run_at, so the scheduler sleeps until it is due
// rather than asking PostgreSQL every minute whether a once-a-week event has
// arrived. recomputeNextRun() re-arms the moment an admin changes the schedule.
let wakeTimer = null;
let serviceStopped = false;
let tickRunning = false;

function publicLinkBase() {
  return String(config.renderExternalUrl || '').replace(/\/+$/, '');
}

function roundLink(token) {
  const base = publicLinkBase();
  return base ? `${base}/raise/${token}` : `/raise/${token}`;
}

/**
 * Default pay period = the most recently completed Monday–Sunday week.
 *
 * On a Sunday (the default schedule day) this is the Monday→Sunday week that
 * ends on THAT SAME Sunday: daysSinceSunday is 0, so periodEnd is today and
 * periodStart is the Monday six days earlier. On any other day it is the prior
 * completed week (ending the most recent Sunday).
 *
 * @param {string} [timezone='America/Chicago']
 * @param {DateTime} [reference]  injectable "now" for testing; defaults to now.
 */
function defaultPreviousWeek(timezone, reference) {
  const base = reference || DateTime.now();
  const ref = base.setZone(timezone || 'America/Chicago').startOf('day');
  const daysSinceSunday = ref.weekday % 7; // Sun(7)->0, Mon(1)->1, ...
  const periodEnd = ref.minus({ days: daysSinceSunday }); // this/last Sunday
  const periodStart = periodEnd.minus({ days: 6 }); // Monday before
  return { periodStart: periodStart.toISODate(), periodEnd: periodEnd.toISODate() };
}

// ─── Open a round + post the review request to the dispatch group ───

async function openRoundAndPost({ periodStart, periodEnd, requestedBy = null } = {}) {
  const settings = await ra.getRaiseSettings();
  if (!settings) throw serviceError('NO_SETTINGS', 'Raise settings are not initialized.', 500);
  // The 72–75 CPM review REQUEST goes to the admin-configured Dispatch Rate
  // Review group — never a hardcoded employee group ID, and never the accounting
  // results group. Resolved BEFORE the round is minted: no configured group ⇒
  // don't open a round and don't send; surface a clear configuration error.
  const reviewGroupId = await notifications.resolveReviewRequestGroupId();
  if (!periodStart || !periodEnd) {
    const def = defaultPreviousWeek(settings.schedule_timezone);
    periodStart = periodStart || def.periodStart;
    periodEnd = periodEnd || def.periodEnd;
  }

  // One open round at a time: close any lingering open round first.
  const existing = await ra.getOpenRound();
  if (existing) await ra.closeRound(existing.id);

  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = DateTime.now().plus({ hours: settings.link_ttl_hours || 48 }).toISO();
  const round = await ra.createRound({
    periodStart,
    periodEnd,
    accessToken: token,
    expiresAt,
    rateLow: settings.rate_low,
    rateHigh: settings.rate_high,
    createdBy: requestedBy,
  });

  const link = roundLink(token);
  const sent = await notifications.postReviewRequest({
    chatId: reviewGroupId,
    periodStart,
    periodEnd,
    link,
    rateLow: settings.rate_low,
    rateHigh: settings.rate_high,
    linkTtlHours: settings.link_ttl_hours || 48,
  });
  await ra.setRoundEmployeeMessage(round.id, reviewGroupId, sent?.message_id || null);

  return { round, link };
}

// ─── Admin: send now / schedule helpers ───

async function sendNow({ periodStart, periodEnd, requestedBy } = {}) {
  return openRoundAndPost({ periodStart, periodEnd, requestedBy });
}

function describeSchedule(settings) {
  if (!settings?.schedule_enabled) return 'Off';
  return describeWeeklySchedule(
    settings.weekly_day_of_week,
    settings.weekly_time_local,
    settings.schedule_timezone
  );
}

// ─── Weekly scheduler ───

async function recomputeNextRun(settings) {
  const next = computeNextWeeklyOccurrence({
    dayOfWeek: settings.weekly_day_of_week,
    timeOfDay: settings.weekly_time_local,
    timezone: settings.schedule_timezone,
  });
  await ra.updateRaiseSettings({ next_run_at: next ? next.toUTC().toISO() : null });
  // The admin panel calls this after a schedule change; re-arm so a new time
  // takes effect immediately rather than on the next capped wake.
  wakeTimer?.rearm(next ? next.toMillis() : null);
  return next;
}

/**
 * One scheduler pass. Resolves `{ retry, nextRunAtMs }` so the wake chain knows
 * when to come back: the stored next_run_at when the schedule is healthy, or
 * the fast retry cadence when an auto-send failed and released its claim.
 */
async function tick() {
  if (tickRunning) return { retry: false };
  tickRunning = true;
  try {
    const settings = await ra.getRaiseSettings();
    // Disabled: nothing to compute. The capped wake still re-reads settings, so
    // re-enabling from the admin panel is picked up without a restart.
    if (!settings || !settings.enabled || !settings.schedule_enabled) return { retry: false };

    if (!settings.next_run_at) {
      const next = await recomputeNextRun(settings);
      return { retry: false, dueAtMs: next ? next.toMillis() : null };
    }
    const now = DateTime.now();
    const dueAt = DateTime.fromISO(settings.next_run_at);
    if (dueAt > now) return { retry: false, dueAtMs: dueAt.toMillis() };

    const def = defaultPreviousWeek(settings.schedule_timezone);
    // Idempotent: at most one auto-send per pay period across restarts.
    const claimed = await db.claimServiceRun('raise', `weekly:${def.periodEnd}`);
    let sendFailed = false;
    if (claimed) {
      try {
        await openRoundAndPost({
          periodStart: def.periodStart,
          periodEnd: def.periodEnd,
          requestedBy: 'scheduler',
        });
        console.log(`[RAISE] Weekly round opened for ${def.periodStart}→${def.periodEnd}`);
      } catch (err) {
        sendFailed = true;
        await db.unclaimServiceRun('raise', `weekly:${def.periodEnd}`).catch(() => {});
        console.error('[RAISE] Weekly auto-send failed (will retry):', err.message);
      }
    }
    const next = await recomputeNextRun(settings);
    return { retry: sendFailed, dueAtMs: next ? next.toMillis() : null };
  } catch (err) {
    console.error('[RAISE] Scheduler tick error:', err.message);
    return { retry: true };
  } finally {
    tickRunning = false;
  }
}

function startRaiseApprovalService() {
  serviceStopped = false;
  console.log('[RAISE] Driver raise approval service started.');
  // One-shot, best-effort: link any legacy name-only team-driver rows to
  // driver profiles now that Driver Groups is the source of truth.
  teamRoster.backfillLegacyTeamDriverLinks().catch((err) => {
    console.error('[RAISE] Legacy team-driver backfill failed (non-fatal):', err.message);
  });
  // First pass shortly after boot, then sleep until next_run_at is actually due.
  wakeTimer = createDueTimeWakeTimer({ label: 'RAISE', runTick: tick });
  wakeTimer.start(12 * 1000);
}

function stopRaiseApprovalService() {
  serviceStopped = true;
  if (wakeTimer) {
    wakeTimer.stop();
    wakeTimer = null;
  }
}

module.exports = {
  startRaiseApprovalService,
  stopRaiseApprovalService,
  tick,
  // Dispatch-team roster (services/raise/teamRoster.js)
  fetchCompanyDriverCandidates: teamRoster.fetchCompanyDriverCandidates,
  listAssignableDrivers: teamRoster.listAssignableDrivers,
  assignDriverToTeamFromGroups: teamRoster.assignDriverToTeamFromGroups,
  createTeamMember: teamRoster.createTeamMember,
  updateTeamMember: teamRoster.updateTeamMember,
  backfillLegacyTeamDriverLinks: teamRoster.backfillLegacyTeamDriverLinks,
  candidateFromDirectoryRow: teamRoster.candidateFromDirectoryRow,
  // Round lifecycle
  openRoundAndPost,
  sendNow,
  // Public dispatcher link flow (services/raise/dispatcherFlow.js)
  getPublicRoundInfo: dispatcherFlow.getPublicRoundInfo,
  getTeamDriversForRound: dispatcherFlow.getTeamDriversForRound,
  requestOtp: dispatcherFlow.requestOtp,
  verifyOtp: dispatcherFlow.verifyOtp,
  submitResponse: dispatcherFlow.submitResponse,
  // Schedule
  describeSchedule,
  defaultPreviousWeek,
  recomputeNextRun,
};
