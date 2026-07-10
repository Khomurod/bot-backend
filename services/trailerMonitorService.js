/**
 * Trailer Tracking (Beta) — Telegram monitor.
 *
 * Called (detached, best-effort) from the driver-group message pipeline for
 * every message in an active driver group. It:
 *   1. cheap-filters out non-trailer messages,
 *   2. parses deterministically, with an AI fallback for messy input,
 *   3. for a clear pickup/dropoff: registers an immutable event, updates the
 *      trailer's current status, and replies to + reacts on the original message,
 *   4. for an unclear/mention-only "trailer command": records it and reports it
 *      to the Automatic Updating (Test) group for review — NOT to the driver group.
 *
 * Dedupe is guaranteed by the DB unique index on (telegram_group_id,
 * telegram_message_id): the same message can never create two events, so a
 * duplicate update is a no-op and never re-replies or re-reports.
 *
 * NEVER throws to its caller — a trailer-monitor failure must not affect any
 * other bot behavior. No secrets are logged.
 */
const db = require('../database/db');
const config = require('../config/config');
const {
  parseTrailerMessage, parseTrailerMessageEvents,
  hasTrailerKeyword, extractUnitNumber, shouldUseAiFallback,
} = require('./trailerMessageParser');
const { classifyTrailerMessageWithAi } = require('./trailerClassifier');
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

/** Cheap pre-filter: is this worth parsing at all? */
function isTrailerCandidate(text) {
  if (!text) return false;
  return hasTrailerKeyword(text) || Boolean(extractUnitNumber(text));
}

/**
 * Merge the deterministic result with an AI result. Trust the deterministic
 * pass for confident actions; otherwise prefer the AI's classification but keep
 * any concrete field the AI left null. Grounded-unit rule is enforced in the
 * classifier, so a merged action always has a real unit.
 */
