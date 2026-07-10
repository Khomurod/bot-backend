/**
 * Trailer Tracking (Beta) — Telegram monitor.
 *
 * Called (detached, best-effort) from the driver-group message pipeline for
 * every message in an active driver group. Pipeline:
 *
 *   all messages
 *     → cheap trailer-candidate filter (keywords, units, multilingual action
 *       hints + reply/photo context — no network)
 *     → full context collection (reply text/caption, replied/current image
 *       vision text, bounded recent messages — services/trailerContextService)
 *     → deterministic extraction (units, action words, location, condition —
 *       candidates only, NEVER authorization)
 *     → MANDATORY AI semantic verification for any possible pickup/drop-off
 *       (services/trailerSemanticVerifier — completed past action vs. plan /
 *       instruction / question / discussion, in EN/RU/UZ)
 *     → hard server-side approval gate (strict unit validation + grounding +
 *       confidence thresholds)
 *     → register ONLY confirmed completed actions; everything meaningful but
 *       unconfirmed goes to the Needs Review ledger + Automatic Updating (Test)
 *       group. If the AI is unavailable / times out / returns invalid JSON the
 *       candidate FAILS CLOSED to review — no status change, no driver reply.
 *
 * Dedupe is guaranteed by the DB unique index on (telegram_group_id,
 * telegram_message_id, event_index) plus an in-flight AI de-dupe per message.
 *
 * NEVER throws to its caller — a trailer-monitor failure must not affect any
 * other bot behavior. No secrets or full prompts are logged.
 */
const db = require('../database/db');
const config = require('../config/config');
const {
  parseTrailerMessage, parseTrailerMessageEvents,
  hasTrailerKeyword, extractUnitNumber, detectAction, detectMultilingualActionHint,
} = require('./trailerMessageParser');
const { collectTrailerContext, groundedSourcesFromContext } = require('./trailerContextService');
const {
  verifyTrailerSemantics, evaluateTrailerEventApproval, isSemanticAiConfigured,
} = require('./trailerSemanticVerifier');
const { photoDescriptor } = require('./trailerVisionService');
const { geocodeTrailerLocation } = require('./trailerGeocodeService');
const { buildTelegramMessageUrl } = require('./telegramUrl');

function messageText(message) {
  if (!message) return '';
  return String(message.text || message.caption || '').trim();
}

/** Collect Telegram file evidence (photos/documents) from a message. */
function extractEvidence(message) {
  if (!message) return null;
  const photos = Array.isArray(message.photo) && message.photo.length
    ? [message.photo[message.photo.length - 1].file_id] // largest size
    : [];
  const documentFileId = message.document?.file_id || null;
  const hasPhoto = photos.length > 0 || Boolean(message.document?.mime_type?.startsWith('image/'));
  if (!photos.length && !documentFileId) return null;
  return {
    has_photo: hasPhoto,
    photo_file_ids: photos,
    document_file_id: documentFileId,
    media_group_id: message.media_group_id || null,
  };
}

/** Cheap text-only pre-filter (kept for compatibility + tests). */
function isTrailerCandidate(text) {
  if (!text) return false;
  return hasTrailerKeyword(text) || Boolean(extractUnitNumber(text));
}

/**
 * Cheap MESSAGE-level candidate filter. True when:
 *  - the text/caption has a trailer keyword or extractable unit (as before), OR
 *  - the text carries an action hint (English or Uzbek/Russian pickup/drop-off
 *    verb) AND there is grounding nearby: a replied-to message with a photo or
 *    trailer signal, or a unit-like token in the text itself.
 * Runs no network calls; false means the message is ignored entirely.
 */
