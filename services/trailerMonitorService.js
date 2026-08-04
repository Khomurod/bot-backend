/**
 * Trailer Tracking (Beta) — Telegram monitor.
 *
 * Called (detached, best-effort) from the driver-group message pipeline for
 * every message in an active driver group. This file owns the PIPELINE; each
 * stage lives in ./trailerMonitor:
 *
 *   all messages
 *     → cheap trailer-candidate filter (keywords, units, multilingual action
 *       hints + reply/photo context — no network)   ./trailerMonitor/candidateFilter
 *     → full context collection (reply text/caption, replied/current image
 *       vision text, bounded recent messages — services/trailerContextService)
 *     → deterministic extraction (units, action words, location, condition —
 *       candidates only, NEVER authorization)       ./trailerMessageParser
 *     → MANDATORY AI semantic verification for any possible pickup/drop-off
 *       (services/trailerSemanticVerifier — completed past action vs. plan /
 *       instruction / question / discussion, in EN/RU/UZ)
 *     → hard server-side approval gate (strict unit validation + grounding +
 *       confidence thresholds)
 *     → shape the outcome into a ledger row        ./trailerMonitor/aiEventShaping
 *     → register ONLY confirmed completed actions  ./trailerMonitor/registration
 *       everything meaningful but unconfirmed goes to the Needs Review ledger +
 *       Automatic Updating (Test) group. If the AI is unavailable / times out /
 *       returns invalid JSON the candidate FAILS CLOSED to review — no status
 *       change, no driver reply.
 *     → replies and reactions, silent by default   ./trailerMonitor/driverGroupReplies
 *
 * Dedupe is guaranteed by the DB unique index on (telegram_group_id,
 * telegram_message_id, event_index) plus an in-flight AI de-dupe per message.
 *
 * NEVER throws to its caller — a trailer-monitor failure must not affect any
 * other bot behavior. No secrets or full prompts are logged.
 */
const db = require('../database/db');
const { parseTrailerMessage, parseTrailerMessageEvents } = require('./trailerMessageParser');
const { collectTrailerContext } = require('./trailerContextService');
const {
  verifyTrailerSemantics, evaluateTrailerEventApproval,
} = require('./trailerSemanticVerifier');
// Pure event shaping/labelling helpers (re-exported below for existing callers).
const { statePhrase } = require('./trailerMonitor/eventColumns');
const {
  messageText, extractEvidence, isTrailerCandidate, isTrailerCandidateMessage,
  resolveTestGroupId, looksLikeTrailerCommand, isSilentDriverGroup,
} = require('./trailerMonitor/candidateFilter');
const { maybeReplyAndReact, reportUnidentified } = require('./trailerMonitor/driverGroupReplies');
const {
  registerPickupDropoff, registerPlannedInstruction, registerUnidentified,
} = require('./trailerMonitor/registration');
const {
  hasPotentialAction, resolveVerifiedCargo, buildVerifiedParsed, buildReviewParsed,
  buildPlannedParsed, sanitizeAiResultForStorage,
} = require('./trailerMonitor/aiEventShaping');

/**
 * Main entry point. `group` is the DB group row (must be an active driver
 * group); `message` is ctx.message. Returns a small result object for tests;
 * swallows all errors so it can be called detached.
 */