function mergeResults(det, ai) {
  if (!ai) return det;
  // A confident deterministic action wins.
  if ((det.eventType === 'pickup' || det.eventType === 'dropoff') && det.confidence >= 75) {
    return {
      ...det,
      locationText: det.locationText || ai.locationText,
      conditionText: det.conditionText || ai.conditionText,
      eventDateText: det.eventDateText || ai.eventDateText,
      reportedDriverName: det.reportedDriverName || ai.reportedDriverName,
    };
  }
  // Otherwise take AI's classification, backfilling from the deterministic pass.
  // possession follows the (possibly AI-changed) action; cargo keeps the
  // deterministic text signal ("loaded"/"empty"), else defaults by action —
  // AI never overrides a clear deterministic loaded/empty read.
  const aiAction = ai.eventType === 'pickup' ? 'pickup' : ai.eventType === 'dropoff' ? 'dropoff' : null;
  const possessionStatus = aiAction === 'pickup' ? 'with_driver' : aiAction === 'dropoff' ? 'dropped' : 'unknown';
  const detHadExplicitCargo = det.cargoStatus === 'loaded' || det.cargoStatus === 'empty';
  const cargoStatus = detHadExplicitCargo
    ? det.cargoStatus
    : (aiAction === 'dropoff' ? 'empty' : 'unknown');
  return {
    isTrailerRelated: true,
    eventType: ai.eventType,
    trailerUnit: ai.trailerUnit || det.trailerUnit,
    action: ai.action,
    possessionStatus,
    cargoStatus,
    locationText: ai.locationText || det.locationText,
    conditionText: ai.conditionText || det.conditionText,
    eventDateText: ai.eventDateText || det.eventDateText,
    reportedDriverName: ai.reportedDriverName || det.reportedDriverName,
    confidence: Math.max(ai.confidence, det.confidence),
    reason: ai.reason || det.reason,
    needsReview: ai.needsReview,
    method: 'ai+deterministic',
    aiModel: ai.aiModel || null,
  };
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
 * pickup/drop-off from the message. A single-trailer message keeps the detailed
 * Location/Condition lines; a multi-trailer message lists one line per trailer.
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
 * Report an unidentified / unclear trailer command to the Automatic Updating
 * (Test) group. Never sent to the driver group. Never throws.
 */
async function reportUnidentified(telegram, group, message, parsed, event, testGroupId, betaMode) {
  if (!testGroupId) return;
  const from = message.from || {};
  const link = buildTelegramMessageUrl(group.telegram_group_id, message.message_id);
  const beta = betaMode ? ' [Beta]' : '';
  const raw = messageText(message);
  const lines = [
    `⚠️ Unidentified trailer command${beta}`,
    '',
    `Group: ${group.group_name || group.telegram_group_id}`,
    `Sender: ${from.username ? '@' + from.username : ''}${from.username ? ' ' : ''}${reporterName(from) || 'unknown'}`,
    `Detected unit: ${parsed.trailerUnit || '—'}`,
    `Type: ${parsed.eventType}`,
    `Why: ${parsed.reason || 'unclear'}`,
  ];
  if (raw) lines.push('', `Message: ${raw.slice(0, 500)}`);
  if (link) lines.push('', link);
  try {
    await telegram.sendMessage(testGroupId, lines.join('\n'), { disable_web_page_preview: true });
    if (event?.id) await db.query('UPDATE trailer_events SET reported_to_test_group = TRUE WHERE id = $1', [event.id]).catch(() => {});
  } catch (err) {
    console.warn('[TRAILER] Could not send test-group report (non-fatal):', err.message);
  }
}

/**
 * Register ONE parsed pickup/dropoff: geocode its location (fail-soft, cached),
 * insert the immutable event (review_status='pending' so an admin accepts /
 * declines / edits it), and advance the trailer's current status. Returns
 * { event, duplicate }.
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
  });

  if (!duplicate && event && trailer) await db.applyEventToCurrentStatus(trailer, event);
  return { event, duplicate };
}

/** Register ONE mention_only/unidentified event (ledger only, no driver reply). */
async function registerUnidentified(parsed, ctx) {
  const trailerId = parsed.trailerUnit ? (await db.getTrailerByUnitNumber(parsed.trailerUnit))?.id || null : null;
  return db.insertTrailerEvent({
    trailer_id: trailerId,
    trailer_unit_number: parsed.trailerUnit,
    event_type: parsed.eventType === 'mention_only' ? 'mention_only' : 'unidentified',
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
  });
}

/**
 * Main entry point. `group` is the DB group row (must be an active driver group);
 * `message` is ctx.message. ONE message may register several trailers (each an
 * event with its own event_index); a single confirmation reply summarizes them
 * all and the message is reacted to once. Returns a small result object for
 * tests; swallows all errors so it can be called detached.
 */
async function handleTrailerGroupMessage(telegram, group, message) {
  try {
    if (!telegram || !group || !message) return { skipped: 'missing-args' };
    // Never react to the bot's own messages.
    if (message.from?.is_bot) return { skipped: 'from-bot' };

    const text = messageText(message);
    const evidence = extractEvidence(message);
    // Photos with no caption still can't be parsed deterministically; require a
    // trailer signal in text/caption to avoid touching every random photo.
    if (!isTrailerCandidate(text)) return { skipped: 'not-trailer' };

    const settings = await db.getTrailerSettings();
    if (!settings || settings.enabled === false) return { skipped: 'disabled' };
    const betaMode = settings.beta_mode !== false;

    // ── parse: multi-event first; AI fallback only for a single uncertain event ──
    let parsedList = parseTrailerMessageEvents(text);
    if (parsedList.length === 1) {
      let parsed = parsedList[0];
      if (!parsed.isTrailerRelated) return { skipped: 'not-trailer' };
      if (settings.ai_fallback_enabled !== false && shouldUseAiFallback(parsed)) {
        const ai = await classifyTrailerMessageWithAi(text, []);
        parsed = mergeResults(parsed, ai);
      }
      parsedList = [parsed];
    } else {
      parsedList = parsedList.filter((p) => p.isTrailerRelated);
      if (!parsedList.length) return { skipped: 'not-trailer' };
    }

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

    const registered = [];   // newly inserted pickup/dropoff events
    const reportedUnids = []; // { parsed, event } for test-group reporting
    let anyDuplicate = false;

    for (const parsed of parsedList) {
      if (!parsed.isTrailerRelated) continue;
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

    // ── driver-group confirmation + reaction: exactly once for the message ──
    if (registered.length) {
      if (settings.send_driver_group_confirmation !== false) {
        await replyConfirmation(telegram, group, message, registered, betaMode);
      }
      if (settings.send_reaction !== false) {
        await reactThumbsUp(telegram, group.telegram_group_id, message.message_id);
      }
    }

    // ── report unclear commands to the Automatic-Updating (Test) group ──
    let reportedToTest = false;
    for (const { parsed, event } of reportedUnids) {
      if (looksLikeTrailerCommand(parsed) && testGroupId) {
        await reportUnidentified(telegram, group, message, parsed, event, testGroupId, betaMode);
        reportedToTest = true;
      }
    }

    if (!registered.length && !reportedUnids.length) {
      return { skipped: 'duplicate' };
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
        unidentifiedCount: reportedUnids.length,
      };
    }
    const firstUnid = reportedUnids[0].event;
    return {
      unidentified: true,
      eventType: firstUnid.event_type,
      eventId: firstUnid.id,
      reportedToTest,
    };
  } catch (err) {
    console.error('[TRAILER] handleTrailerGroupMessage failed:', err.message);
    return { error: err.message };
  }
}

module.exports = {
  handleTrailerGroupMessage,
  // exported for tests
  isTrailerCandidate,
  extractEvidence,
  mergeResults,
  statePhrase,
  resolveTestGroupId,
  looksLikeTrailerCommand,
};