function isTrailerCandidateMessage(message) {
  const text = messageText(message);
  if (isTrailerCandidate(text)) return true;
  if (!text) return false;
  const hint = detectMultilingualActionHint(text) || detectAction(text);
  if (!hint) return false;
  // Unit-like token inline ("Hooked to SWFZ233611")?
  if (/\b[A-Za-z]{0,4}-?\d{4,}[A-Za-z0-9-]*\b/.test(text)) return true;
  // Reply context: replied-to photo (unit may live in the image) or trailer text.
  const replied = message.reply_to_message;
  if (!replied) return false;
  if (photoDescriptor(replied)) return true;
  const repliedText = `${replied.text || ''}\n${replied.caption || ''}`;
  return isTrailerCandidate(repliedText);
}

/** Resolve the effective test-group id (DB setting overrides config env). */
function resolveTestGroupId(settings) {
  const fromDb = settings && settings.automatic_update_test_group_id;
  const id = (fromDb && String(fromDb).trim()) || config.trailerTestGroupId || '';
  return id ? String(id).trim() : null;
}

/** A "real command" worth surfacing to the test group (vs. idle chatter). */
function looksLikeTrailerCommand(parsed) {
  return Boolean(parsed.trailerUnit) || Boolean(parsed.action) || Boolean(parsed.conditionText);
}

/** React 👍 on the source message. Never throws. */
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
    // Reactions are optional (older API / not an admin) — low-noise, never break.
    console.warn('[TRAILER] Could not set reaction (non-fatal):', err.message);
  }
}

function reporterName(from) {
  if (!from) return null;
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  return name || (from.username ? `@${from.username}` : null);
}

function eventLabel(type) {
  return type === 'pickup' ? 'pickup' : 'drop-off';
}

/**
 * Short possession+cargo phrase for a confirmation line, e.g. "with driver",
 * "dropped empty", "dropped loaded". Cargo is only shown when known.
 */
function statePhrase(event) {
  const p = event.possession_status;
  const c = event.cargo_status;
  const pLabel = p === 'with_driver' ? 'with driver' : p === 'dropped' ? 'dropped' : 'unknown';
  if (c === 'empty') return `${pLabel} empty`;
  if (c === 'loaded') return `${pLabel} loaded`;
  return pLabel;
}

/**
 * Send ONE confirmation reply to the driver group summarizing every registered
 * pickup/drop-off from the message. Sent ONLY after the hard approval gate
 * passed and the events were actually stored.
 */
async function replyConfirmation(telegram, group, message, events, betaMode) {
  const list = (Array.isArray(events) ? events : [events]).filter(Boolean);
  if (!list.length) return;
  const chatId = group.telegram_group_id;
  const beta = betaMode ? ' (Beta test mode)' : '';

  const lines = [];
  if (list.length === 1) {
    const event = list[0];
    lines.push(`✅ Trailer ${eventLabel(event.event_type)} registered${beta}`, '');
    lines.push(`Trailer: ${event.trailer_unit_number || 'unknown'}`);
    lines.push(`Status: ${statePhrase(event)}`);
    if (event.location_text) lines.push(`Location: ${event.location_text}`);
    if (event.condition_text) lines.push(`Condition: ${event.condition_text}`);
  } else {
    lines.push(`✅ Trailer updates registered${beta}`, '');
    for (const event of list) {
      lines.push(`${event.trailer_unit_number || 'unknown'} — ${eventLabel(event.event_type)} / ${statePhrase(event)}`);
    }
  }
  try {
    await telegram.sendMessage(chatId, lines.join('\n'), {
      reply_to_message_id: Number(message.message_id),
      allow_sending_without_reply: true,
    });
  } catch (err) {
    console.warn('[TRAILER] Could not send confirmation reply (non-fatal):', err.message);
  }
}

/**
 * Report an unconfirmed / unclear trailer candidate to the Automatic Updating
 * (Test) group. Never sent to the driver group. Never throws.
 */
