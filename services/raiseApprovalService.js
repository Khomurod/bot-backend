/**
 * 75¢/mile Driver Raise Approval service.
 *
 * Flow:
 *  - Admin manages dispatch teams + the company drivers each team covers, and a
 *    settings row (enable/disable, OTP channel, weekly schedule, rates, link TTL).
 *  - On a schedule (or "Send now"), a round is opened with a tokenized public
 *    link and a message is posted into the employee Telegram group.
 *  - A dispatcher opens the link, picks their team, verifies via an OTP (Gmail or
 *    RingCentral SMS), and marks which drivers qualify for the 75¢ rate.
 *  - On submit, the response is recorded (who approved/disapproved) and posted to
 *    the "Bonus Penalty For Drivers" group.
 *
 * Sleep/restart-safe: the weekly auto-send is idempotent via service_runs.
 */
const { DateTime } = require('luxon');
const crypto = require('node:crypto');
const db = require('../database/db');
const ra = require('../database/raiseApproval');
const config = require('../config/config');
const { bot } = require('../bot/bot');
const { safeSend } = require('./telegramHtml');
const datatruck = require('./datatruckApiService');
const { normalizeDriverName, BONUS_GROUP_CHAT_ID } = require('./mileageBonusConstants');
const otp = require('./otpService');
const { decryptText } = require('./facebookCrypto');
const { computeNextWeeklyOccurrence, describeWeeklySchedule } = require('./scheduledMessageUtils');

const POLL_MS = 60 * 1000;
const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RATE_WINDOW_MINUTES = 10;
const OTP_RATE_MAX = 3;

let serviceTimer = null;
let serviceStopped = false;
let tickRunning = false;

function serviceError(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function publicLinkBase() {
  return String(config.renderExternalUrl || '').replace(/\/+$/, '');
}

function roundLink(token) {
  const base = publicLinkBase();
  return base ? `${base}/raise/${token}` : `/raise/${token}`;
}

/** Default pay period = most recently completed Monday–Sunday week. */
function defaultPreviousWeek(timezone) {
  const ref = DateTime.now().setZone(timezone || 'America/Chicago').startOf('day');
  const daysSinceSunday = ref.weekday % 7; // Sun(7)->0, Mon(1)->1, ...
  const periodEnd = ref.minus({ days: daysSinceSunday }); // last Sunday
  const periodStart = periodEnd.minus({ days: 6 }); // Monday before
  return { periodStart: periodStart.toISODate(), periodEnd: periodEnd.toISODate() };
}

function formatRate(value) {
  const cents = Math.round(Number(value) * 100);
  return `${cents}¢`;
}

/** Resolve the Gmail credentials configured in the admin panel (decrypted). */
function resolveGmailCredsFromSettings(settings) {
  let gmailAppPassword = '';
  if (settings?.gmail_app_password_encrypted) {
    try {
      gmailAppPassword = decryptText(settings.gmail_app_password_encrypted);
    } catch (err) {
      console.error('[RAISE] Could not decrypt Gmail App Password:', err.message);
    }
  }
  return {
    gmailUser: settings?.gmail_user || '',
    gmailAppPassword,
    gmailFrom: settings?.gmail_user || '',
  };
}

// ─── Company-driver candidate list (Datatruck) ───

async function fetchCompanyDriverCandidates() {
  if (!datatruck.isConfigured()) {
    throw serviceError('DATATRUCK_NOT_CONFIGURED', 'Datatruck API is not configured.', 409);
  }
  const rows = await datatruck.fetchAllDrivers();
  const byName = new Map();
  for (const d of rows) {
    if (d.driver_type !== 'company_driver') continue;
    const fullName = d.account?.full_name
      || [d.account?.first_name, d.account?.last_name].filter(Boolean).join(' ');
    const normalized = normalizeDriverName(fullName);
    if (!normalized || byName.has(normalized)) continue;
    byName.set(normalized, {
      driver_external_id: d.id != null ? String(d.id) : null,
      driver_normalized_name: normalized,
      driver_name: fullName,
    });
  }
  return [...byName.values()].sort((a, b) => a.driver_name.localeCompare(b.driver_name));
}

// ─── Open a round + post the employee-group message ───

async function openRoundAndPost({ periodStart, periodEnd, requestedBy = null } = {}) {
  const settings = await ra.getRaiseSettings();
  if (!settings) throw serviceError('NO_SETTINGS', 'Raise settings are not initialized.', 500);
  if (!config.employeeGroupId) {
    throw serviceError('NO_EMPLOYEE_GROUP', 'EMPLOYEE_GROUP_ID is not configured.', 409);
  }
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
  const text = `💵 <b>Driver Raise Review — ${formatRate(settings.rate_high)}/mile</b>\n\n`
    + `Pay period: <b>${escapeHtml(periodStart)} → ${escapeHtml(periodEnd)}</b>\n\n`
    + `Dispatch team: please mark which company drivers performed well and cooperated this week, `
    + `so they earn <b>${formatRate(settings.rate_high)}/mile</b> (instead of ${formatRate(settings.rate_low)}/mile) for this period.\n\n`
    + `👉 <a href="${escapeHtml(link)}">Open the review form</a>\n\n`
    + `<i>The link expires in ${settings.link_ttl_hours || 48} hours.</i>`;

  const sent = await safeSend(() => bot.telegram.sendMessage(config.employeeGroupId, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }));
  await ra.setRoundEmployeeMessage(round.id, config.employeeGroupId, sent?.message_id || null);

  return { round, link };
}

