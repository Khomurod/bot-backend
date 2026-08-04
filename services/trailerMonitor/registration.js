'use strict';

/**
 * Writing what the monitor concluded into the ledger.
 *
 * Three destinations, and the difference matters: a VERIFIED pickup/drop-off
 * becomes an immutable event that advances current status; a planned action
 * becomes an instruction that does NOT; anything unconfirmed becomes a review
 * record. A detection RESOLVES against the authoritative master list and can
 * never add to it — an unknown unit becomes a review record instead.
 */

const db = require('../../database/db');
const { geocodeTrailerLocation } = require('../trailerGeocodeService');
const { reporterName, semanticColumns } = require('./eventColumns');
const { resolveOfficialTrailerForDetection } = require('../trailerMasterList/detection');

/**
 * Register ONE verified pickup/dropoff: geocode its location (fail-soft,
 * cached), insert the immutable event (review_status='pending' so an admin
 * still accepts / declines / edits it), and advance the trailer's current
 * status. Returns { event, duplicate }.
 */
async function registerPickupDropoff(parsed, ctx) {
  // Resolves to an ACTIVE OFFICIAL trailer, or records review evidence and
  // returns null. A detection must never add to the master list, so an
  // unresolved unit registers nothing.
  const trailer = await resolveOfficialTrailerForDetection(parsed, ctx);
  if (!trailer) return { event: null, duplicate: false, unmatched: true };
  let activeRental = null;
  try { if (trailer?.id && typeof db.getActiveRentalForTrailer === 'function') activeRental = await db.getActiveRentalForTrailer(trailer.id); }
  catch { activeRental = null; }
  // A completed action may FULFILL an earlier planned instruction for this
  // trailer (e.g. "Dropped" after "Trailer drop-off address: 1375 Jersey Ave").
  // Look it up so we can (a) backfill a missing location with the planned
  // destination and (b) mark the instruction confirmed + link this event.
  let pendingInstruction = null;
  try {
    if (typeof db.getLatestPendingInstruction === 'function' && parsed.trailerUnit && parsed.eventType) {
      pendingInstruction = await db.getLatestPendingInstruction(parsed.trailerUnit, parsed.eventType);
    }
  } catch { pendingInstruction = null; }

  // Backfill the location from the planned instruction when the completion
  // message itself carried none ("Dropped" with no address).
  if (!parsed.locationText && pendingInstruction?.planned_location) {
    parsed = { ...parsed, locationText: pendingInstruction.planned_location };
  }

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
    ai_summary: activeRental ? `Rental conflict: active agreement ${activeRental.agreement_number}; review required. ${parsed.reason || ''}`.trim() : (parsed.method === 'deterministic' ? null : parsed.reason),
    source: 'telegram',
    beta_mode: ctx.betaMode,
    ...semanticColumns(parsed, 'approved'),
  });

  if (!duplicate && event && trailer && !activeRental) await db.applyEventToCurrentStatus(trailer, event);

  // Confirm the fulfilled instruction (best-effort; never blocks registration).
  if (!activeRental && !duplicate && event && pendingInstruction?.id && typeof db.markPendingInstructionConfirmed === 'function') {
    try { await db.markPendingInstructionConfirmed(pendingInstruction.id, { confirmedEventId: event.id }); } catch { /* ignore */ }
  }
  return { event, duplicate };
}

/**
 * Record ONE planned/assigned pickup or drop-off INSTRUCTION (not a completed
 * action). Never changes trailer_current_status and never sends to manual
 * review — it silently waits for a later message that confirms the physical
 * action. Returns { instruction, duplicate }. Resilient to a DB that predates
 * the pending-instructions table (guards the method + swallows errors).
 */
async function registerPlannedInstruction(parsed, ctx) {
  if (typeof db.insertTrailerPendingInstruction !== 'function') return { instruction: null, duplicate: false };
  const action = parsed.instructionAction || parsed.action;
  if (!parsed.trailerUnit || (action !== 'pickup' && action !== 'dropoff')) {
    return { instruction: null, duplicate: false };
  }
  try {
    // A planned instruction for an unknown unit must not create the trailer
    // either; the evidence is queued for master-list review instead.
    const trailer = await resolveOfficialTrailerForDetection(parsed, ctx);
    if (!trailer) return { instruction: null, duplicate: false, unmatched: true };
    return await db.insertTrailerPendingInstruction({
      trailer_id: trailer?.id || null,
      trailer_unit_number: parsed.trailerUnit,
      planned_action: action,
      planned_location: parsed.locationText || null,
      driver_group_id: ctx.group.id,
      telegram_group_id: ctx.group.telegram_group_id,
      telegram_group_name: ctx.group.group_name,
      instruction_source_message_id: ctx.message.message_id,
      reported_by_telegram_user_id: ctx.from.id || null,
      reported_by_username: ctx.from.username || null,
      reported_by_name: reporterName(ctx.from),
      semantic_intent: parsed.semantic?.intent || null,
      semantic_confidence: parsed.semantic?.confidence != null ? parsed.semantic.confidence : parsed.confidence,
      ai_reason: parsed.reason || null,
      raw_message_text: ctx.text,
    });
  } catch (err) {
    console.warn('[TRAILER] Could not store planned instruction (non-fatal):', err.message);
    return { instruction: null, duplicate: false };
  }
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

module.exports = {
  registerPickupDropoff,
  registerPlannedInstruction,
  registerUnidentified,
};