async function reportUnidentified(telegram, group, message, parsed, event, testGroupId, betaMode) {
  if (!testGroupId) return;
  const from = message.from || {};
  const link = buildTelegramMessageUrl(group.telegram_group_id, message.message_id);
  const beta = betaMode ? ' [Beta]' : '';
  const raw = messageText(message);
  const sem = parsed.semantic || null;
  const lines = [
    sem ? `⚠️ Trailer candidate needs review${beta}` : `⚠️ Unidentified trailer command${beta}`,
    '',
    `Group: ${group.group_name || group.telegram_group_id}`,
    `Sender: ${from.username ? '@' + from.username : ''}${from.username ? ' ' : ''}${reporterName(from) || 'unknown'}`,
    `Detected unit: ${parsed.trailerUnit || '—'}`,
    `Type: ${sem?.intent || parsed.eventType}`,
    `Why: ${parsed.reason || 'unclear'}`,
  ];
  if (sem) {
    if (sem.confidence != null) lines.push(`AI confidence: ${sem.confidence}`);
    if (sem.unitEvidence) lines.push(`Unit evidence: ${String(sem.unitEvidence).slice(0, 200)}`);
    if (sem.actionEvidence) lines.push(`Action evidence: ${String(sem.actionEvidence).slice(0, 200)}`);
    lines.push('No status was changed.');
  }
  if (raw) lines.push('', `Message: ${raw.slice(0, 500)}`);
  if (link) lines.push('', link);
  try {
    await telegram.sendMessage(testGroupId, lines.join('\n'), { disable_web_page_preview: true });
    if (event?.id) await db.query('UPDATE trailer_events SET reported_to_test_group = TRUE WHERE id = $1', [event.id]).catch(() => {});
  } catch (err) {
    console.warn('[TRAILER] Could not send test-group report (non-fatal):', err.message);
  }
}

/** Map a parsed.semantic block to the trailer_events audit columns. */
function semanticColumns(parsed, verificationStatus) {
  const sem = parsed.semantic || null;
  if (!sem) return { ai_verification_status: verificationStatus || null };
  return {
    semantic_intent: sem.intent || null,
    semantic_completed: sem.completed != null ? Boolean(sem.completed) : null,
    semantic_confidence: sem.confidence != null ? sem.confidence : null,
    semantic_reason: sem.reason || null,
    unit_grounded: sem.unitGrounded != null ? Boolean(sem.unitGrounded) : null,
    unit_source: sem.unitSource || null,
    unit_evidence: sem.unitEvidence || null,
    action_evidence: sem.actionEvidence || null,
    ai_model: sem.aiModel || null,
    ai_verified_at: sem.verifiedAt || null,
    ai_verification_status: verificationStatus || null,
    raw_ai_result: sem.raw || null,
  };
}

/**
 * Register ONE verified pickup/dropoff: geocode its location (fail-soft,
 * cached), insert the immutable event (review_status='pending' so an admin
 * still accepts / declines / edits it), and advance the trailer's current
 * status. Returns { event, duplicate }.
 */