// ─── Public: round info / team drivers ───

function assertRoundUsable(round) {
  if (!round) throw serviceError('NOT_FOUND', 'This review link was not found.', 404);
  if (round.status !== 'open') throw serviceError('CLOSED', 'This review round has been closed.', 410);
  if (DateTime.fromISO(round.expires_at) <= DateTime.now()) {
    throw serviceError('EXPIRED', 'This review link has expired.', 410);
  }
}

async function getPublicRoundInfo(token) {
  const round = await ra.getRoundByToken(token);
  assertRoundUsable(round);
  const settings = await ra.getRaiseSettings();
  const teams = await ra.listDispatchTeams({ includeInactive: false });
  return {
    period_start: round.period_start,
    period_end: round.period_end,
    rate_low: round.rate_low,
    rate_high: round.rate_high,
    otp_channel: settings.otp_channel,
    contact_type: otp.contactTypeForChannel(settings.otp_channel),
    teams: teams.map((t) => ({ id: t.id, name: t.name })),
  };
}

async function getTeamDriversForRound(token, teamId) {
  const round = await ra.getRoundByToken(token);
  assertRoundUsable(round);
  const team = await ra.getDispatchTeam(teamId);
  if (!team || !team.active) throw serviceError('NO_TEAM', 'Dispatch team not found.', 404);
  const drivers = await ra.listTeamDrivers(teamId);
  return drivers.map((d) => ({
    driver_normalized_name: d.driver_normalized_name,
    driver_name: d.driver_name,
  }));
}

// ─── Public: request + verify OTP ───

