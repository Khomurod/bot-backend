/**
 * Home-Time approver-tag path.
 *
 * The oldest of the three entry points: a company representative tags an
 * approver (@tomr_robins0n / @SaffieBNett) in a driver group. Managers are
 * tagged for loads, rates, breakdowns, paperwork and a dozen other reasons, so
 * this path is deliberately conservative about calling something a home-time
 * request.
 *
 * Split out of homeTimeRequestService (which stays the orchestrator and still
 * re-exports both functions) so each file keeps one clear responsibility and
 * stays within the per-file line limit.
 */
const ht = require('../database/homeTime');
const recentBuffer = require('./recentMessageBuffer');
const { callGeminiJson } = require('./geminiClient');
const {
  HOME_TIME_APPROVER_MENTIONS,
  hasHomeTimeSignal,
  buildHomeTimeClassificationPrompt,
  parseHomeTimeWindowText,
  isReasonableHomeWindow,
} = require('./homeTimeRequestConstants');
const { looksLikeTemporaryHomeStop, looksLikeOperationalContext } = require('./homeTimeSignals');
const { normalizeHomeTimeWindow, isHomeTimeRequestOutdated } = require('./homeTimeDateResolver');
const {
  todayIsoChicago, resolveDriverLabel, resolveRoadMetrics, postRequestCard,
  createClarification, askKindForWindow,
} = require('./homeTimeClarificationFlow');
const { expireOutdatedRequest } = require('./homeTimeApproval');

/**
 * Ask the AI whether the recent conversation is a home-time request. Unchanged
 * JSON contract; see homeTimeIntentService for the newer unified classifier used
 * by the conversational message pipeline.
 *
 * Two deterministic backstops override the model in both directions:
 *   - a brief stop / errand near home is never a request;
 *   - ordinary operational conversation is never a request;
 * unless there is genuine time-off evidence (explicit wording or a real window).
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

    const hasDate = Boolean(homeFrom && homeTo);
    if (isRequest && looksLikeTemporaryHomeStop(haystack, { hasDate })) {
      isRequest = false;
      homeFrom = null;
      homeTo = null;
      reason = `Temporary stop / errand near home, not time off — not treated as a request. ${reason}`.slice(0, 300);
    } else if (isRequest && looksLikeOperationalContext(haystack, { hasDate })) {
      isRequest = false;
      homeFrom = null;
      homeTo = null;
      reason = `Ordinary operational conversation, not time off — not treated as a request. ${reason}`.slice(0, 300);
    }

    return {
      isRequest, reason, confidence: confidence || null,
      datesSpecified: Boolean(homeFrom && homeTo), homeFrom, homeTo, aiUsed: true,
    };
  } catch (err) {
    console.warn('[HOME-TIME-REQ] AI classification failed, using keyword heuristic:', err.message);
    const window = keywordSignal ? parseHomeTimeWindowText(haystack, today) : null;
    const valid = window && isReasonableHomeWindow(window.homeFrom, window.homeTo, today);
    const excluded = looksLikeTemporaryHomeStop(haystack, { hasDate: Boolean(valid) })
      || looksLikeOperationalContext(haystack, { hasDate: Boolean(valid) });
    const surfaced = keywordSignal && !excluded;
    return {
      isRequest: surfaced,
      reason: surfaced
        ? 'AI unavailable — home-time wording detected, surfaced for human review.'
        : (keywordSignal
          ? 'AI unavailable — wording looks like a brief stop / errand or operational talk, not surfaced.'
          : 'AI unavailable — no home-time wording detected, not surfaced.'),
      confidence: null,
      datesSpecified: Boolean(valid),
      homeFrom: valid ? window.homeFrom : null,
      homeTo: valid ? window.homeTo : null,
      aiUsed: false,
    };
  }
}

/**
 * Approver-tag entry point. Safe to call on any approver-tag message in a driver
 * group. Never throws. Posts the card immediately when dates are known, otherwise
 * opens a clarification (which is silent, with a staff alert, when driver
 * messaging is disabled) and waits for the driver's reply.
 */
async function handleApproverMention(telegram, group, message) {
  try {
    if (!group || group.group_type !== 'driver') return;

    const existing = await ht.getOpenHomeTimeRequestForGroup(group.id);
    if (existing) {
      // An outdated open request must not block a new one — close it first.
      if (!isHomeTimeRequestOutdated(existing, { todayIso: todayIsoChicago() })) return; // one active flow per driver
      await expireOutdatedRequest(telegram, existing);
    }

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
    await createClarification(telegram, group, message, {
      window,
      askKind: askKindForWindow(window),
      isUnplanned: false,
      settings,
      language,
      verdict: { intent: 'home_time_request', reason: verdict.reason, confidence: null },
    });
  } catch (err) {
    console.error('[HOME-TIME-REQ] handleApproverMention error:', err.message);
  }
}

module.exports = {
  classifyHomeTimeRequest,
  handleApproverMention,
};
