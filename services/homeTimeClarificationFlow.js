/**
 * Home-Time request delivery — recording a request, posting the manager card,
 * and the one reply the driver gets.
 *
 * WHAT THIS FILE USED TO BE. A clarification flow: open a conversation about
 * planned home dates, ask, remind, advance, complete. That is gone — see the
 * block above `recordAndPostRequest` for why, and for what happens to the rows
 * it left behind. The file name is kept because several modules import it and a
 * rename buys nothing.
 *
 * WHAT IT IS NOW. A driver's request is recorded with whatever dates were
 * actually said, the three managers are told, the driver gets one reply, and
 * the request is finished.
 *
 * Every driver-group send here goes through services/homeTimeDriverChannel, so
 * when driver messaging is switched off the request is still recorded and the
 * manager card still reaches the staff notification group — only the reply to
 * the driver is skipped.
 */
const { DateTime } = require('luxon');
const db = require('../database/db');
const ht = require('../database/homeTime');
const { safeSend } = require('./telegramHtml');
const {
  isPolicyMet,
  buildPolicyAckMessage,
  buildPolicyWarningMessage,
  evaluatePolicy,
} = require('./homeTimeRequestConstants');
const { wholeDaysBetween } = require('./homeTimeConstants');
const { inferDriverType } = require('../lib/drivers/driverProfileParse');
const { noticeHomeTimeRequested } = require('./homeTime/managerNotices');
const { generateMessage, generateRequestText } = require('./homeTimeMessageComposer');
const {
  isDriverMessagingEnabled, sendToDriverGroup, reactToDriverMessage,
} = require('./homeTimeDriverChannel');

function todayIsoChicago() {
  return DateTime.now().setZone('America/Chicago').toISODate();
}

async function resolveDriverLabel(group) {
  try {
    const profile = await db.getDriverProfileByGroupId(group.id);
    const name = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ').trim();
    return {
      driverName: name || group.group_name || `Group ${group.id}`,
      unitNumber: profile?.unit_number || null,
      driverType: profile?.driver_type || inferDriverType(group.group_name || ''),
      profile: profile || null,
    };
  } catch (_) {
    return {
      driverName: group.group_name || `Group ${group.id}`,
      unitNumber: null,
      driverType: inferDriverType(group.group_name || ''),
      profile: null,
    };
  }
}

/** Current road metrics for a driver group (road start + whole days on road). */
async function resolveRoadMetrics(group, allowanceWeeks, driverType) {
  const homeStatus = await ht.getDriverHomeStatus(group.id);
  const nowIso = DateTime.now().toUTC().toISO();
  let roadStartedAt = null;
  let daysOnRoad = null;
  // If already home, "days on road" is the leg that just ended (state_since was set
  // by the previous road leg). We fall back to the completed leg's history where
  // possible; otherwise leave null and let the humans judge.
  if (homeStatus && homeStatus.state === 'road') {
    roadStartedAt = homeStatus.state_since;
    daysOnRoad = wholeDaysBetween(homeStatus.state_since, nowIso);
  } else if (homeStatus && homeStatus.state === 'home') {
    const openStay = await ht.getOpenHomeStay(group.id).catch(() => null);
    if (openStay) {
      roadStartedAt = openStay.road_started_at;
      daysOnRoad = openStay.days_on_road != null ? Number(openStay.days_on_road) : null;
    }
  }
  return { roadStartedAt, daysOnRoad, policyMet: isPolicyMet(daysOnRoad, allowanceWeeks, driverType) };
}

/**
 * Tell the three managers that a driver ASKED for home time.
 *
 * This replaced the approval card. It is one short, buttonless notice, recorded
 * under a key derived from the request id, so the same request can be completed
 * twice by two racing messages and the managers are still told once.
 *
 * Deliberately NOT gated by the driver-messaging switch: it goes to
 * completed_notify_group_id, a staff chat that is never the driver's own group.
 */
