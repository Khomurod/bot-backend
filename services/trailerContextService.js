/**
 * Trailer context collection — gathers everything the semantic verifier needs
 * to understand what a driver-group message actually MEANS before any trailer
 * status can change:
 *
 *   - current message text/caption + sender + timestamp,
 *   - the replied-to message (text, caption, sender, photo metadata),
 *   - vision-extracted text/units from the current and replied-to images,
 *   - a small bounded window of recent group messages (in-memory buffer only —
 *     no chat-history download, nothing extra is persisted),
 *   - every candidate trailer unit found in that context, each grounded to its
 *     source, plus the current known state of grounded units.
 *
 * Privacy/cost bounds: at most RECENT_MESSAGE_LIMIT recent messages, each
 * truncated; at most the two relevant images are vision-analyzed (cached by
 * file_unique_id inside trailerVisionService). Never throws.
 */
const db = require('../database/db');
const recentMessageBuffer = require('./recentMessageBuffer');
const {
  extractUnitNumber, findUnitTokens, hasTrailerKeyword,
} = require('./trailerMessageParser');
const { extractTrailerUnitsFromTelegramImage, photoDescriptor } = require('./trailerVisionService');
const { isValidTrailerUnitFormat, isNonTrailerContextNumber } = require('./trailerUnitValidation');

const RECENT_MESSAGE_LIMIT = 5;
const RECENT_MESSAGE_MAX_CHARS = 300;

function senderInfo(from) {
  if (!from) return null;
  return {
    telegramUserId: from.id != null ? String(from.id) : null,
    username: from.username || null,
    firstName: from.first_name || null,
    lastName: from.last_name || null,
    name: [from.first_name, from.last_name].filter(Boolean).join(' ').trim()
      || (from.username ? `@${from.username}` : null),
    isBot: Boolean(from.is_bot),
  };
}

/** Detect the rough language of a short chat message (heuristic, best-effort). */
function detectLanguage(text) {
  const t = String(text || '');
  if (!t) return null;
  if (/[а-яё]/i.test(t)) {
    // Cyrillic — Uzbek Cyrillic uses ў қ ғ ҳ; otherwise assume Russian.
    return /[ўқғҳ]/i.test(t) ? 'uz-Cyrl' : 'ru';
  }
  if (/\b(?:oldim|olaman|olasiz|olib|tashladim|tashlaysiz|qoldirdim|shu|ni|va|uchun|qildim)\b/i.test(t)) return 'uz';
  if (/[a-z]/i.test(t)) return 'en';
  return null;
}

/** Grounded unit candidates from one text source. */
function unitsFromText(text, source) {
  const out = [];
  if (!text) return out;
  for (const tok of findUnitTokens(text)) {
    out.push({ value: tok.unit, source, evidence: null });
  }
  const single = extractUnitNumber(text);
  if (single && !out.some((u) => u.value === single)) {
    out.push({ value: single, source, evidence: null });
  }
  return out;
}

/**
 * Collect the full context for one driver-group message.
 *
 * @param telegram Telegraf telegram client (for image download); may be null.
 * @param group    DB group row ({ id, telegram_group_id, group_name }).
 * @param message  Telegram message object (ctx.message).
 * @param opts     { visionEnabled = true, driverProfile = null }
 *
 * Returns a context object; never throws (vision failures degrade to nulls).
 */
