/**
 * Home-Time clarification flow — opening, advancing and completing the
 * conversational date clarification, plus the approval card and policy response.
 *
 * Extracted from homeTimeRequestService (which stays the orchestrator) so both
 * files stay within the per-file line limit. The orchestrator decides WHETHER a
 * clarification should happen; this module carries it out.
 *
 * Every driver-group send here goes through services/homeTimeDriverChannel, so
 * when driver messaging is switched off the whole flow runs silently: dates,
 * status and AI reasoning are still recorded, the approval card still reaches
 * the staff notification group, and staff are alerted through
 * services/homeTimeInternalAlert instead of the driver being asked.
 */
const { DateTime } = require('luxon');
const db = require('../database/db');
const ht = require('../database/homeTime');
const { safeSend } = require('./telegramHtml');
const {
  isPolicyMet,
  buildAskForDatesMessage,
  buildClarificationMessage,
  buildPolicyAckMessage,
  buildPolicyWarningMessage,
  evaluatePolicy,
} = require('./homeTimeRequestConstants');
const { wholeDaysBetween } = require('./homeTimeConstants');
const { statusForMissingFields } = require('./homeTimeDateResolver');
const { inferDriverType } = require('../lib/drivers/driverProfileParse');
const { buildCardText, buildDecisionButtons } = require('./homeTimeRequestCards');
const { generateMessage, generateRequestText } = require('./homeTimeMessageComposer');
const {
  isDriverMessagingEnabled, clarificationChannelFor,
  sendToDriverGroup, reactToDriverMessage, reminderTimeIfAllowed,
} = require('./homeTimeDriverChannel');
const { notifyInternalClarification } = require('./homeTimeInternalAlert');

function todayIsoChicago() {
  return DateTime.now().setZone('America/Chicago').toISODate();
}

function hoursFromNowIso(hours) {
  const h = Math.max(1, Number(hours) || 12);
  return DateTime.now().toUTC().plus({ hours: h }).toISO();
}

