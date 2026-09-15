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
 *   homeTimeApproval           closing a request whose window has passed
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
  looksLikeTemporaryHomeStop, looksLikeOperationalContext, looksLikeFirstPersonStatus,
} = require('./homeTimeSignals');
const { isHomeTimeRequestOutdated } = require('./homeTimeDateResolver');
const { classifyHomeTimeMessage, isHomeTimeCandidate } = require('./homeTimeIntentService');
// The "what did the driver say" half — no Telegram, no cards. Re-exported below
// so no importer of this module moves.
const { parseHomeTimeDates } = require('./homeTimeWindowResolution');
const homeTimeStatus = require('./homeTimeService');
const {
  CALLBACK_PREFIX, buildCardText, buildDecidedCardText,
} = require('./homeTimeRequestCards');
const { generateRequestText } = require('./homeTimeMessageComposer');
const { reactToDriverMessage } = require('./homeTimeDriverChannel');
const {
  todayIsoChicago, postRequestCard, sendPolicyResponse, recordAndPostRequest,
} = require('./homeTimeClarificationFlow');
// The approver-tag (@mention) entry point and its legacy classifier; re-exported
// below so existing importers of this module are unchanged.
const { classifyHomeTimeRequest, handleApproverMention } = require('./homeTimeApproverTag');
// The decision workflow (approve/decline + card settle + approval announcement)
// lives in a focused module; re-exported below so existing importers are unchanged.
const { closeOutdatedRequest } = require('./homeTimeApproval');

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

/*
 * centralDate lived here.
 *
 * It turned the instant a driver reached home into a Central calendar date for
 * the arrival clarification to record. Wenze no longer records a date from an
 * arrival — Home In comes from the Dispatcher Board — so its one caller went
 * with the clarification. The Central-date rule it existed to enforce is still
 * live in `todayIsoChicago()`, in the housekeeping sweep and in the manager
 * notice, and tests/homeTimeCentralDates.test.js pins it there.
 */

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

    // THE DRIVER IS HOME. THAT IS THE FACT, AND IT IS ALREADY RECORDED.
    //
    // `applyStateTransition` opened the cycle before this was called, and the
    // managers were told by its own notice. What used to happen next was a
    // question — "when will you be back on the road?" — recorded as an
    // `awaiting_return_to_road` clarification and then chased by reminders.
    //
    // That question is gone. The answer it wanted is Home Out, and Home Out is
    // now read from the Dispatcher Board: the truck going back into the dispatch
    // pool, or a real new load, says the stay ended. A date the driver guesses on
    // the day they arrive is not evidence of anything, and asking for it cost a
    // message into the driver's group and a reminder clock behind it.
    //
    // A stale open request is still closed, because a finished row must not
    // block the next one. Nothing is asked, and nothing is scheduled.
    const open = await ht.getOpenHomeTimeRequestForGroup(group.id);
    if (open && isHomeTimeRequestOutdated(open, { todayIso: todayIsoChicago() })) {
      await closeOutdatedRequest(telegram, open).catch(() => {});
    }
  } catch (err) {
    console.error('[HOME-TIME-REQ] handleActualHomeArrival error:', err.message);
  }
}

/*
 * handleHomeTimeClarificationReply and its back-compat alias
 * handleHomeTimeDateReply lived here.
 *
 * They understood a later message as an ANSWER to a question Wenze had asked
 * about planned home dates. Wenze no longer asks: a request is recorded with
 * whatever the driver said and delivered to the managers, and the dates that
 * matter — when the driver actually got home and actually left again — come
 * from the Dispatcher Board, not from a plan typed days in advance.
 *
 * Deleted rather than left unreachable. A retired path kept "just in case" is a
 * path that comes back, and this one's whole purpose was to sustain a
 * conversation that no longer starts.
 */

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
    // The home stay is already closed: `applyStateTransition` does it as part of
    // the transition, so no caller has to remember. Forgetting is exactly what
    // left 74 open cycles in production.
    if (statusResult && statusResult.transition === 'home_to_road') return;
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

    // A LEGACY OPEN CLARIFICATION NO LONGER SWALLOWS THE MESSAGE. Nothing
    // creates these any more; the rows still in `awaiting_*` are from before the
    // loop was removed. Closing one on sight means a driver who writes again is
    // heard as making a fresh request rather than answering a question Wenze has
    // stopped asking. The row itself is kept, with its dates.
    const legacyOpen = await ht.getOpenClarificationForGroup(group.id);
    if (legacyOpen) await closeOutdatedRequest(telegram, legacyOpen).catch(() => {});

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
      }
      // home_to_road needs nothing here — applyStateTransition closed the cycle.
      return;
    }

    // Driver-initiated request. RECORD IT, TELL THE MANAGERS, STOP.
    //
    // There is deliberately no branch here on whether the driver spelled out
    // both dates. That branch used to decide between "post the card" and "open a
    // clarification and start asking", and the asking half is gone: the planned
    // dates it chased are a guess about the future, and Home In and Home Out are
    // recorded from the Dispatcher Board and the driver's own status instead.
    // Whatever dates were said are kept; the rest stay null.
    const { open: shouldOpen, reason: openReason } = shouldOpenRequest(verdict, { text });
    if (shouldOpen) {
      const settings = await ht.getHomeTimeSettings();
      await recordAndPostRequest(telegram, group, message, {
        window: verdict.window,
        settings,
        language: verdict.language,
        verdict,
        isUnplanned: false,
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
  handleApproverMention,
  handleActualHomeArrival,
  processHomeTimeMessage,
  parseHomeTimeDates,
  postRequestCard,
  generateRequestText,
  classifyHomeTimeRequest,
  buildCardText,
  buildDecidedCardText,
  sendPolicyResponse,
  reactThumbsUp,
};
