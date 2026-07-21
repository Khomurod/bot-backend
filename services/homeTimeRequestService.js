/**
 * Home-Time Request & conversational clarification service.
 *
 * Turns a driver group's messages into a smart home-time workflow:
 *   - AI understands intent (actual home/road status vs. a request vs. a plan) and
 *     extracts partial or complete dates (homeTimeIntentService);
 *   - the bot replies DIRECTLY to the driver's message and follows later plain-text
 *     answers even without Telegram's reply feature;
 *   - it asks ONLY for the missing date (never turns one date into both ends);
 *   - it applies the company policy (≥4 weeks road / ≤4 days home) with a firm but
 *     friendly reminder, or a 👍 + acknowledgment when the policy is followed;
 *   - it preserves the existing human Approve / Do Not Approve card.
 *
 * The `telegram` instance is always passed in (never required) so this module
 * stays free of a require cycle with bot.js.
 */
const { DateTime } = require('luxon');
const db = require('../database/db');
const ht = require('../database/homeTime');
const config = require('../config/config');
const { safeSend } = require('./telegramHtml');
const recentBuffer = require('./recentMessageBuffer');
const { callGeminiJson, callGeminiText } = require('./geminiClient');
const {
  HOME_TIME_APPROVER_MENTIONS,
  weeksFromDays,
  isPolicyMet,
  homeTimePolicyApplies,
  hasHomeTimeSignal,
  buildHomeTimeClassificationPrompt,
  buildHomeTimeDateReplyPrompt,
  buildAskForDatesMessage,
  buildClarificationMessage,
  buildPolicyAckMessage,
  buildPolicyWarningMessage,
  evaluatePolicy,
  looksLikeDateReply,
  parseHomeTimeWindowText,
  isReasonableHomeWindow,
} = require('./homeTimeRequestConstants');
const { wholeDaysBetween } = require('./homeTimeConstants');
const {
  normalizeHomeTimeWindow, statusForMissingFields, isReasonableWindow,
  isUsableKnownReturnDate, resolveRequestReturnDate,
} = require('./homeTimeDateResolver');
const { classifyHomeTimeMessage, isHomeTimeCandidate } = require('./homeTimeIntentService');
const homeTimeStatus = require('./homeTimeService');
const { inferDriverType } = require('./driverProfileParse');
const {
  CALLBACK_PREFIX, escapeHtml, buildCardText, buildDecisionButtons, buildDecidedCardText,
} = require('./homeTimeRequestCards');

const AI_STATUS_CONFIDENCE_MIN = 70;

function todayIsoChicago() {
  return DateTime.now().setZone('America/Chicago').toISODate();
}

function hoursFromNowIso(hours) {
  const h = Math.max(1, Number(hours) || 12);
  return DateTime.now().toUTC().plus({ hours: h }).toISO();
}

