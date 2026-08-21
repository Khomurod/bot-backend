/**
 * The dispatcher-facing half of the Driver Raise Review: everything reachable
 * from the tokenized public link (`/raise/:token`, `/api/raise/:token/*`).
 *
 * Round info → OTP request → OTP verify → submit. Drivers never open this flow;
 * a DISPATCHER does, for their own dispatch team.
 *
 * Guards that must not weaken: the link has to be open and unexpired
 * (`assertRoundUsable`), the contact has to be OTP-verified, every assigned
 * driver has to be marked, and one team gets ONE submission per round — the
 * final atomic guard is the DB's UNIQUE (round_id, team_id) via
 * `saveSubmissionWithPicks` returning null on conflict.
 *
 * The submitted result is posted to the accounting group AFTER the response is
 * committed (see ./notifications), so a notification problem can never lose or
 * duplicate a dispatcher's answer.
 */
const { DateTime } = require('luxon');
const ra = require('../../database/raiseApproval');
const otp = require('../otpService');
const { decryptText } = require('../facebookCrypto');
const { serviceError } = require('./errors');
const { postSubmissionResult } = require('./notifications');

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RATE_WINDOW_MINUTES = 10;
const OTP_RATE_MAX = 3;

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
  const submittedTeamIds = new Set(await ra.listSubmittedTeamIds(round.id));
  return {
    period_start: round.period_start,
    period_end: round.period_end,
    rate_low: round.rate_low,
    rate_high: round.rate_high,
    otp_channel: settings.otp_channel,
    contact_type: otp.contactTypeForChannel(settings.otp_channel),
    teams: teams.map((t) => ({ id: t.id, name: t.name, submitted: submittedTeamIds.has(t.id) })),
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
  if (await ra.getSubmissionForTeam(round.id, teamId)) {
    throw serviceError('ALREADY_SUBMITTED', 'This team has already submitted a response for this pay period.', 409);
  }

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
  if (await ra.getSubmissionForTeam(round.id, teamId)) {
    throw serviceError('ALREADY_SUBMITTED', 'This team has already submitted a response for this pay period.', 409);
  }

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
  // Atomic guard against a race with another concurrent submit for the same
  // team/round: the DB insert is a no-op on conflict, so a null result here
  // means another request already claimed this team's one response.
  if (!submission) {
    throw serviceError('ALREADY_SUBMITTED', 'This team has already submitted a response for this pay period.', 409);
  }

  // The submission is already committed. Posting the result to accounting is a
  // best-effort notification AFTER that fact — it can never throw, never retry
  // the save, and never re-post. Its outcome is reported, not enforced.
  const notification = await postSubmissionResult({
    round, team, dispatcherName: name, picks: cleanPicks, submissionId: submission.id,
  });
  return {
    submitted: true,
    submission_id: submission.id,
    results_posted: notification.posted,
    results_notice: notification.reason,
  };
}

module.exports = {
  resolveGmailCredsFromSettings,
  assertRoundUsable,
  getPublicRoundInfo,
  getTeamDriversForRound,
  requestOtp,
  verifyOtp,
  submitResponse,
};