async function registerPickupDropoff(parsed, ctx) {
  const trailer = await db.ensureTrailerForDetection(parsed.trailerUnit);

  let lat = null;
  let lng = null;
  let locationSource = null;
  let locationConfidence = null;
  let geocodedAt = null;
  let geocodeError = null;
  const locationMissing = !parsed.locationText;
  if (parsed.locationText) {
    const geo = await geocodeTrailerLocation(parsed.locationText, {
      enabled: ctx.settings.geocoding_enabled !== false,
    });
    if (geo) {
      lat = geo.lat;
      lng = geo.lng;
      locationSource = geo.source;
      locationConfidence = geo.confidence;
      if (geo.lat != null && geo.lng != null) geocodedAt = ctx.nowIso;
      if (geo.error) geocodeError = geo.error;
    }
  }

  const { event, duplicate } = await db.insertTrailerEvent({
    trailer_id: trailer?.id || null,
    trailer_unit_number: parsed.trailerUnit,
    event_type: parsed.eventType,
    possession_status: parsed.possessionStatus,
    cargo_status: parsed.cargoStatus,
    confidence: parsed.confidence,
    driver_group_id: ctx.group.id,
    telegram_group_id: ctx.group.telegram_group_id,
    telegram_group_name: ctx.group.group_name,
    driver_profile_id: ctx.profile?.id || null,
    driver_name: ctx.driverName,
    reported_by_telegram_user_id: ctx.from.id || null,
    reported_by_username: ctx.from.username || null,
    reported_by_name: reporterName(ctx.from),
    reported_driver_name_from_message: parsed.reportedDriverName,
    location_text: parsed.locationText,
    location_lat: lat,
    location_lng: lng,
    location_missing: locationMissing,
    location_source: locationSource,
    location_confidence: locationConfidence,
    geocoded_at: geocodedAt,
    geocode_error: geocodeError,
    condition_text: parsed.conditionText,
    event_date_text: parsed.eventDateText,
    event_time: ctx.eventTimeIso,
    telegram_message_id: ctx.message.message_id,
    telegram_media_group_id: ctx.message.media_group_id || null,
    event_index: parsed.eventIndex || 0,
    review_status: 'pending', // auto-detected → awaits admin accept/decline/edit
    evidence: ctx.evidence,
    raw_message_text: ctx.text,
    ai_summary: parsed.method === 'deterministic' ? null : parsed.reason,
    source: 'telegram',
    beta_mode: ctx.betaMode,
    ...semanticColumns(parsed, 'approved'),
  });

  if (!duplicate && event && trailer) await db.applyEventToCurrentStatus(trailer, event);
  return { event, duplicate };
}

/**
 * Register ONE non-state-changing ledger row (mention/review/failed-AI
 * candidate). NEVER touches trailer_current_status, never replies to the
 * driver group. `verificationStatus` labels why it is here: 'review',
 * 'rejected', 'unavailable', 'invalid_response', or null (plain mention).
 */
async function registerUnidentified(parsed, ctx, verificationStatus = null) {
  const trailerId = parsed.trailerUnit ? (await db.getTrailerByUnitNumber(parsed.trailerUnit))?.id || null : null;
  return db.insertTrailerEvent({
    trailer_id: trailerId,
    trailer_unit_number: parsed.trailerUnit,
    event_type: parsed.eventType === 'mention_only' ? 'mention_only' : 'unidentified',
    possession_status: 'unknown', // review rows never assert possession
    cargo_status: 'unknown',
    confidence: parsed.confidence,
    driver_group_id: ctx.group.id,
    telegram_group_id: ctx.group.telegram_group_id,
    telegram_group_name: ctx.group.group_name,
    driver_profile_id: ctx.profile?.id || null,
    driver_name: ctx.driverName,
    reported_by_telegram_user_id: ctx.from.id || null,
    reported_by_username: ctx.from.username || null,
    reported_by_name: reporterName(ctx.from),
    reported_driver_name_from_message: parsed.reportedDriverName,
    location_text: parsed.locationText,
    condition_text: parsed.conditionText,
    event_date_text: parsed.eventDateText,
    event_time: ctx.eventTimeIso,
    telegram_message_id: ctx.message.message_id,
    telegram_media_group_id: ctx.message.media_group_id || null,
    event_index: parsed.eventIndex || 0,
    evidence: ctx.evidence,
    raw_message_text: ctx.text,
    ai_summary: parsed.method === 'deterministic' ? null : parsed.reason,
    unidentified_reason: parsed.reason,
    source: 'telegram',
    beta_mode: ctx.betaMode,
    ...semanticColumns(parsed, verificationStatus),
  });
}

/**
 * Could this deterministic parse become a pickup/drop-off? Any action signal —
 * deterministic action, English action phrase, or a multilingual (uz/ru)
 * action hint — makes the message a state-change candidate that REQUIRES
 * semantic verification.
 */
function hasPotentialAction(parsedList, text) {
  if (parsedList.some((p) => p.eventType === 'pickup' || p.eventType === 'dropoff' || p.action)) return true;
  return Boolean(detectAction(text) || detectMultilingualActionHint(text));
}