/** Which clarification question fits the dates we are still missing? */
function askKindForWindow(window) {
  const missing = window?.missingFields || [];
  if (missing.includes('return_to_road') && !missing.includes('home_start')) return 'ask_return_to_road';
  if (missing.includes('home_start') && !missing.includes('return_to_road')) return 'ask_home_start';
  return 'ask_both';
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
 * Build + post the approval card, then store its message id.
 *
 * Deliberately NOT gated by the driver-messaging switch: the card goes to
 * completed_notify_group_id, a staff chat that is never the driver's own group.
 */
async function postRequestCard(telegram, group, {
  requestId, driverName, unitNumber, driverType, daysOnRoad, policyMet,
  homeFrom, homeTo, returnToRoadDate, settings,
}) {
  const notifyChatId = settings?.completed_notify_group_id ? String(settings.completed_notify_group_id) : null;
  if (!notifyChatId) {
    console.warn(`[HOME-TIME-REQ] Request #${requestId}: completed-notification group not configured — card not posted (the driver group is never used for completed cards).`);
    return null;
  }
  const allowanceWeeks = settings?.road_allowance_weeks || 4;
  const homeAllowanceDays = settings?.home_allowance_days || 4;
  const text = await generateRequestText({
    policyMet, daysOnRoad, allowanceWeeks, homeAllowanceDays, driverName, driverType,
  });
  const cardText = buildCardText({
    driverName, unitNumber, driverType, text, daysOnRoad, policyMet, homeFrom, homeTo, returnToRoadDate,
  });
  const sent = await safeSend(() => telegram.sendMessage(notifyChatId, cardText, {
    parse_mode: 'HTML', disable_web_page_preview: true, ...buildDecisionButtons(requestId),
  }));
  await ht.setHomeTimeRequestMessage(requestId, notifyChatId, sent?.message_id || null);
  return sent;
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

/**
 * Complete a clarification: fill both dates, post/refresh the approval card, and
 * send the policy response replying to the driver's latest message. Shared by the
 * plain-text follow-up path and the orchestrator.
 *
 * Runs unchanged while driver messaging is off — the dates are recorded and the
 * approval card still reaches the staff group; only the policy reply is skipped.
 */
async function completeAndRespond(telegram, group, request, window, message, {
  settings, language,
}) {
  const allowanceWeeks = settings?.road_allowance_weeks || 4;
  const { driverName, unitNumber, driverType } = await resolveDriverLabel(group);
  const { roadStartedAt, daysOnRoad, policyMet } = await resolveRoadMetrics(group, allowanceWeeks, driverType);

  const fulfilled = await ht.fulfillAwaitingHomeTimeRequest(request.id, {
    homeFrom: window.homeStartDate,
    homeTo: window.homeTo,
    returnToRoadDate: window.returnToRoadDate,
    roadStartedAt,
    daysOnRoad,
    policyMet,
    aiReasoning: `Dates completed via conversation: home ${window.homeStartDate} → back ${window.returnToRoadDate}.`,
    lastDriverMessageId: message?.message_id || null,
    language,
  });
  if (!fulfilled) return null; // another reply won the race

  await postRequestCard(telegram, group, {
    requestId: fulfilled.id,
    driverName, unitNumber, driverType, daysOnRoad, policyMet,
    homeFrom: window.homeStartDate, homeTo: window.homeTo,
    returnToRoadDate: window.returnToRoadDate, settings,
  });
  await sendPolicyResponse(telegram, group, fulfilled, {
    window, daysOnRoad, driverType, settings,
    replyToMessageId: message?.message_id || null, language,
  });
  console.log(`[HOME-TIME-REQ] Request #${fulfilled.id} completed (${window.homeStartDate} → ${window.returnToRoadDate}).`);
  return fulfilled;
}

/**
 * Advance an open clarification that gained ONE new date but is still incomplete:
 * persist what we now know, flip to the precise awaiting status, and ask for the
 * remaining date (reply to the driver's message). Reschedules the reminder clock.
 *
 * While driver messaging is off this is the SILENT capture path: the newly
 * supplied date is recorded against the same request, no question is sent, and
 * no second internal alert is raised (the first one already told staff about it).
 */
async function advanceClarification(telegram, group, request, window, message, {
  settings, language,
}) {
  const missing = window.missingFields;
  const nextStatus = statusForMissingFields(missing);
  const firstHours = settings?.reminder_first_hours || 12;
  await ht.updateHomeTimeRequestFields(request.id, {
    homeFrom: window.homeStartDate,
    homeTo: window.homeTo,
    returnToRoadDate: window.returnToRoadDate,
    missingFields: missing.join(','),
    status: nextStatus,
    lastDriverMessageId: message?.message_id || null,
    language: language || undefined,
    reminderCount: 0,
    nextReminderAt: reminderTimeIfAllowed(settings, hoursFromNowIso(firstHours)),
  });
  const askKind = missing.includes('return_to_road') ? 'ask_return_to_road' : 'ask_home_start';
  const fallbackKind = missing.includes('return_to_road') ? 'return_to_road' : 'home_start';
  if (isDriverMessagingEnabled(settings)) {
    const msg = await generateMessage({
      kind: askKind, language, fallback: buildClarificationMessage(fallbackKind),
    });
    await sendToDriverGroup(telegram, group.telegram_group_id, msg, {
      replyToMessageId: request.root_message_id || message?.message_id || null,
      settings,
      reason: 'follow-up date question',
    });
  }
  console.log(`[HOME-TIME-REQ] Request #${request.id} advanced → ${nextStatus} (missing ${missing.join(',')}).`);
}

/**
 * Create a brand-new clarification flow (rep tag without dates, unplanned home
 * arrival, or a driver-initiated request). Stores the reply-threading root, asks
 * for the missing piece(s), and schedules the first reminder.
 *
 * When driver messaging is off nothing is asked and nothing is scheduled; the
 * request is stamped clarification_channel='internal' and staff are alerted once.
 *
 * @param {object} p.window   resolved (possibly partial) date window
 * @param {string} p.askKind  one of ask_both | ask_return_to_road | ask_home_start | ask_unplanned_return
 * @param {boolean} p.isUnplanned  driver went home with no earlier request
 */
async function createClarification(telegram, group, message, {
  window, askKind, isUnplanned = false, settings, language, verdict,
}) {
  const allowanceWeeks = settings?.road_allowance_weeks || 4;
  const { driverName, unitNumber, driverType } = await resolveDriverLabel(group);
  const { roadStartedAt, daysOnRoad, policyMet } = await resolveRoadMetrics(group, allowanceWeeks, driverType);
  const missing = window.missingFields.length ? window.missingFields : ['home_start', 'return_to_road'];
  const status = statusForMissingFields(missing);
  const fromUser = message?.from || {};
  const firstHours = settings?.reminder_first_hours || 12;
  const driverMessaging = isDriverMessagingEnabled(settings);

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
    homeFrom: window.homeStartDate,
    homeTo: window.homeTo,
    returnToRoadDate: window.returnToRoadDate,
    status,
    source: 'telegram',
    isUnplannedArrival: isUnplanned,
    detectedIntent: verdict?.intent || null,
    aiConfidence: verdict?.confidence ?? null,
    language: language || (verdict?.language || null),
    missingFields: missing.join(','),
    rootChatId: group.telegram_group_id,
    rootMessageId: message?.message_id || null,
    lastDriverMessageId: message?.message_id || null,
    // No reminder is scheduled while driver messaging is off, so nothing can
    // later leak into the driver group and nothing accumulates to replay.
    nextReminderAt: reminderTimeIfAllowed(settings, hoursFromNowIso(firstHours)),
    aiReasoning: verdict?.reason || null,
    clarificationChannel: clarificationChannelFor(settings),
  });

  if (!driverMessaging) {
    await notifyInternalClarification(telegram, {
      request, group, message, verdict, settings, window: { ...window, missingFields: missing },
    });
    console.log(`[HOME-TIME-REQ] Request #${request.id} opened SILENTLY (${status}, unplanned=${isUnplanned}) — staff alerted, driver not messaged.`);
    return request;
  }

  const fallback = askKind === 'ask_unplanned_return'
    ? buildClarificationMessage('unplanned_return')
    : (askKind === 'ask_return_to_road' ? buildClarificationMessage('return_to_road')
      : (askKind === 'ask_home_start' ? buildClarificationMessage('home_start') : buildAskForDatesMessage()));
  const msg = await generateMessage({ kind: askKind, language, fallback });
  const sent = await sendToDriverGroup(telegram, group.telegram_group_id, msg, {
    replyToMessageId: message?.message_id || null, settings, reason: 'date clarification',
  });
  await ht.setHomeTimeClarificationMessage(request.id, {
    clarificationChatId: group.telegram_group_id,
    clarificationMessageId: sent?.message_id || null,
  });
  console.log(`[HOME-TIME-REQ] Request #${request.id} clarification opened (${status}, unplanned=${isUnplanned}).`);
  return request;
}

module.exports = {
  todayIsoChicago,
  hoursFromNowIso,
  askKindForWindow,
  resolveDriverLabel,
  resolveRoadMetrics,
  postRequestCard,
  sendPolicyResponse,
  completeAndRespond,
  advanceClarification,
  createClarification,
};
