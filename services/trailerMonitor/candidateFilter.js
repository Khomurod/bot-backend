'use strict';

/**
 * The cheap, network-free gate in front of the trailer monitor.
 *
 * Every message in an active driver group reaches this code, so it must stay
 * fast and must never call out: keywords, unit numbers, multilingual action
 * hints, and reply/photo context only. Anything it lets through pays for the
 * full context collection and the AI verification behind it.
 */

const config = require('../../config/config');
const {
  hasTrailerKeyword, extractUnitNumber, detectAction, detectMultilingualActionHint,
} = require('../trailerMessageParser');
const { photoDescriptor } = require('../trailerVisionService');

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

/**
 * Silent driver-group monitoring (default ON). When enabled, the trailer monitor
 * NEVER replies or reacts in the driver group — it analyzes and registers
 * silently. This overrides the older send_driver_group_confirmation /
 * send_reaction toggles: those only take effect when silent mode is explicitly
 * turned off. The internal Automatic Updating (Test) group is unaffected.
 */
function isSilentDriverGroup(settings) {
  return !settings || settings.silent_driver_group_monitoring !== false;
}

module.exports = {
  messageText,
  extractEvidence,
  isTrailerCandidate,
  isTrailerCandidateMessage,
  resolveTestGroupId,
  looksLikeTrailerCommand,
  isSilentDriverGroup,
};
