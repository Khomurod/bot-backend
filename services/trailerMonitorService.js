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
const { parseTrailerMessage, hasTrailerKeyword, extractUnitNumber, shouldUseAiFallback } = require('./trailerMessageParser');
const { classifyTrailerMessageWithAi } = require('./trailerClassifier');
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
  return {
    isTrailerRelated: true,
    eventType: ai.eventType,
    trailerUnit: ai.trailerUnit || det.trailerUnit,
    action: ai.action,
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

/** Best-effort geocode of a location string → { lat, lng } or null. */
async function geocodeLocation(locationText) {
  if (!locationText) return null;
  try {
    // Lazy require: keeps the geocoder (and its network deps) off the hot path
    // for the majority of messages that never geocode.
    const { geocodePlace } = require('./etaRoutingService');
    const geo = await geocodePlace(locationText);
    if (geo && Number.isFinite(Number(geo.lat)) && Number.isFinite(Number(geo.lng))) {
      return { lat: Number(geo.lat), lng: Number(geo.lng) };
    }
  } catch (err) {
    console.warn('[TRAILER] geocode failed (non-fatal):', err.message);
  }
  return null;
}

function reporterName(from) {
  if (!from) return null;
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  return name || (from.username ? `@${from.username}` : null);
}

/**
 * Send a short confirmation reply to the driver group for a registered event.
 */
async function replyConfirmation(telegram, group, message, event, betaMode) {
  const chatId = group.telegram_group_id;
  const label = event.event_type === 'pickup' ? 'pickup' : 'drop-off';
  const beta = betaMode ? ' (Beta test mode)' : '';
  const lines = [`✅ Trailer ${label} registered${beta}`, ''];
  lines.push(`Trailer: ${event.trailer_unit_number || 'unknown'}`);
  if (event.location_text) lines.push(`Location: ${event.location_text}`);
  if (event.condition_text) lines.push(`Condition: ${event.condition_text}`);
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
 * Main entry point. `group` is the DB group row (must be an active driver group);
 * `message` is ctx.message. Returns a small result object for tests; swallows
 * all errors so it can be called detached.
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

    // ── parse (deterministic → AI fallback) ──
    let parsed = parseTrailerMessage(text);
    if (!parsed.isTrailerRelated) return { skipped: 'not-trailer' };

    if (settings.ai_fallback_enabled !== false && shouldUseAiFallback(parsed)) {
      const ai = await classifyTrailerMessageWithAi(text, []);
      parsed = mergeResults(parsed, ai);
    }

    const testGroupId = resolveTestGroupId(settings);
    const from = message.from || {};
    const eventTimeIso = Number.isFinite(message.date) ? new Date(message.date * 1000).toISOString() : new Date().toISOString();

    // Resolve driver profile for the group (best-effort).
    let profile = null;
    try { profile = await db.getDriverProfileByGroupId(group.id); } catch { /* ignore */ }
    const driverName = profile
      ? [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim() || group.group_name
      : group.group_name;

    // ── real pickup / dropoff ──
    if (parsed.eventType === 'pickup' || parsed.eventType === 'dropoff') {
      const trailer = await db.ensureTrailerForDetection(parsed.trailerUnit);

      // Location: text first; geocode if enabled and text present.
      let lat = null;
      let lng = null;
      const locationMissing = !parsed.locationText;
      if (settings.geocoding_enabled !== false && parsed.locationText) {
        const geo = await geocodeLocation(parsed.locationText);
        if (geo) { lat = geo.lat; lng = geo.lng; }
      }

      const { event, duplicate } = await db.insertTrailerEvent({
        trailer_id: trailer?.id || null,
        trailer_unit_number: parsed.trailerUnit,
        event_type: parsed.eventType,
        confidence: parsed.confidence,
        driver_group_id: group.id,
        telegram_group_id: group.telegram_group_id,
        telegram_group_name: group.group_name,
        driver_profile_id: profile?.id || null,
        driver_name: driverName,
        reported_by_telegram_user_id: from.id || null,
        reported_by_username: from.username || null,
        reported_by_name: reporterName(from),
        reported_driver_name_from_message: parsed.reportedDriverName,
        location_text: parsed.locationText,
        location_lat: lat,
        location_lng: lng,
        location_missing: locationMissing,
        condition_text: parsed.conditionText,
        event_date_text: parsed.eventDateText,
        event_time: eventTimeIso,
        telegram_message_id: message.message_id,
        telegram_media_group_id: message.media_group_id || null,
        evidence,
        raw_message_text: text,
        ai_summary: parsed.method === 'deterministic' ? null : parsed.reason,
        source: 'telegram',
        beta_mode: betaMode,
      });

      if (duplicate || !event) return { skipped: 'duplicate', eventType: parsed.eventType };

      // Update current status + reply + react (needs_review trailers are still
      // tracked; the trailer row carries the needs_review flag).
      if (trailer) await db.applyEventToCurrentStatus(trailer, event);

      if (settings.send_driver_group_confirmation !== false) {
        await replyConfirmation(telegram, group, message, event, betaMode);
      }
      if (settings.send_reaction !== false) {
        await reactThumbsUp(telegram, group.telegram_group_id, message.message_id);
      }
      return { registered: true, eventType: parsed.eventType, eventId: event.id, unit: parsed.trailerUnit };
    }

    // ── mention_only / unidentified ──
    // Store the event for the ledger, but do NOT confirm in the driver group.
    const reportToTest = looksLikeTrailerCommand(parsed) && Boolean(testGroupId);
    const { event, duplicate } = await db.insertTrailerEvent({
      trailer_id: parsed.trailerUnit ? (await db.getTrailerByUnitNumber(parsed.trailerUnit))?.id || null : null,
      trailer_unit_number: parsed.trailerUnit,
      event_type: parsed.eventType === 'mention_only' ? 'mention_only' : 'unidentified',
      confidence: parsed.confidence,
      driver_group_id: group.id,
      telegram_group_id: group.telegram_group_id,
      telegram_group_name: group.group_name,
      driver_profile_id: profile?.id || null,
      driver_name: driverName,
      reported_by_telegram_user_id: from.id || null,
      reported_by_username: from.username || null,
      reported_by_name: reporterName(from),
      reported_driver_name_from_message: parsed.reportedDriverName,
      location_text: parsed.locationText,
      condition_text: parsed.conditionText,
      event_date_text: parsed.eventDateText,
      event_time: eventTimeIso,
      telegram_message_id: message.message_id,
      telegram_media_group_id: message.media_group_id || null,
      evidence,
      raw_message_text: text,
      ai_summary: parsed.method === 'deterministic' ? null : parsed.reason,
      unidentified_reason: parsed.reason,
      source: 'telegram',
      beta_mode: betaMode,
    });

    if (duplicate || !event) return { skipped: 'duplicate', eventType: parsed.eventType };

    if (reportToTest) {
      await reportUnidentified(telegram, group, message, parsed, event, testGroupId, betaMode);
    }
    return { unidentified: true, eventType: event.event_type, eventId: event.id, reportedToTest: reportToTest };
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
  resolveTestGroupId,
  looksLikeTrailerCommand,
};
