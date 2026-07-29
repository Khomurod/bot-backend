/**
 * Home-Time Request & conversational clarification service — the ORCHESTRATOR.
 *
 * Decides what a driver group's messages MEAN for home time and dispatches the
 * right workflow. The workflow itself lives in focused modules:
 *
 *   homeTimeIntentService      what does this message mean? (one AI pass)
 *   homeTimeSignals            pure wording detectors (time off / errand / operational)
 *   homeTimeClarificationFlow  open / advance / complete a clarification, post the card
 *   homeTimeMessageComposer    the AI prose the bot sends
 *   homeTimeDriverChannel      may we message the driver group at all?
 *   homeTimeInternalAlert      tell staff instead, when we may not
 *   homeTimeApproval           approve / decline, card settle, expiry
 *
 * This file keeps its full public surface: everything it used to export is still
 * exported here (re-exported where it moved), so no importer changes.
 *
 * The `telegram` instance is always passed in (never required) so this module
 * stays free of a require cycle with bot.js.
 */
const { DateTime } = require('luxon');
const db = require('../database/db');
const ht = require('../database/homeTime');
const recentBuffer = require('./recentMessageBuffer');
const { callGeminiJson } = require('./geminiClient');
const {
  buildHomeTimeDateReplyPrompt,
  parseHomeTimeWindowText,
  isReasonableHomeWindow,
} = require('./homeTimeRequestConstants');
const {
  looksLikeTemporaryHomeStop, looksLikeOperationalContext, looksLikeFirstPersonStatus,
} = require('./homeTimeSignals');
const {
  normalizeHomeTimeWindow, isReasonableWindow,
  isUsableKnownReturnDate, resolveRequestReturnDate, isHomeTimeRequestOutdated,
} = require('./homeTimeDateResolver');
const { classifyHomeTimeMessage, isHomeTimeCandidate } = require('./homeTimeIntentService');
const homeTimeStatus = require('./homeTimeService');
const {
  CALLBACK_PREFIX, buildCardText, buildDecisionButtons, buildDecidedCardText,
} = require('./homeTimeRequestCards');
const { generateRequestText } = require('./homeTimeMessageComposer');
const { reactToDriverMessage } = require('./homeTimeDriverChannel');
const {
  todayIsoChicago, askKindForWindow, postRequestCard,
  sendPolicyResponse, completeAndRespond, advanceClarification, createClarification,
} = require('./homeTimeClarificationFlow');
// The approver-tag (@mention) entry point and its legacy classifier; re-exported
// below so existing importers of this module are unchanged.
const { classifyHomeTimeRequest, handleApproverMention } = require('./homeTimeApproverTag');
// The decision workflow (approve/decline + card settle + approval announcement)
// lives in a focused module; re-exported below so existing importers are unchanged.
const { announceApproval, applyHomeTimeDecision, expireOutdatedRequest } = require('./homeTimeApproval');

/**
 * Confidence floor for accepting a NON-deterministic, AI-detected status change.
 *
 * Raised from 70 to 85 alongside the sender/first-person/context gates below: an
 * automatic home↔road flip is a real state change with downstream bonus and
 * efficiency consequences, so it should be conservative. Official "Status: Home"
 * / "Status: Ready" lines are deterministic and never touch this path.
 */
const AI_STATUS_CONFIDENCE_MIN = 85;