async function postRequestCard(telegram, group, {
  requestId, driverName, unitNumber, driverType, daysOnRoad, policyMet,
  homeFrom, homeTo, returnToRoadDate, settings,
}) {
  const result = await noticeHomeTimeRequested(telegram, {
    requestId, groupId: group?.id || null,
    driverName, unitNumber, daysOnRoad,
    homeFrom, returnToRoadDate: returnToRoadDate || homeTo,
    settings,
  });
  if (result.notice?.telegramMessageId) {
    await ht.setHomeTimeRequestMessage(
      requestId, result.notice.chatId, result.notice.telegramMessageId
    ).catch(() => {});
  }
  if (!result.recorded) {
    console.log(`[HOME-TIME-REQ] Request #${requestId}: managers already told (${result.reason || 'duplicate'}).`);
  }
  return result.notice;
}

/**
 * Send the policy response once complete dates are known: a 👍 + short
 * acknowledgment when the policy is followed (or N/A), or a firm-but-friendly
 * reminder when it is not. Never claims approval. Idempotent via acknowledged_at.
 *
 * Both outputs are driver-group messages, so the whole step is skipped while
 * driver messaging is off — before the acknowledged_at claim, so the claim is
 * not burned on a response nobody received.
 */
async function sendPolicyResponse(telegram, group, request, {
  window, daysOnRoad, driverType, settings, replyToMessageId, language,
}) {
  if (!isDriverMessagingEnabled(settings)) {
    console.log(`[HOME-TIME-REQ] Request #${request.id}: policy response suppressed (driver messaging disabled).`);
    return;
  }
  const allowanceWeeks = settings?.road_allowance_weeks || 4;
  const homeAllowanceDays = settings?.home_allowance_days || 4;
  const hasApprovedException = request.status === 'approved';
  const policy = evaluatePolicy({
    daysOnRoad,
    homeDays: window.homeDays,
    roadAllowanceWeeks: allowanceWeeks,
    homeAllowanceDays,
    driverType,
    hasApprovedException,
  });
  if (policy.result === 'unknown') return; // cannot judge — the card asks the humans

  // Only the first responder sends the ack/warning.
  const claimed = await ht.markHomeTimeAcknowledged(request.id, policy.result);
  if (!claimed) return;

  if (policy.compliant) {
    await reactToDriverMessage(telegram, group.telegram_group_id, replyToMessageId, { settings });
    const msg = await generateMessage({
      kind: 'policy_ack', language, fallback: buildPolicyAckMessage(),
    });
    await sendToDriverGroup(telegram, group.telegram_group_id, msg, {
      replyToMessageId, settings, reason: 'policy acknowledgment',
    });
  } else {
    const msg = await generateMessage({
      kind: 'policy_warning',
      language,
      facts: { allowanceWeeks, homeAllowanceDays },
      fallback: buildPolicyWarningMessage(allowanceWeeks, homeAllowanceDays),
    });
    await sendToDriverGroup(telegram, group.telegram_group_id, msg, {
      replyToMessageId, settings, reason: 'policy warning',
    });
  }
}

/*
 * completeAndRespond, advanceClarification and createClarification lived here.
 *
 * Together they were the clarification conversation: open a request in an
 * `awaiting_*` status when the driver had not spelled out both dates, ask for
 * the missing piece, schedule a reminder, accept a later reply, ask again for
 * whatever was still missing, and finally fill the window. When driver
 * messaging was off the same three functions ran silently and told staff
 * instead, through services/homeTimeInternalAlert.
 *
 * All of it chased two PLANNED dates. Those dates are a guess about next week,
 * and they were never what Home In and Home Out are recorded from — those come
 * from the Dispatcher Board and the driver's own status, in
 * services/homeTime/boardPresenceWatch.js. So the conversation cost the driver
 * messages, staff a queue of alerts, and produced a number nothing reads.
 *
 * `recordAndPostRequest` below is what replaced all three: record what the
 * driver said, tell the three managers, reply once, stop. Nothing is asked and
 * nothing is scheduled, so there is no conversation to advance or complete.
 *
 * Deleted rather than left unreachable. Rows already sitting in `awaiting_*`
 * keep their status and their dates; the housekeeping sweep closes them once
 * their window passes, and nothing opens another.
 */