async function requestOtp({ token, teamId, contact }) {
  const round = await ra.getRoundByToken(token);
  assertRoundUsable(round);
  const team = await ra.getDispatchTeam(teamId);
  if (!team || !team.active) throw serviceError('NO_TEAM', 'Dispatch team not found.', 404);

  const settings = await ra.getRaiseSettings();
  const channel = settings.otp_channel;
  const gmailCreds = resolveGmailCredsFromSettings(settings);
  if (!otp.isChannelConfigured(channel, gmailCreds)) {
    throw serviceError('CHANNEL_NOT_CONFIGURED', `The ${channel} code channel is not configured yet. Add it in the admin panel.`, 409);
  }

  const normalizedContact = channel === 'ringcentral'
    ? otp.normalizePhone(contact)
    : String(contact || '').trim().toLowerCase();
  if (!normalizedContact
    || (channel === 'gmail' && !otp.isValidEmail(normalizedContact))) {
    throw serviceError('INVALID_CONTACT', 'Please enter a valid contact.', 400);
  }

  const recent = await ra.countRecentOtps(round.id, normalizedContact, OTP_RATE_WINDOW_MINUTES);
  if (recent >= OTP_RATE_MAX) {
    throw serviceError('RATE_LIMITED', 'Too many code requests. Please wait a few minutes and try again.', 429);
  }

  const code = otp.generateCode();
  const codeHash = otp.hashCode(code, normalizedContact);
  const expiresAt = DateTime.now().plus({ minutes: OTP_TTL_MINUTES }).toISO();
  await ra.createOtp({
    roundId: round.id,
    teamId,
    contact: normalizedContact,
    contactType: otp.contactTypeForChannel(channel),
    codeHash,
    expiresAt,
  });

  const delivery = await otp.sendCode(channel, normalizedContact, code, gmailCreds);
  if (!delivery.ok) {
    throw serviceError('SEND_FAILED', `Could not send the code (${delivery.reason}).`, 502);
  }
  return { sent: true, contact_type: otp.contactTypeForChannel(channel) };
}

async function verifyOtp({ token, contact }, code) {
  const round = await ra.getRoundByToken(token);
  assertRoundUsable(round);
  const settings = await ra.getRaiseSettings();
  const normalizedContact = settings.otp_channel === 'ringcentral'
    ? otp.normalizePhone(contact)
    : String(contact || '').trim().toLowerCase();

  const record = await ra.getLatestOtp(round.id, normalizedContact);
  if (!record) throw serviceError('NO_CODE', 'Please request a code first.', 400);
  if (record.verified) return { verified: true };
  if (DateTime.fromISO(record.expires_at) <= DateTime.now()) {
    throw serviceError('CODE_EXPIRED', 'That code has expired. Please request a new one.', 410);
  }
  if (record.attempts >= OTP_MAX_ATTEMPTS) {
    throw serviceError('TOO_MANY_ATTEMPTS', 'Too many incorrect attempts. Please request a new code.', 429);
  }

  if (!otp.verifyCode(code, normalizedContact, record.code_hash)) {
    await ra.incrementOtpAttempts(record.id);
    throw serviceError('BAD_CODE', 'That code is not correct.', 400);
  }
  await ra.markOtpVerified(record.id);
  return { verified: true };
}

// ─── Public: submit the team's response ───

async function submitResponse({
  token, teamId, dispatcherName, contact, picks,
}) {
  const round = await ra.getRoundByToken(token);
  assertRoundUsable(round);
  const team = await ra.getDispatchTeam(teamId);
  if (!team || !team.active) throw serviceError('NO_TEAM', 'Dispatch team not found.', 404);

  const settings = await ra.getRaiseSettings();
  const channel = settings.otp_channel;
  const normalizedContact = channel === 'ringcentral'
    ? otp.normalizePhone(contact)
    : String(contact || '').trim().toLowerCase();

  if (!(await ra.isContactVerified(round.id, normalizedContact))) {
    throw serviceError('NOT_VERIFIED', 'Please verify your code before submitting.', 403);
  }
  const name = String(dispatcherName || '').trim();
  if (!name) throw serviceError('NO_NAME', 'Please enter your name.', 400);

  // Only accept picks for drivers actually assigned to this team.
  const assigned = await ra.listTeamDrivers(teamId);
  if (!assigned.length) throw serviceError('NO_DRIVERS', 'This team has no assigned drivers.', 409);
  const byNorm = new Map(assigned.map((d) => [d.driver_normalized_name, d]));
  const cleanPicks = [];
  for (const p of Array.isArray(picks) ? picks : []) {
    const match = byNorm.get(p.driver_normalized_name);
    if (!match) continue;
    cleanPicks.push({
      driver_normalized_name: match.driver_normalized_name,
      driver_name: match.driver_name,
      qualified: Boolean(p.qualified),
    });
  }
  if (cleanPicks.length !== assigned.length) {
    throw serviceError('INCOMPLETE', 'Please mark every driver as qualifies or does not qualify.', 400);
  }

  const submission = await ra.saveSubmissionWithPicks({
    roundId: round.id,
    teamId,
    dispatcherName: name,
    dispatcherContact: normalizedContact,
    contactType: otp.contactTypeForChannel(channel),
    picks: cleanPicks,
  });

  await postSubmissionSummary({ round, team, name, picks: cleanPicks });
  return { submitted: true, submission_id: submission.id };
}