/** Business-rule cargo for a VERIFIED event: AI explicit → deterministic → default. */
function resolveVerifiedCargo(aiEvent, detMatch) {
  if (aiEvent.cargoStatus === 'loaded' || aiEvent.cargoStatus === 'empty') return aiEvent.cargoStatus;
  if (detMatch && (detMatch.cargoStatus === 'loaded' || detMatch.cargoStatus === 'empty')) return detMatch.cargoStatus;
  return aiEvent.action === 'dropoff' ? 'empty' : 'unknown';
}

/**
 * Build the registration payload for one AI-verified event, backfilling
 * concrete fields (location/condition/date/reported name) from the matching
 * deterministic segment when the AI left them null.
 */
function buildVerifiedParsed(aiResult, aiEvent, parsedList, eventIndex) {
  const detMatch = parsedList.find((p) => p.trailerUnit === aiEvent.trailerUnit)
    || (parsedList.length === 1 ? parsedList[0] : null);
  const action = aiEvent.action; // gate guarantees pickup|dropoff
  return {
    isTrailerRelated: true,
    eventType: action,
    trailerUnit: aiEvent.trailerUnit,
    action,
    possessionStatus: action === 'pickup' ? 'with_driver' : 'dropped',
    cargoStatus: resolveVerifiedCargo(aiEvent, detMatch),
    locationText: aiEvent.locationText || detMatch?.locationText || null,
    conditionText: aiEvent.conditionText || detMatch?.conditionText || null,
    eventDateText: detMatch?.eventDateText || null,
    reportedDriverName: detMatch?.reportedDriverName || null,
    confidence: aiEvent.confidence,
    reason: aiEvent.reason || 'AI-verified completed action',
    needsReview: false,
    method: 'semantic_ai',
    eventIndex,
    semantic: {
      intent: aiEvent.intent,
      completed: aiEvent.completed,
      confidence: aiEvent.confidence,
      reason: aiEvent.reason,
      unitGrounded: aiEvent.unitGrounded,
      unitSource: aiEvent.unitSource,
      unitEvidence: aiEvent.unitEvidence,
      actionEvidence: aiEvent.actionEvidence,
      aiModel: aiResult.aiModel || null,
      verifiedAt: new Date().toISOString(),
      raw: sanitizeAiResultForStorage(aiResult),
    },
  };
}

/** Review payload for one AI event that did NOT pass the gate. */
function buildReviewParsed(aiResult, aiEvent, gate, eventIndex) {
  return {
    isTrailerRelated: true,
    eventType: 'unidentified',
    trailerUnit: aiEvent.unitGrounded ? aiEvent.trailerUnit : null,
    action: null,
    locationText: aiEvent.locationText || null,
    conditionText: aiEvent.conditionText || null,
    eventDateText: null,
    reportedDriverName: null,
    confidence: aiEvent.confidence,
    reason: `${aiEvent.intent || aiResult.intent}: ${gate.reason}`,
    needsReview: true,
    method: 'semantic_ai',
    eventIndex,
    semantic: {
      intent: aiEvent.intent || aiResult.intent,
      completed: aiEvent.completed,
      confidence: aiEvent.confidence,
      reason: aiEvent.reason || gate.reason,
      unitGrounded: aiEvent.unitGrounded,
      unitSource: aiEvent.unitSource,
      unitEvidence: aiEvent.unitEvidence,
      actionEvidence: aiEvent.actionEvidence,
      aiModel: aiResult.aiModel || null,
      verifiedAt: new Date().toISOString(),
      raw: sanitizeAiResultForStorage(aiResult),
    },
  };
}