/**
 * Record a home-time request, tell the staff group, and stop.
 *
 * THIS REPLACES THE CLARIFICATION LOOP. A request used to open in an
 * `awaiting_*` status whenever the driver had not spelled out both dates, and
 * Wenze then asked them, and asked again on a reminder clock, and eventually
 * gave up. That whole apparatus existed to collect two PLANNED dates — a guess
 * about the future, made by somebody who is about to drive home — and the
 * planned dates were never what Home In and Home Out are recorded from anyway.
 * Those come from the Dispatcher Board and the driver's own status, in
 * services/homeTime/boardPresenceWatch.js. So the loop cost the driver messages
 * and staff attention to produce a number nothing reads.
 *
 * WHAT A REQUEST IS NOW. The driver asked; that is the whole fact. It is
 * recorded with whatever dates were actually said (any of them may be null),
 * the three managers are told, the driver gets one reply, and the request is
 * finished — `recorded`, with no reminder scheduled and nothing awaiting
 * anybody.
 *
 * NOTHING HISTORICAL IS DISTURBED. Rows already sitting in `awaiting_*` keep
 * their status and their dates; they simply stop being chased, and the cleanup
 * sweep closes them once their window passes.
 */
async function recordAndPostRequest(telegram, group, message, {
  window, settings, language, verdict, isUnplanned = false,
}) {
  const allowanceWeeks = settings?.road_allowance_weeks || 4;
  const { driverName, unitNumber, driverType } = await resolveDriverLabel(group);
  const { roadStartedAt, daysOnRoad, policyMet } = await resolveRoadMetrics(group, allowanceWeeks, driverType);
  const fromUser = message?.from || {};
  const known = window || {};

  const request = await ht.insertHomeTimeRequest({
    groupId: group.id,
    telegramGroupId: group.telegram_group_id,
    driverName,
    unitNumber,
    requestedByUserId: fromUser.id || null,
    requestedByUsername: fromUser.username || null,
    roadStartedAt,
    daysOnRoad,
    policyMet,
    // Whatever the driver actually said. A missing date stays missing rather
    // than becoming a question.
    homeFrom: known.homeStartDate || null,
    homeTo: known.homeTo || null,
    returnToRoadDate: known.returnToRoadDate || null,
    // RECORDED, never `awaiting_*`: nothing is waiting for anybody.
    status: 'recorded',
    source: 'telegram',
    isUnplannedArrival: isUnplanned,
    detectedIntent: verdict?.intent || null,
    aiConfidence: verdict?.confidence ?? null,
    language: language || (verdict?.language || null),
    rootChatId: group.telegram_group_id,
    rootMessageId: message?.message_id || null,
    lastDriverMessageId: message?.message_id || null,
    // NO REMINDER, EVER. There is nothing to remind anybody about.
    nextReminderAt: null,
    aiReasoning: verdict?.reason || null,
  });

  await postRequestCard(telegram, group, {
    requestId: request.id,
    driverName, unitNumber, driverType, daysOnRoad, policyMet,
    homeFrom: known.homeStartDate || null,
    homeTo: known.homeTo || null,
    returnToRoadDate: known.returnToRoadDate || null,
    settings,
  });
  // One reply to the driver, not a question. Suppressed by the same setting
  // that governs every other message into a driver group.
  await sendPolicyResponse(telegram, group, request, {
    window: known, daysOnRoad, driverType, settings,
    replyToMessageId: message?.message_id || null, language,
  }).catch((err) => {
    console.warn('[HOME-TIME-REQ] Could not reply to the driver:', err.message);
  });
  console.log(`[HOME-TIME-REQ] Request #${request.id} recorded and posted; nothing is awaited.`);
  return request;
}

module.exports = {
  recordAndPostRequest,
  todayIsoChicago,
  resolveDriverLabel,
  resolveRoadMetrics,
  postRequestCard,
  sendPolicyResponse,
};