async function collectTrailerContext(telegram, group, message, opts = {}) {
  const visionEnabled = opts.visionEnabled !== false;
  const currentText = String(message?.text || '').trim() || null;
  const currentCaption = String(message?.caption || '').trim() || null;
  const replied = message?.reply_to_message || null;
  const repliedText = String(replied?.text || '').trim() || null;
  const repliedCaption = String(replied?.caption || '').trim() || null;

  const context = {
    currentText,
    currentCaption,
    messageText: currentText || currentCaption,
    sender: senderInfo(message?.from),
    group: group ? {
      id: group.id,
      telegramGroupId: group.telegram_group_id,
      name: group.group_name || null,
    } : null,
    driver: null,
    repliedMessage: replied ? {
      text: repliedText,
      caption: repliedCaption,
      sender: senderInfo(replied.from),
      hasPhoto: Boolean(photoDescriptor(replied)),
      messageId: replied.message_id || null,
    } : null,
    currentImage: null,   // vision result for the current message's photo
    repliedImage: null,   // vision result for the replied-to message's photo
    recentMessages: [],   // [{ sender, text }], oldest first, bounded
    candidateUnits: [],   // [{ value, source, evidence }]
    existingTrailerStates: [], // current known state for grounded units
    language: detectLanguage(currentText || currentCaption),
    timestamp: Number.isFinite(message?.date)
      ? new Date(message.date * 1000).toISOString()
      : new Date().toISOString(),
  };

  // ── driver profile + sender role (best-effort) ──
  // senderRole gives the AI a "who is talking" hint: the group's own DRIVER, or a
  // NON-DRIVER (dispatcher / trailer specialist / updater / manager). A driver
  // saying "done/dropped" may confirm completion; a non-driver giving an address
  // is usually an instruction. Never trusted alone — just context.
  context.senderRole = 'unknown';
  if (group?.id) {
    try {
      const profile = await db.getDriverProfileByGroupId(group.id);
      if (profile) {
        context.driver = {
          id: profile.id,
          name: [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim() || null,
        };
        const senderTgId = context.sender?.telegramUserId;
        const profileTgId = profile.telegram_user_id != null ? String(profile.telegram_user_id) : null;
        if (senderTgId && profileTgId) {
          context.senderRole = senderTgId === profileTgId ? 'driver' : 'non_driver';
        } else if (senderTgId && !profileTgId) {
          context.senderRole = 'unknown';
        }
      }
    } catch { /* ignore */ }
  }
  if (context.sender) context.sender.role = context.senderRole;

  // ── recent surrounding messages (bounded, in-memory only) ──
  try {
    const recent = recentMessageBuffer.getRecentMessages(group?.telegram_group_id);
    const all = recent.map((m) => ({ sender: m.sender, text: String(m.text || '').slice(0, RECENT_MESSAGE_MAX_CHARS) }));
    // The buffer may already contain the current message (the group handler
    // records before/around this call) — drop it and keep the last N before it.
    const currentBody = (currentText || currentCaption || '').slice(0, RECENT_MESSAGE_MAX_CHARS);
    if (all.length && currentBody && all[all.length - 1].text === currentBody) all.pop();
    context.recentMessages = all.slice(-RECENT_MESSAGE_LIMIT);
  } catch { context.recentMessages = []; }

  // ── vision extraction (cached by file_unique_id; fail-soft) ──
  if (visionEnabled && telegram) {
    const currentPhoto = photoDescriptor(message);
    const repliedPhoto = replied ? photoDescriptor(replied) : null;
    if (currentPhoto) {
      context.currentImage = await extractTrailerUnitsFromTelegramImage(telegram, {
        ...currentPhoto, source: 'current_image',
      });
    }
    if (repliedPhoto) {
      context.repliedImage = await extractTrailerUnitsFromTelegramImage(telegram, {
        ...repliedPhoto, source: 'replied_image',
      });
    }
  }

  // ── candidate units, each tied to its grounded source ──
  const candidates = [
    ...unitsFromText(currentText, 'current_text'),
    ...unitsFromText(currentCaption, 'current_caption'),
    ...unitsFromText(repliedText, 'replied_text'),
    ...unitsFromText(repliedCaption, 'replied_caption'),
  ];
  for (const img of [['current_image', context.currentImage], ['replied_image', context.repliedImage]]) {
    for (const u of img[1]?.trailerUnits || []) {
      candidates.push({ value: u.value, source: img[0], evidence: u.exactEvidence || null });
    }
  }
  // De-dupe by value, preferring the first (most-direct) source.
  const seen = new Set();
  context.candidateUnits = candidates.filter((c) => {
    if (!c.value || seen.has(c.value)) return false;
    if (!isValidTrailerUnitFormat(c.value).valid) return false;
    seen.add(c.value);
    return true;
  });

  // ── current known state for grounded units (best-effort) ──
  for (const c of context.candidateUnits) {
    try {
      const trailer = await db.getTrailerByUnitNumber(c.value);
      if (!trailer) continue;
      const status = await db.getTrailerCurrentStatus(trailer.id);
      if (status) {
        context.existingTrailerStates.push({
          unit: c.value,
          possessionStatus: status.possession_status || status.current_status || 'unknown',
          cargoStatus: status.cargo_status || 'unknown',
          lastEventType: status.last_event_type || null,
          lastEventAt: status.last_event_at || null,
        });
      }
    } catch { /* ignore */ }
  }

  return context;
}

/**
 * The grounded sources object the strict unit validator consumes, built from a
 * collected context.
 */
function groundedSourcesFromContext(context) {
  return {
    currentText: context?.currentText || null,
    currentCaption: context?.currentCaption || null,
    repliedText: context?.repliedMessage?.text || null,
    repliedCaption: context?.repliedMessage?.caption || null,
    currentImageUnits: context?.currentImage?.trailerUnits || [],
    repliedImageUnits: context?.repliedImage?.trailerUnits || [],
  };
}

module.exports = {
  collectTrailerContext,
  groundedSourcesFromContext,
  detectLanguage,
  senderInfo,
  RECENT_MESSAGE_LIMIT,
};