async function postSubmissionSummary({ round, team, name, picks }) {
  const qualified = picks.filter((p) => p.qualified);
  const notQualified = picks.filter((p) => !p.qualified);
  const list = (rows) => (rows.length
    ? rows.map((r) => `• ${escapeHtml(r.driver_name)}`).join('\n')
    : '— none —');

  const text = `🧾 <b>Driver Raise Review submitted</b>\n`
    + `Team: <b>${escapeHtml(team.name)}</b> (by ${escapeHtml(name)})\n`
    + `Pay period: ${escapeHtml(round.period_start)} → ${escapeHtml(round.period_end)}\n\n`
    + `✅ <b>Qualify for ${formatRate(round.rate_high)}/mile</b>\n${list(qualified)}\n\n`
    + `❌ <b>Stay at ${formatRate(round.rate_low)}/mile</b>\n${list(notQualified)}`;

  try {
    await safeSend(() => bot.telegram.sendMessage(BONUS_GROUP_CHAT_ID, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }));
  } catch (err) {
    console.error('[RAISE] Failed to post submission summary:', err.message);
    // Non-fatal: the submission is already saved; admin can review in the panel.
  }
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
  return next;
}

async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const settings = await ra.getRaiseSettings();
    if (!settings || !settings.enabled || !settings.schedule_enabled) return;

    if (!settings.next_run_at) {
      await recomputeNextRun(settings);
      return;
    }
    const now = DateTime.now();
    if (DateTime.fromISO(settings.next_run_at) > now) return;

    const def = defaultPreviousWeek(settings.schedule_timezone);
    // Idempotent: at most one auto-send per pay period across restarts.
    const claimed = await db.claimServiceRun('raise', `weekly:${def.periodEnd}`);
    if (claimed) {
      try {
        await openRoundAndPost({
          periodStart: def.periodStart,
          periodEnd: def.periodEnd,
          requestedBy: 'scheduler',
        });
        console.log(`[RAISE] Weekly round opened for ${def.periodStart}→${def.periodEnd}`);
      } catch (err) {
        await db.unclaimServiceRun('raise', `weekly:${def.periodEnd}`).catch(() => {});
        console.error('[RAISE] Weekly auto-send failed (will retry):', err.message);
      }
    }
    await recomputeNextRun(settings);
  } catch (err) {
    console.error('[RAISE] Scheduler tick error:', err.message);
  } finally {
    tickRunning = false;
  }
}

function startRaiseApprovalService() {
  serviceStopped = false;
  console.log('[RAISE] Driver raise approval service started.');
  setTimeout(() => { if (!serviceStopped) tick(); }, 12 * 1000).unref?.();
  serviceTimer = setInterval(() => { if (!serviceStopped) tick(); }, POLL_MS);
  serviceTimer.unref?.();
}

function stopRaiseApprovalService() {
  serviceStopped = true;
  if (serviceTimer) {
    clearInterval(serviceTimer);
    serviceTimer = null;
  }
}

module.exports = {
  startRaiseApprovalService,
  stopRaiseApprovalService,
  tick,
  fetchCompanyDriverCandidates,
  openRoundAndPost,
  sendNow,
  getPublicRoundInfo,
  getTeamDriversForRound,
  requestOtp,
  verifyOtp,
  submitResponse,
  describeSchedule,
  defaultPreviousWeek,
  recomputeNextRun,
};