/** Bounded, prompt-free copy of the normalized AI result for the audit column. */
function sanitizeAiResultForStorage(aiResult) {
  if (!aiResult || aiResult.status !== 'ok') return null;
  return {
    intent: aiResult.intent,
    action: aiResult.action,
    completed: aiResult.completed,
    language: aiResult.language,
    needsReview: aiResult.needsReview,
    trailerEvents: (aiResult.trailerEvents || []).map((e) => ({
      trailerUnit: e.trailerUnit,
      intent: e.intent,
      action: e.action,
      completed: e.completed,
      unitGrounded: e.unitGrounded,
      unitSource: e.unitSource,
      unitEvidence: e.unitEvidence,
      actionEvidence: e.actionEvidence,
      possessionStatus: e.possessionStatus,
      cargoStatus: e.cargoStatus,
      confidence: e.confidence,
      reason: e.reason,
    })),
  };
}

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
      } else if (gate.disposition === 'review') {
        const parsed = buildReviewParsed(aiResult, aiEvent, gate, i);
        const { event, duplicate } = await registerUnidentified(parsed, ctx, 'review');
        if (duplicate) anyDuplicate = true;
        else if (event) reviewItems.push({ parsed, event });
      }
      // disposition === 'ignore' → silent skip (questions, discussion, low confidence)
    }

    // ── 6. driver-group confirmation + reaction: ONLY for registered events ──
    if (registered.length) {
      if (settings.send_driver_group_confirmation !== false) {
        await replyConfirmation(telegram, group, message, registered, betaMode);
      }
      if (settings.send_reaction !== false) {
        await reactThumbsUp(telegram, group.telegram_group_id, message.message_id);
      }
    }

    // ── 7. review items → Automatic Updating (Test) group (grounded/strong only) ──
    let reportedToTest = false;
    for (const { parsed, event } of reviewItems) {
      const strong = Boolean(parsed.trailerUnit) || Boolean(parsed.semantic?.actionEvidence);
      if (strong && testGroupId) {
        await reportUnidentified(telegram, group, message, parsed, event, testGroupId, betaMode);
        reportedToTest = true;
      }
    }

    if (!registered.length && !reviewItems.length) {
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
        intent: aiResult.intent,
      };
    }
    return {
      review: true,
      intent: aiResult.intent,
      eventId: reviewItems[0].event.id,
      reportedToTest,
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
  let anyDuplicate = false;
  for (const parsed of parsedList) {
    if (parsed.eventType === 'pickup' || parsed.eventType === 'dropoff') {
      const { event, duplicate } = await registerPickupDropoff(parsed, ctx);
      if (duplicate) anyDuplicate = true;
      else if (event) registered.push(event);
    } else {
      const { event, duplicate } = await registerUnidentified(parsed, ctx);
      if (duplicate) anyDuplicate = true;
      else if (event) reportedUnids.push({ parsed, event });
    }
  }
  if (registered.length) {
    if (ctx.settings.send_driver_group_confirmation !== false) {
      await replyConfirmation(telegram, group, message, registered, betaMode);
    }
    if (ctx.settings.send_reaction !== false) {
      await reactThumbsUp(telegram, group.telegram_group_id, message.message_id);
    }
  }
  let reportedToTest = false;
  for (const { parsed, event } of reportedUnids) {
    if (looksLikeTrailerCommand(parsed) && testGroupId) {
      await reportUnidentified(telegram, group, message, parsed, event, testGroupId, betaMode);
      reportedToTest = true;
    }
  }
  if (!registered.length && !reportedUnids.length) return { skipped: 'duplicate' };
  if (registered.length) {
    const first = registered[0];
    return {
      registered: true,
      registeredCount: registered.length,
      eventType: first.event_type,
      eventId: first.id,
      unit: first.trailer_unit_number,
      events: registered.map((e) => ({ id: e.id, eventType: e.event_type, unit: e.trailer_unit_number })),
      legacy: true,
    };
  }
  return { unidentified: true, eventType: reportedUnids[0].event.event_type, eventId: reportedUnids[0].event.id, reportedToTest };
}

module.exports = {
  handleTrailerGroupMessage,
  // exported for tests
  isTrailerCandidate,
  isTrailerCandidateMessage,
  extractEvidence,
  statePhrase,
  resolveTestGroupId,
  looksLikeTrailerCommand,
  hasPotentialAction,
  buildVerifiedParsed,
  buildReviewParsed,
  resolveVerifiedCargo,
  sanitizeAiResultForStorage,
};
