/**
 * Telegram detection -> master-list resolution.
 *
 * The single seam between AI detection and the authoritative trailer master
 * list. A detected unit number can end in exactly one of three ways, and NONE
 * of them creates a trailer:
 *
 *   1. Resolves to an ACTIVE OFFICIAL trailer -> return it; the caller registers
 *      the event exactly as before. Known-trailer behavior is unchanged.
 *   2. Resolves to a pending-review / archived / merged trailer -> the message
 *      is preserved as review evidence linked to that trailer, but the trailer
 *      is NOT reactivated and NOT added back to the active master list, and no
 *      event is registered. Returns null.
 *   3. Resolves to nothing -> an unmatched mention is queued for review.
 *      Returns null.
 *
 * Callers treat null as "do not register" — never as "create it".
 */
'use strict';

// Reached through the database façade (not the sub-modules) because that is the
// seam the rest of the monitor already depends on and stubs.
const db = require('../../database/db');
const { buildTelegramMessageUrl } = require('../telegramUrl');

/**
 * Evidence for the review queue, assembled from the parsed detection and the
 * handler context. Best-effort: a missing field must never break ingestion.
 */
function mentionEvidence(parsed, ctx, trailer) {
  let link = null;
  try {
    link = buildTelegramMessageUrl(ctx?.group?.telegram_group_id, ctx?.message?.message_id);
  } catch (_) {
    link = null;
  }
  return {
    unit_number: parsed.trailerUnit,
    raw_unit_number: parsed.rawTrailerUnit || parsed.trailerUnit,
    telegram_group_id: ctx?.group?.telegram_group_id ?? null,
    telegram_group_title: ctx?.group?.group_name ?? null,
    telegram_message_id: ctx?.message?.message_id ?? null,
    telegram_message_link: link,
    sender_name: ctx?.driverName || null,
    sender_username: ctx?.from?.username || null,
    message_text: ctx?.text || null,
    detected_at: ctx?.eventTimeIso || null,
    ai_confidence: parsed.semantic?.confidence ?? parsed.confidence ?? null,
    extracted_action: parsed.eventType || parsed.instructionAction || parsed.action || null,
    extracted_location: parsed.locationText || null,
    raw_ai_result: parsed.semantic?.raw || null,
    linked_trailer_id: trailer?.id || null,
  };
}

/**
 * Resolve a detection to an ACTIVE OFFICIAL trailer, or record review evidence
 * and return null.
 *
 * Fail-soft by design: if queueing the mention fails, ingestion still declines
 * to register the event. Losing a review record is recoverable; inventing an
 * asset on the master list is not.
 *
 * @param {object} parsed parsed detection ({ trailerUnit, eventType, ... })
 * @param {object} ctx    Telegram handler context ({ group, message, from, ... })
 * @returns {Promise<object|null>} the official trailer, or null
 */
async function resolveOfficialTrailerForDetection(parsed, ctx) {
  const { trailer, official } = await db.resolveTrailerByUnitOrAlias(parsed?.trailerUnit);
  if (trailer && official) return trailer;

  try {
    await db.recordUnmatchedMention(mentionEvidence(parsed, ctx, trailer));
  } catch (error) {
    console.warn('[TRAILER] Could not queue unmatched mention (non-fatal):', error.message);
  }
  return null;
}

module.exports = { resolveOfficialTrailerForDetection, mentionEvidence };