/** Timestamp of a Telegram message (seconds → ISO), or now. */
function messageIso(message) {
  const secs = Number(message?.date);
  if (Number.isFinite(secs) && secs > 0) return DateTime.fromSeconds(secs).toUTC().toISO();
  return DateTime.now().toUTC().toISO();
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

/** null when we cannot tell; true/false when the sender matches the group's driver. */
async function senderIsDriverOf(group, message, profile) {
  const fromId = message?.from?.id;
  const fromUser = message?.from?.username;
  const p = profile !== undefined ? profile : await db.getDriverProfileByGroupId(group.id).catch(() => null);
  if (!p) return null;
  if (p.telegram_user_id && fromId != null) return String(p.telegram_user_id) === String(fromId);
  if (p.telegram_username && fromUser) {
    return String(p.telegram_username).replace(/^@/, '').toLowerCase() === String(fromUser).toLowerCase();
  }
  return null;
}

// ── Telegram reply / reaction helpers ──

/** React 👍 to a message. Non-fatal (older API / not an admin). */
async function reactThumbsUp(telegram, chatId, messageId) {
  if (!telegram || !chatId || !messageId) return;
  try {
    const reaction = [{ type: 'emoji', emoji: '👍' }];
    if (typeof telegram.setMessageReaction === 'function') {
      await telegram.setMessageReaction(chatId, messageId, reaction);
    } else if (typeof telegram.callApi === 'function') {
      await telegram.callApi('setMessageReaction', { chat_id: chatId, message_id: messageId, reaction });
    }
  } catch (err) {
    console.warn('[HOME-TIME-REQ] Could not set reaction (non-fatal):', err.message);
  }
}

/**
 * Send a message, replying to `replyToMessageId` when given. Uses Telegram's
 * "allow sending without reply" so a deleted root message never drops the reply.
 */
async function sendReply(telegram, chatId, text, { replyToMessageId = null, extra = {} } = {}) {
  const options = { disable_web_page_preview: true, ...extra };
  if (replyToMessageId) {
    options.reply_to_message_id = Number(replyToMessageId);
    options.allow_sending_without_reply = true;
  }
  return safeSend(() => telegram.sendMessage(chatId, text, options));
}

// ── AI natural-language message generation (deterministic fallback) ──

function conversationalPrompt(kind, language, facts = {}) {
  const langLine = language && !['en', 'english'].includes(String(language).toLowerCase())
    ? `Write in the driver's language (${language}); keep it natural and simple.`
    : "Match the driver's language when obvious; otherwise use English.";
  const intro = 'You are a friendly but firm dispatch assistant for a US trucking company. '
    + 'Write ONE short message (1-2 sentences, plain text, no markdown). You may address the driver warmly (e.g. "brother").';
  const asks = {
    ask_return_to_road: 'Ask the driver what date they plan to get back on the road after their home time.',
    ask_home_start: 'Ask the driver what date they plan to arrive home.',
    ask_both: 'Ask the driver which dates they want for home time: the day they will arrive home and the day they will be back on the road.',
    ask_unplanned_return: 'Warmly welcome the driver home, then ask what date they plan to get back on the road after their home time.',
    reminder_return: 'Politely but firmly remind the driver that we still need the date they will be back on the road after home time; say it is important for us to know.',
    reminder_home_start: 'Politely but firmly remind the driver that we still need the date they plan to arrive home; say it is important for us to know.',
    reminder_both: 'Politely but firmly remind the driver that we still need their home-time dates (arrive home and back on the road); say it is important for us to know.',
    policy_ack: 'Acknowledge that you noted their home-time dates and thank them. Do NOT say the request is approved.',
    policy_warning: `Firmly but kindly remind the driver of the agreement: at least ${facts.allowanceWeeks || 4} weeks on the road and up to ${facts.homeAllowanceDays || 4} days at home. One or two sentences, no long explanation, no aggressive wording. Do NOT say the request is approved or denied.`,
  };
  return `${intro} ${asks[kind] || asks.ask_both} ${langLine}`;
}

async function generateMessage({ kind, language, facts, fallback }) {
  try {
    const { text } = await callGeminiText({
      userText: conversationalPrompt(kind, language, facts),
      maxOutputTokens: 120,
    });
    const clean = String(text || '').trim();
    if (clean) return clean;
  } catch (err) {
    console.warn(`[HOME-TIME-REQ] AI message (${kind}) failed, using fallback:`, err.message);
  }
  return fallback;
}

// ── Legacy approver-tag classifier (kept for the @-mention request path) ──

/**
 * Ask the AI whether the recent conversation is a home-time request (used by the
 * approver-mention path). Unchanged JSON contract; see homeTimeIntentService for
 * the newer unified classifier used by the conversational message pipeline.
 */
async function classifyHomeTimeRequest(input) {
  const { transcript, triggerText, todayIso } = typeof input === 'string'
    ? { transcript: input, triggerText: '', todayIso: null }
    : (input || {});
  const haystack = `${triggerText || ''}\n${transcript || ''}`;
  const keywordSignal = hasHomeTimeSignal(haystack);
  const today = todayIso || todayIsoChicago();

  const prompt = buildHomeTimeClassificationPrompt({
    transcript, triggerText, approvers: HOME_TIME_APPROVER_MENTIONS, todayLabel: today,
  });
  try {
    const { parsed } = await callGeminiJson({
      userText: prompt,
      maxOutputTokens: 250,
      validateParsed: (p) => typeof p?.is_home_time_request === 'boolean',
    });
    const confidence = String(parsed.confidence || '').toLowerCase();
    let isRequest = Boolean(parsed.is_home_time_request);
    let reason = String(parsed.reason || '').slice(0, 300);

    if (isRequest && confidence === 'low' && !keywordSignal) {
      isRequest = false;
      reason = `Low-confidence AI guess with no home-time wording — skipped. ${reason}`.trim();
    }

    let homeFrom = null;
    let homeTo = null;
    if (isRequest && parsed.dates_specified && parsed.home_from && parsed.home_to
      && isReasonableHomeWindow(parsed.home_from, parsed.home_to, today)) {
      homeFrom = String(parsed.home_from);
      homeTo = String(parsed.home_to);
    }

    return {
      isRequest, reason, confidence: confidence || null,
      datesSpecified: Boolean(homeFrom && homeTo), homeFrom, homeTo, aiUsed: true,
    };
  } catch (err) {
    console.warn('[HOME-TIME-REQ] AI classification failed, using keyword heuristic:', err.message);
    const window = keywordSignal ? parseHomeTimeWindowText(haystack, today) : null;
    const valid = window && isReasonableHomeWindow(window.homeFrom, window.homeTo, today);
    return {
      isRequest: keywordSignal,
      reason: keywordSignal
        ? 'AI unavailable — home-time wording detected, surfaced for human review.'
        : 'AI unavailable — no home-time wording detected, not surfaced.',
      confidence: null,
      datesSpecified: Boolean(valid),
      homeFrom: valid ? window.homeFrom : null,
      homeTo: valid ? window.homeTo : null,
      aiUsed: false,
    };
  }
}

/**
 * AI-written note for the approval card. Deterministic fallback keeps the exact
 * policy meaning when the AI is unavailable.
 */
async function generateRequestText({
  policyMet, daysOnRoad, allowanceWeeks, homeAllowanceDays, driverName, driverType,
}) {
  const weeks = daysOnRoad == null ? null : weeksFromDays(daysOnRoad);
  const policyApplies = homeTimePolicyApplies(driverType);

  let situation;
  if (!policyApplies) {
    situation = `The driver is an owner operator, so the company 4-week home-time policy and extra-week bonus do not apply. `
      + `Say you logged the request for tracking, and that a human still needs to approve the dates.`;
  } else if (policyMet === true) {
    situation = `The driver HAS been on the road about ${weeks} weeks (${daysOnRoad} days), which is at least `
      + `the required ${allowanceWeeks} weeks. Say you believe they are good to take ${homeAllowanceDays} days home, `
      + `but you are only a bot so a human must confirm.`;
  } else if (policyMet === false) {
    situation = `The driver has only been on the road about ${weeks} weeks (${daysOnRoad} days), which is LESS than `
      + `the agreed ${allowanceWeeks} weeks. Politely note that per the agreement they should be on the road at least `
      + `${allowanceWeeks} weeks, that you cannot decide on a human's behalf, and that the humans should decide.`;
  } else {
    situation = `You could not confirm how long the driver has been on the road, so you cannot judge the `
      + `${allowanceWeeks}-week policy. Ask the humans to decide.`;
  }

  const prompt = `You are a friendly dispatch assistant bot for a trucking company. Write ONE short, warm message `
    + `(2-3 sentences, plain text, no markdown) responding to a home-time request. ${situation} `
    + `Make clear you are a bot and a human must approve.`;

  try {
    const { text } = await callGeminiText({ userText: prompt, maxOutputTokens: 250 });
    const clean = String(text || '').trim();
    if (clean) return clean;
  } catch (err) {
    console.warn('[HOME-TIME-REQ] AI text generation failed, using fallback:', err.message);
  }

  if (!policyApplies) {
    return `I logged this owner operator home-time request for tracking. The company 4-week rule does not apply here, `
      + `but I'm still a bot, so a human needs to approve the dates.`;
  }
  if (policyMet === true) {
    return `I see it's been about ${weeks} weeks (${daysOnRoad} days) since you started driving, so I believe `
      + `you're good to have home time for ${homeAllowanceDays} days. But I'm still a bot, so I need a human's permission.`;
  }
  if (policyMet === false) {
    return `I see it hasn't been ${allowanceWeeks} weeks since you started driving - only about ${weeks} weeks `
      + `(${daysOnRoad} days). Per our agreement you should be on the road for at least ${allowanceWeeks} weeks. `
      + `I'm just a bot and can't decide on a human's behalf, so let the humans decide.`;
  }
  return `I couldn't confirm how long you've been on the road, so I can't check the ${allowanceWeeks}-week policy. `
    + `I'm just a bot, so let the humans decide.`;
}

/** Build + post the approval card, then store its message id. Dates are strings. */
async function postRequestCard(telegram, group, {
  requestId, driverName, unitNumber, driverType, daysOnRoad, policyMet,
  homeFrom, homeTo, returnToRoadDate, settings,
}) {
  const notifyChatId = settings?.completed_notify_group_id ? String(settings.completed_notify_group_id) : null;
  if (!notifyChatId) { console.warn(`[HOME-TIME-REQ] Request #${requestId}: completed-notification group not configured — card not posted (the driver group is never used for completed cards).`); return null; }
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

// ── Shared clarification helpers ──

/**
 * Send the policy response once complete dates are known: a 👍 + short
 * acknowledgment when the policy is followed (or N/A), or a firm-but-friendly
 * reminder when it is not. Never claims approval. Idempotent via acknowledged_at.
 */
async function sendPolicyResponse(telegram, group, request, {
  window, daysOnRoad, driverType, settings, replyToMessageId, language,
}) {
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
    await reactThumbsUp(telegram, group.telegram_group_id, replyToMessageId);
    const msg = await generateMessage({
      kind: 'policy_ack', language, fallback: buildPolicyAckMessage(),
    });
    await sendReply(telegram, group.telegram_group_id, msg, { replyToMessageId });
  } else {
    const msg = await generateMessage({
      kind: 'policy_warning',
      language,
      facts: { allowanceWeeks, homeAllowanceDays },
      fallback: buildPolicyWarningMessage(allowanceWeeks, homeAllowanceDays),
    });
    await sendReply(telegram, group.telegram_group_id, msg, { replyToMessageId });
  }
}

/**
 * Complete a clarification: fill both dates, post/refresh the approval card, and
 * send the policy response replying to the driver's latest message. Shared by the
 * plain-text follow-up path and the orchestrator.
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
    nextReminderAt: hoursFromNowIso(firstHours),
  });
  const askKind = missing.includes('return_to_road') ? 'ask_return_to_road' : 'ask_home_start';
  const fallbackKind = missing.includes('return_to_road') ? 'return_to_road' : 'home_start';
  const msg = await generateMessage({
    kind: askKind, language, fallback: buildClarificationMessage(fallbackKind),
  });
  await sendReply(telegram, group.telegram_group_id, msg, {
    replyToMessageId: request.root_message_id || message?.message_id || null,
  });
  console.log(`[HOME-TIME-REQ] Request #${request.id} advanced → ${nextStatus} (missing ${missing.join(',')}).`);
}

/**
 * Create a brand-new clarification flow (rep tag without dates, unplanned home
 * arrival, or a driver-initiated request). Stores the reply-threading root, asks
 * for the missing piece(s), and schedules the first reminder.
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
    nextReminderAt: hoursFromNowIso(firstHours),
    aiReasoning: verdict?.reason || null,
  });

  const fallback = askKind === 'ask_unplanned_return'
    ? buildClarificationMessage('unplanned_return')
    : (askKind === 'ask_return_to_road' ? buildClarificationMessage('return_to_road')
      : (askKind === 'ask_home_start' ? buildClarificationMessage('home_start') : buildAskForDatesMessage()));
  const msg = await generateMessage({ kind: askKind, language, fallback });
  const sent = await sendReply(telegram, group.telegram_group_id, msg, {
    replyToMessageId: message?.message_id || null,
  });
  await ht.setHomeTimeClarificationMessage(request.id, {
    clarificationChatId: group.telegram_group_id,
    clarificationMessageId: sent?.message_id || null,
  });
  console.log(`[HOME-TIME-REQ] Request #${request.id} clarification opened (${status}, unplanned=${isUnplanned}).`);
  return request;
}

// ── Entry points ──

/**
 * Approver-tag path. Safe to call on any approver-tag message in a driver group.
 * Never throws. Posts the card immediately when dates are known, otherwise opens a
 * clarification and waits for the driver's reply.
 */
async function handleApproverMention(telegram, group, message) {
  try {
    if (!group || group.group_type !== 'driver') return;

    const existing = await ht.getOpenHomeTimeRequestForGroup(group.id);
    if (existing) return; // one active flow per driver

    // Already home? A "send them home" card makes no sense — the unplanned-arrival
    // flow (triggered by the Status: Home message) handles that case instead.
    const homeStatus = await ht.getDriverHomeStatus(group.id);
    if (homeStatus && homeStatus.state === 'home') {
      console.log(`[HOME-TIME-REQ] ${group.group_name || `Group ${group.id}`} is already home — no request card.`);
      return;
    }

    const triggerText = message?.text || message?.caption || '';
    const transcript = recentBuffer.renderTranscript(group.telegram_group_id);
    const todayIso = todayIsoChicago();
    const verdict = await classifyHomeTimeRequest({ transcript, triggerText, todayIso });
    if (!verdict.isRequest) return;

    const settings = await ht.getHomeTimeSettings();
    const window = normalizeHomeTimeWindow({
      homeStart: verdict.datesSpecified ? verdict.homeFrom : null,
      lastDayHome: verdict.datesSpecified ? verdict.homeTo : null,
    });
    const language = null;

    if (window.complete) {
      const allowanceWeeks = settings?.road_allowance_weeks || 4;
      const { driverName, unitNumber, driverType } = await resolveDriverLabel(group);
      const { roadStartedAt, daysOnRoad, policyMet } = await resolveRoadMetrics(group, allowanceWeeks, driverType);
      const fromUser = message?.from || {};
      const request = await ht.insertHomeTimeRequest({
        groupId: group.id,
        telegramGroupId: group.telegram_group_id,
        driverName, unitNumber,
        requestedByUserId: fromUser.id || null,
        requestedByUsername: fromUser.username || null,
        roadStartedAt, daysOnRoad, policyMet,
        homeFrom: window.homeStartDate, homeTo: window.homeTo, returnToRoadDate: window.returnToRoadDate,
        status: 'pending', source: 'telegram',
        detectedIntent: 'home_time_request',
        aiConfidence: verdict.confidence === 'high' ? 90 : (verdict.confidence === 'medium' ? 60 : null),
        rootChatId: group.telegram_group_id,
        rootMessageId: message?.message_id || null,
        aiReasoning: verdict.confidence ? `[confidence: ${verdict.confidence}] ${verdict.reason || ''}`.trim() : (verdict.reason || null),
      });
      await postRequestCard(telegram, group, {
        requestId: request.id,
        driverName, unitNumber, driverType, daysOnRoad, policyMet,
        homeFrom: window.homeStartDate, homeTo: window.homeTo,
        returnToRoadDate: window.returnToRoadDate, settings,
      });
      console.log(`[HOME-TIME-REQ] Request #${request.id} posted (${window.homeStartDate} → ${window.returnToRoadDate}).`);
      return;
    }

    // No / partial dates — open a clarification and wait for the driver.
    const askKind = window.missingFields.includes('return_to_road') && !window.missingFields.includes('home_start')
      ? 'ask_return_to_road'
      : (window.missingFields.includes('home_start') && !window.missingFields.includes('return_to_road')
        ? 'ask_home_start' : 'ask_both');
    await createClarification(telegram, group, message, {
      window, askKind, isUnplanned: false, settings, language, verdict: { intent: 'home_time_request', reason: verdict.reason, confidence: null },
    });
  } catch (err) {
    console.error('[HOME-TIME-REQ] handleApproverMention error:', err.message);
  }
}

/**
 * Road→home transition side-effect: the driver is now home. Link an existing
 * complete/approved request when one covers this arrival; otherwise open an
 * "unplanned arrival" clarification asking ONLY for the return-to-road date
 * (the home-start date is the Status: Home date). Never throws.
 */
async function handleActualHomeArrival(telegram, group, message, { homeStartIso } = {}) {
  try {
    if (!group || group.group_type !== 'driver') return;

    // A complete/approved/open request already covers this — do not ask again or
    // duplicate. (Repeated Status: Home also lands here and is a no-op.)
    const open = await ht.getOpenHomeTimeRequestForGroup(group.id);
    if (open) {
      if ((open.status === 'awaiting_home_start') && (homeStartIso)) {
        // We were waiting only on the arrival date and now the driver is home:
        // fill it from the actual arrival and, if that completes the window, post.
        const settings = await ht.getHomeTimeSettings();
        const homeStartDate = DateTime.fromISO(homeStartIso).toISODate();
        const window = normalizeHomeTimeWindow({
          knownHomeStart: homeStartDate, knownReturnToRoad: open.return_to_road_date,
        });
        if (window.complete) {
          await completeAndRespond(telegram, group, open, window, message, { settings, language: open.language });
        }
      }
      return;
    }

    const settings = await ht.getHomeTimeSettings();
    const homeStartDate = homeStartIso
      ? DateTime.fromISO(homeStartIso).toISODate()
      : DateTime.fromISO(messageIso(message)).toISODate();

    // A valid return-to-road date may already be on record from an APPROVED
    // request (registered by the driver earlier, by a manager, or corrected in
    // the admin panel — an approved manual entry carries it too). When it is, use
    // it and do NOT ask the driver again: no duplicate clarification, no reminder.
    // The completed cycle still links to this request at close time via
    // findDecidedRequestNearDate, so efficiency/commitment reporting is intact.
    const approved = await ht.getApprovedHomeTimeRequestForGroup(group.id).catch(() => null);
    const knownReturn = approved ? resolveRequestReturnDate(approved) : null;
    if (knownReturn && isUsableKnownReturnDate(knownReturn, homeStartDate)) {
      console.log(`[HOME-TIME-REQ] ${group.group_name || `Group ${group.id}`} arrived home; reusing registered return-to-road ${knownReturn} (no clarification).`);
      return;
    }

    const window = normalizeHomeTimeWindow({ homeStart: homeStartDate });
    await createClarification(telegram, group, message, {
      window, askKind: 'ask_unplanned_return', isUnplanned: true, settings,
      language: null, verdict: { intent: 'actual_home_status', reason: 'Unplanned home arrival (no earlier complete request).' },
    });
  } catch (err) {
    console.error('[HOME-TIME-REQ] handleActualHomeArrival error:', err.message);
  }
}

/**
 * Resolve a home-time window from a driver's free-text reply. AI first, then the
 * deterministic parser. Returns `{ homeFrom, homeTo }` strings or null. Kept for
 * back-compat (the conversational pipeline uses classifyHomeTimeMessage).
 */
async function parseHomeTimeDates({ text, todayIso }) {
  const today = todayIso || todayIsoChicago();
  const prompt = buildHomeTimeDateReplyPrompt({ text, todayLabel: today });
  try {
    const { parsed } = await callGeminiJson({
      userText: prompt,
      maxOutputTokens: 120,
      validateParsed: (p) => typeof p?.found === 'boolean',
    });
    if (parsed.found && parsed.home_from && parsed.home_to
      && isReasonableHomeWindow(parsed.home_from, parsed.home_to, today)) {
      return { homeFrom: String(parsed.home_from), homeTo: String(parsed.home_to) };
    }
  } catch (err) {
    console.warn('[HOME-TIME-REQ] date-reply AI parse failed, using deterministic parser:', err.message);
  }
  const window = parseHomeTimeWindowText(text, today);
  if (window && isReasonableHomeWindow(window.homeFrom, window.homeTo, today)) {
    return { homeFrom: window.homeFrom, homeTo: window.homeTo };
  }
  return null;
}

/**
 * Plain-text follow-up handler: understand a later message that answers an open
 * clarification even without Telegram's reply feature. Uses the AI intent
 * classifier with the open-clarification context so unrelated chatter (or someone
 * else's unrelated date) is NOT consumed. Never throws.
 */
async function handleHomeTimeClarificationReply(telegram, group, message) {
  try {
    if (!group || group.group_type !== 'driver') return;
    if (message?.from?.is_bot) return;
    const text = message?.text || message?.caption || '';
    if (!text) return;

    const open = await ht.getOpenClarificationForGroup(group.id);
    if (!open) return; // nothing waiting
    if (!isHomeTimeCandidate(text, { hasOpenClarification: true })) return; // cheap gate

    const profile = await db.getDriverProfileByGroupId(group.id).catch(() => null);
    const senderIsDriver = await senderIsDriverOf(group, message, profile);
    const openQuestion = open.status === 'awaiting_return_to_road'
      ? 'What date will you be back on the road after home time?'
      : (open.status === 'awaiting_home_start' ? 'What date will you arrive home?' : 'Which home-time dates do you want?');

    const verdict = await classifyHomeTimeMessage({
      transcript: recentBuffer.renderTranscript(group.telegram_group_id),
      triggerText: text,
      todayIso: todayIsoChicago(),
      senderIsDriver,
      hasOpenClarification: true,
      openQuestion,
      knownHomeStart: open.home_from || null,
      knownReturnToRoad: open.return_to_road_date || null,
    });

    // Only consume messages that actually answer the clarification. An unrelated
    // message (or someone else's stray date) is ignored.
    const answers = verdict.intent === 'home_time_followup'
      || (verdict.requestedHomeTime && (verdict.window.homeStartDate || verdict.window.returnToRoadDate));
    const gotNewDate = verdict.window.homeStartDate || verdict.window.returnToRoadDate;
    if (!answers || !gotNewDate) return;

    const settings = await ht.getHomeTimeSettings();
    if (verdict.window.complete
      && isReasonableWindow(verdict.window.homeStartDate, verdict.window.returnToRoadDate, todayIsoChicago())) {
      await completeAndRespond(telegram, group, open, verdict.window, message, {
        settings, language: verdict.language,
      });
      return;
    }
    // Still partial — advance and ask for the remaining date.
    if (verdict.window.missingFields.length && verdict.window.missingFields.length < 2) {
      await advanceClarification(telegram, group, open, verdict.window, message, {
        settings, language: verdict.language,
      });
    }
  } catch (err) {
    console.error('[HOME-TIME-REQ] handleHomeTimeClarificationReply error:', err.message);
  }
}

/** Back-compat alias — the bot now routes through processHomeTimeMessage. */
const handleHomeTimeDateReply = handleHomeTimeClarificationReply;

/**
 * Orchestrator called once per driver-group message by the bot pipeline. Takes the
 * result of the deterministic status machine (already applied) and dispatches the
 * conversational side-effects with at most one AI call. Never throws.
 *
 * @param {object} opts
 * @param {object|null} opts.statusResult  return of homeTimeService.handleDriverGroupStatus
 * @param {boolean} opts.mentionsApprover
 */
async function processHomeTimeMessage(telegram, group, message, { statusResult = null, mentionsApprover = false } = {}) {
  try {
    if (!group || group.group_type !== 'driver') return;

    // 1) A real (deterministic) status transition just happened.
    if (statusResult && statusResult.transition === 'home_to_road') {
      await homeTimeStatus.closeHomeStayOnReturn(group, { returnToRoadIso: statusResult.eventAt });
      return;
    }
    if (statusResult && statusResult.transition === 'road_to_home') {
      await handleActualHomeArrival(telegram, group, message, { homeStartIso: statusResult.eventAt });
      return;
    }
    // A repeated same-status line (changed=false) or first observation: nothing
    // conversational to do.
    if (statusResult) return;

    // 2) No exact status line. Approver tag → request flow.
    if (mentionsApprover) {
      await handleApproverMention(telegram, group, message);
      return;
    }

    // 3) Neither status nor tag. Could be a clarification answer, an AI-detected
    //    non-exact status, or a driver-initiated request. One AI call, gated by the
    //    cheap candidate filter so ordinary chatter never reaches the model.
    const text = message?.text || message?.caption || '';
    if (message?.from?.is_bot || !text) return;

    const open = await ht.getOpenClarificationForGroup(group.id);
    if (open) {
      // Delegate to the dedicated follow-up handler (it re-reads `open`).
      await handleHomeTimeClarificationReply(telegram, group, message);
      return;
    }

    if (!isHomeTimeCandidate(text, { hasOpenClarification: false })) return;

    const profile = await db.getDriverProfileByGroupId(group.id).catch(() => null);
    const senderIsDriver = await senderIsDriverOf(group, message, profile);
    const verdict = await classifyHomeTimeMessage({
      transcript: recentBuffer.renderTranscript(group.telegram_group_id),
      triggerText: text,
      todayIso: todayIsoChicago(),
      senderIsDriver,
      hasOpenClarification: false,
    });

    // AI-detected NON-exact actual status ("uyda", "he is home now", "back rolling").
    if (verdict.isActualStatusChange && (verdict.confidence == null || verdict.confidence >= AI_STATUS_CONFIDENCE_MIN)) {
      const newState = verdict.intent === 'actual_home_status' ? 'home'
        : (verdict.intent === 'actual_road_status' ? 'road' : null);
      if (newState) {
        const applied = await homeTimeStatus.applyStateTransition(telegram, group, {
          newState, eventAt: messageIso(message), statusText: text,
        });
        if (applied?.transition === 'road_to_home') {
          await handleActualHomeArrival(telegram, group, message, { homeStartIso: applied.eventAt });
        } else if (applied?.transition === 'home_to_road') {
          await homeTimeStatus.closeHomeStayOnReturn(group, { returnToRoadIso: applied.eventAt });
        }
        return;
      }
    }

    // Driver-initiated request (no approver tag) — open a clarification / post card.
    if (verdict.requestedHomeTime || verdict.intent === 'home_time_request') {
      const settings = await ht.getHomeTimeSettings();
      if (verdict.window.complete
        && isReasonableWindow(verdict.window.homeStartDate, verdict.window.returnToRoadDate, todayIsoChicago())) {
        // Reuse the approver flow's card path by opening then immediately completing.
        const created = await createClarification(telegram, group, message, {
          window: normalizeHomeTimeWindow({}), askKind: 'ask_both', isUnplanned: false,
          settings, language: verdict.language, verdict,
        });
        await completeAndRespond(telegram, group, created, verdict.window, message, {
          settings, language: verdict.language,
        });
        return;
      }
      const askKind = verdict.window.missingFields.includes('return_to_road')
        && !verdict.window.missingFields.includes('home_start')
        ? 'ask_return_to_road'
        : (verdict.window.missingFields.includes('home_start') && !verdict.window.missingFields.includes('return_to_road')
          ? 'ask_home_start' : 'ask_both');
      await createClarification(telegram, group, message, {
        window: verdict.window, askKind, isUnplanned: false, settings, language: verdict.language, verdict,
      });
    }
  } catch (err) {
    console.error('[HOME-TIME-REQ] processHomeTimeMessage error:', err.message);
  }
}

/** Announce an approved request to the employee group. Non-fatal on failure. */
async function announceApproval(telegram, request) {
  if (!config.employeeGroupId) return;
  const who = `${escapeHtml(request.driver_name || 'A driver')}`
    + `${request.unit_number ? ` (Unit ${escapeHtml(request.unit_number)})` : ''}`;
  const by = request.decided_by_username ? `@${escapeHtml(request.decided_by_username)}` : 'a manager';
  const text = `🏠 <b>Home Time Approved</b>\n`
    + `${who} requested home time from <b>${escapeHtml(request.home_from || '—')}</b> `
    + `to <b>${escapeHtml(request.home_to || '—')}</b>.\n`
    + `Approved by ${by}.`;
  try {
    await safeSend(() => telegram.sendMessage(config.employeeGroupId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }));
  } catch (err) {
    console.error('[HOME-TIME-REQ] Failed to announce approval to employee group:', err.message);
  }
}

module.exports = {
  CALLBACK_PREFIX,
  handleApproverMention,
  handleActualHomeArrival,
  handleHomeTimeClarificationReply,
  handleHomeTimeDateReply,
  processHomeTimeMessage,
  parseHomeTimeDates,
  postRequestCard,
  generateRequestText,
  classifyHomeTimeRequest,
  buildCardText,
  buildDecisionButtons,
  buildDecidedCardText,
  announceApproval,
  sendPolicyResponse,
  createClarification,
  completeAndRespond,
  reactThumbsUp,
};