async function handleTrailerGroupMessage(telegram, group, message) {
  try {
    if (!telegram || !group || !message) return { skipped: 'missing-args' };
    // Never react to the bot's own messages.
    if (message.from?.is_bot) return { skipped: 'from-bot' };

    const text = messageText(message);
    const evidence = extractEvidence(message);
    // ── 1. cheap candidate filter (no network) ──
    if (!isTrailerCandidateMessage(message)) return { skipped: 'not-trailer' };

    const settings = await db.getTrailerSettings();
    if (!settings || settings.enabled === false) return { skipped: 'disabled' };
    const betaMode = settings.beta_mode !== false;
    const semanticRequired = settings.semantic_ai_required !== false;

    // ── 2. deterministic extraction (candidates only) ──
    let parsedList = parseTrailerMessageEvents(text);
    parsedList = parsedList.filter((p) => p.isTrailerRelated);

    const testGroupId = resolveTestGroupId(settings);
    const from = message.from || {};
    const nowIso = new Date().toISOString();
    const eventTimeIso = Number.isFinite(message.date) ? new Date(message.date * 1000).toISOString() : nowIso;

    // Resolve driver profile for the group (best-effort).
    let profile = null;
    try { profile = await db.getDriverProfileByGroupId(group.id); } catch { /* ignore */ }
    const driverName = profile
      ? [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim() || group.group_name
      : group.group_name;

    const ctx = { group, from, profile, driverName, eventTimeIso, nowIso, text, evidence, settings, betaMode, message };

    const potentialAction = hasPotentialAction(parsedList, text);

    // ── 3. no possible state change → legacy mention/unidentified ledger ──
    if (!potentialAction) {
      if (!parsedList.length) return { skipped: 'not-trailer' };
      const reportedUnids = [];
      let anyDuplicate = false;
      for (const parsed of parsedList) {
        const { event, duplicate } = await registerUnidentified(parsed, ctx);
        if (duplicate) anyDuplicate = true;
        else if (event) reportedUnids.push({ parsed, event });
      }
      let reportedToTest = false;
      for (const { parsed, event } of reportedUnids) {
        if (looksLikeTrailerCommand(parsed) && testGroupId) {
          await reportUnidentified(telegram, group, message, parsed, event, testGroupId, betaMode);
          reportedToTest = true;
        }
      }
      if (!reportedUnids.length) return { skipped: 'duplicate' };
      const firstUnid = reportedUnids[0].event;
      return { unidentified: true, eventType: firstUnid.event_type, eventId: firstUnid.id, reportedToTest };
    }

    // ── 4. possible pickup/drop-off → gather full context ──
    const context = await collectTrailerContext(telegram, group, message, {
      visionEnabled: settings.ai_fallback_enabled !== false,
    });

    // ── 5. MANDATORY semantic verification ──
    if (!semanticRequired) {
      // Explicit admin opt-out (semantic_ai_required=false): legacy behavior —
      // deterministic pickup/dropoff registers directly. Not the default.
      return legacyRegisterPath(telegram, group, message, parsedList, ctx, testGroupId, betaMode);
    }

    const dedupeKey = `${group.telegram_group_id}:${message.message_id}`;
    const aiResult = await verifyTrailerSemantics(context, parsedList, { dedupeKey });

    // ── 5a. FAIL CLOSED: AI unavailable / error / invalid JSON ──
    if (!aiResult || aiResult.status !== 'ok') {
      const status = aiResult?.status === 'invalid_response' ? 'invalid_response'
        : aiResult?.status === 'unavailable' ? 'unavailable' : 'unavailable';
      const failParsed = {
        ...(parsedList[0] || parseTrailerMessage(text)),
        eventType: 'unidentified',
        needsReview: true,
        reason: `AI semantic verification ${aiResult?.status || 'failed'} — no status change (fail closed)`,
        method: 'semantic_ai_failed',
      };
      const { event, duplicate } = await registerUnidentified(failParsed, ctx, status);
      if (!duplicate && event && testGroupId && looksLikeTrailerCommand(failParsed)) {
        await reportUnidentified(telegram, group, message, failParsed, event, testGroupId, betaMode);
      }
      return { failedClosed: true, aiStatus: aiResult?.status || 'error', eventId: event?.id || null };
    }

    // ── 5b. AI answered: apply the hard approval gate per event ──
    const registered = [];
    const reviewItems = [];
    const plannedItems = [];
    let anyDuplicate = false;

    let events = aiResult.trailerEvents;
    if (!events.length) {
      // AI says trailer-related but produced no per-trailer events — treat the
      // message-level result as one ungrounded event for review purposes.
      events = [{
        eventIndex: 0, trailerUnit: null, intent: aiResult.intent, action: aiResult.action,
        completed: aiResult.completed, unitGrounded: false, unitSource: null, unitEvidence: null,
        possessionStatus: 'unknown', cargoStatus: 'unknown', locationText: null,
        conditionText: null, actionEvidence: null, confidence: 0, reason: 'no trailer events returned',
      }];
    }

    for (let i = 0; i < events.length; i += 1) {
      const aiEvent = events[i];
      const gate = evaluateTrailerEventApproval(aiResult, aiEvent, context, settings);
      if (gate.allow) {
        const parsed = buildVerifiedParsed(aiResult, aiEvent, parsedList, i);
        const { event, duplicate } = await registerPickupDropoff(parsed, ctx);
        if (duplicate) anyDuplicate = true;
        else if (event) registered.push(event);
      } else if (gate.disposition === 'plan') {
        // Instruction/assignment (e.g. "Trailer drop-off address: …") — record a
        // PENDING instruction, never a completed event, never manual review.
        const parsed = buildPlannedParsed(aiResult, aiEvent, i);
        const { instruction, duplicate } = await registerPlannedInstruction(parsed, ctx);
        if (duplicate) anyDuplicate = true;
        else if (instruction) plannedItems.push({ parsed, instruction });
      } else if (gate.disposition === 'review') {
        const parsed = buildReviewParsed(aiResult, aiEvent, gate, i);
        const { event, duplicate } = await registerUnidentified(parsed, ctx, 'review');
        if (duplicate) anyDuplicate = true;
        else if (event) reviewItems.push({ parsed, event });
      }
      // disposition === 'ignore' → silent skip (questions, discussion, low confidence)
    }

    // ── 6. driver-group confirmation + reaction: suppressed in silent mode
    // (the default). Events are still registered; the driver group hears nothing.
    await maybeReplyAndReact(telegram, group, message, registered, settings, betaMode);

    // ── 7. review items → Automatic Updating (Test) group (grounded/strong only) ──
    let reportedToTest = false;
    for (const { parsed, event } of reviewItems) {
      const strong = Boolean(parsed.trailerUnit) || Boolean(parsed.semantic?.actionEvidence);
      if (strong && testGroupId) {
        await reportUnidentified(telegram, group, message, parsed, event, testGroupId, betaMode);
        reportedToTest = true;
      }
    }

    if (!registered.length && !reviewItems.length && !plannedItems.length) {
      return anyDuplicate ? { skipped: 'duplicate' } : { skipped: 'no-actionable-intent', intent: aiResult.intent };
    }
    if (registered.length) {
      const first = registered[0];
      return {
        registered: true,
        registeredCount: registered.length,
        eventType: first.event_type,
        eventId: first.id,
        unit: first.trailer_unit_number,
        events: registered.map((e) => ({ id: e.id, eventType: e.event_type, unit: e.trailer_unit_number })),
        reviewCount: reviewItems.length,
        plannedCount: plannedItems.length,
        intent: aiResult.intent,
      };
    }
    if (reviewItems.length) {
      return {
        review: true,
        intent: aiResult.intent,
        eventId: reviewItems[0].event.id,
        plannedCount: plannedItems.length,
        reportedToTest,
      };
    }
    // Only planned instructions were recorded — nothing changed status, nothing
    // went to manual review, the driver group heard nothing.
    return {
      planned: true,
      plannedCount: plannedItems.length,
      intent: aiResult.intent,
      unit: plannedItems[0].parsed.trailerUnit,
      action: plannedItems[0].parsed.instructionAction,
      plannedLocation: plannedItems[0].parsed.locationText || null,
    };
  } catch (err) {
    console.error('[TRAILER] handleTrailerGroupMessage failed:', err.message);
    return { error: err.message };
  }
}

/**
 * Legacy direct-registration path, reachable ONLY when an admin explicitly set
 * semantic_ai_required=false in Trailer Settings. Deterministic pickup/dropoff
 * registers without AI (pre-semantic behavior).
 */
async function legacyRegisterPath(telegram, group, message, parsedList, ctx, testGroupId, betaMode) {
  const registered = [];
  const reportedUnids = [];
  const plannedItems = [];
  let anyDuplicate = false;
  for (const parsed of parsedList) {
    if (parsed.isInstruction) {
      // Assignment/address — record a pending instruction, never a completed
      // event, even in the no-AI legacy path (the screenshot bug's other route).
      const { instruction, duplicate } = await registerPlannedInstruction(parsed, ctx);
      if (duplicate) anyDuplicate = true;
      else if (instruction) plannedItems.push({ parsed, instruction });
    } else if (parsed.eventType === 'pickup' || parsed.eventType === 'dropoff') {
      const { event, duplicate } = await registerPickupDropoff(parsed, ctx);
      if (duplicate) anyDuplicate = true;
      else if (event) registered.push(event);
    } else {
      const { event, duplicate } = await registerUnidentified(parsed, ctx);
      if (duplicate) anyDuplicate = true;
      else if (event) reportedUnids.push({ parsed, event });
    }
  }
  // Silent mode (default) suppresses the driver-group reply + reaction here too.
  await maybeReplyAndReact(telegram, group, message, registered, ctx.settings, betaMode);
  let reportedToTest = false;
  for (const { parsed, event } of reportedUnids) {
    if (looksLikeTrailerCommand(parsed) && testGroupId) {
      await reportUnidentified(telegram, group, message, parsed, event, testGroupId, betaMode);
      reportedToTest = true;
    }
  }
  if (!registered.length && !reportedUnids.length && !plannedItems.length) return { skipped: 'duplicate' };
  if (registered.length) {
    const first = registered[0];
    return {
      registered: true,
      registeredCount: registered.length,
      eventType: first.event_type,
      eventId: first.id,
      unit: first.trailer_unit_number,
      events: registered.map((e) => ({ id: e.id, eventType: e.event_type, unit: e.trailer_unit_number })),
      plannedCount: plannedItems.length,
      legacy: true,
    };
  }
  if (reportedUnids.length) {
    return { unidentified: true, eventType: reportedUnids[0].event.event_type, eventId: reportedUnids[0].event.id, reportedToTest, plannedCount: plannedItems.length };
  }
  return {
    planned: true,
    plannedCount: plannedItems.length,
    unit: plannedItems[0].parsed.trailerUnit,
    action: plannedItems[0].parsed.instructionAction,
    plannedLocation: plannedItems[0].parsed.locationText || null,
    legacy: true,
  };
}

module.exports = {
  handleTrailerGroupMessage,
  // Re-exported from ./trailerMonitor so existing importers and tests keep
  // working against services/trailerMonitorService unchanged.
  isTrailerCandidate,
  isTrailerCandidateMessage,
  isSilentDriverGroup,
  extractEvidence,
  statePhrase,
  resolveTestGroupId,
  looksLikeTrailerCommand,
  hasPotentialAction,
  buildVerifiedParsed,
  buildReviewParsed,
  buildPlannedParsed,
  registerPlannedInstruction,
  resolveVerifiedCargo,
  sanitizeAiResultForStorage,
};