/** Timestamp of a Telegram message (seconds → ISO), or now. */
function messageIso(message) {
  const secs = Number(message?.date);
  if (Number.isFinite(secs) && secs > 0) return DateTime.fromSeconds(secs).toUTC().toISO();
  return DateTime.now().toUTC().toISO();
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

/**
 * May an AI-detected (non-exact) status change be applied?
 *
 * Conservative by design — ALL of the following must hold:
 *   - the model actually reported a current-state change;
 *   - the sender is VERIFIED as this group's driver (null "cannot tell" is not
 *     enough — that is how a dispatcher's message used to flip a driver's state);
 *   - the statement is first-person and present-tense, so a third-person staff
 *     report ("he is currently at home and will let us know once he gets to the
 *     truck") cannot change status;
 *   - confidence is very high;
 *   - there is no temporary-stop wording (a quick errand near home) and no
 *     ordinary operational context (repairs, loads, yard, ETA…).
 *
 * Pure and exported so the rules are testable without a database.
 *
 * @returns {{ allowed: boolean, state: ('home'|'road'|null), reason: string }}
 */
function evaluateAiStatusChange(verdict, { text = '', senderIsDriver = null } = {}) {
  const deny = (reason) => ({ allowed: false, state: null, reason });
  if (!verdict?.isActualStatusChange) return deny('not an actual status change');

  const state = verdict.intent === 'actual_home_status' ? 'home'
    : (verdict.intent === 'actual_road_status' ? 'road' : null);
  if (!state) return deny('no home/road state in the verdict');

  if (senderIsDriver !== true) return deny('sender is not verified as the driver');
  if (!looksLikeFirstPersonStatus(text)) return deny('not a first-person statement about the sender');
  if (verdict.confidence != null && verdict.confidence < AI_STATUS_CONFIDENCE_MIN) {
    return deny(`confidence ${verdict.confidence} below ${AI_STATUS_CONFIDENCE_MIN}`);
  }
  if (looksLikeTemporaryHomeStop(text)) return deny('temporary stop / errand near home');
  if (looksLikeOperationalContext(text)) return deny('ordinary operational context');

  return { allowed: true, state, reason: 'verified first-person status change' };
}

/**
 * Should this verdict open a home-time request?
 *
 * The intent service already applies its own precision guard; this is the
 * orchestrator-side backstop that additionally refuses ordinary operational
 * conversation ("700 ml yurmaydi bu trailer. Yo'lda fix qilsak bo'ladimi aka").
 * Explicit time-off wording or a concrete date overrides it, so a genuine
 * request that also mentions a load or a trailer still gets through.
 *
 * Pure and exported for testing.
 */
function shouldOpenRequest(verdict, { text = '' } = {}) {
  const requested = Boolean(verdict?.requestedHomeTime) || verdict?.intent === 'home_time_request';
  if (!requested) return { open: false, reason: 'no request intent' };
  const hasDate = Boolean(verdict?.window
    && (verdict.window.homeStartDate || verdict.window.returnToRoadDate));
  if (looksLikeOperationalContext(text, { hasDate })) {
    return { open: false, reason: 'ordinary operational conversation, no time-off wording or date' };
  }
  return { open: true, reason: 'genuine home-time request' };
}

// ── Entry points ──

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
    if (open && isHomeTimeRequestOutdated(open, { todayIso: todayIsoChicago() })) {
      // A stale/outdated open request must not block a fresh home arrival.
      await expireOutdatedRequest(telegram, open);
    } else if (open) {
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
 *
 * This is also the SILENT capture path: while driver messaging is off the driver
 * gets no question, but if they mention their dates anyway the same request is
 * updated — and completed, with its approval card — without any reply to them.
 */
async function handleHomeTimeClarificationReply(telegram, group, message) {
  try {
    if (!group || group.group_type !== 'driver') return;
    if (message?.from?.is_bot) return;
    const text = message?.text || message?.caption || '';
    if (!text) return;

    const open = await ht.getOpenClarificationForGroup(group.id);
    if (!open) return; // nothing waiting
    // A late reply must never reopen/complete an outdated clarification — close it.
    if (isHomeTimeRequestOutdated(open, { todayIso: todayIsoChicago() })) {
      await expireOutdatedRequest(telegram, open);
      return;
    }
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

    let open = await ht.getOpenClarificationForGroup(group.id);
    if (open && isHomeTimeRequestOutdated(open, { todayIso: todayIsoChicago() })) {
      // Outdated clarification: close it and let this message be judged fresh
      // (it might be a brand-new request), never fed into the stale one.
      await expireOutdatedRequest(telegram, open);
      open = null;
    }
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

    // AI-detected NON-exact actual status ("uyda", "men uydaman", "back rolling").
    // Deliberately conservative — see evaluateAiStatusChange. The official
    // "Status: Home" line is deterministic and was already handled above, so this
    // gate only ever narrows the fuzzy path.
    if (verdict.isActualStatusChange) {
      const decision = evaluateAiStatusChange(verdict, { text, senderIsDriver });
      if (!decision.allowed) {
        console.log(`[HOME-TIME-REQ] AI status change refused for ${group.group_name || `Group ${group.id}`}: ${decision.reason}.`);
        return;
      }
      const applied = await homeTimeStatus.applyStateTransition(telegram, group, {
        newState: decision.state, eventAt: messageIso(message), statusText: text,
      });
      if (applied?.transition === 'road_to_home') {
        await handleActualHomeArrival(telegram, group, message, { homeStartIso: applied.eventAt });
      } else if (applied?.transition === 'home_to_road') {
        await homeTimeStatus.closeHomeStayOnReturn(group, { returnToRoadIso: applied.eventAt });
      }
      return;
    }

    // Driver-initiated request (no approver tag) — open a clarification / post card.
    const { open: shouldOpen, reason: openReason } = shouldOpenRequest(verdict, { text });
    if (shouldOpen) {
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
      await createClarification(telegram, group, message, {
        window: verdict.window,
        askKind: askKindForWindow(verdict.window),
        isUnplanned: false,
        settings,
        language: verdict.language,
        verdict,
      });
    } else if (verdict.requestedHomeTime || verdict.intent === 'home_time_request') {
      console.log(`[HOME-TIME-REQ] Request refused for ${group.group_name || `Group ${group.id}`}: ${openReason}.`);
    }
  } catch (err) {
    console.error('[HOME-TIME-REQ] processHomeTimeMessage error:', err.message);
  }
}

/**
 * Back-compat wrapper for the 👍 reaction. New code should call
 * homeTimeDriverChannel.reactToDriverMessage directly, which is where the
 * driver-messaging switch is enforced.
 */
async function reactThumbsUp(telegram, chatId, messageId, { settings = null } = {}) {
  return reactToDriverMessage(telegram, chatId, messageId, { settings });
}

module.exports = {
  CALLBACK_PREFIX,
  AI_STATUS_CONFIDENCE_MIN,
  evaluateAiStatusChange,
  shouldOpenRequest,
  askKindForWindow,
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
  applyHomeTimeDecision,
  sendPolicyResponse,
  createClarification,
  completeAndRespond,
  reactThumbsUp,
};
