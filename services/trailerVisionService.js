/**
 * Trailer vision extraction — reads trailer unit numbers (and plate/VIN when
 * visible) out of a Telegram photo using the app's integrated Gemini stack
 * (services/geminiClient.js). Used by the trailer context service to ground a
 * unit that lives in a replied-to or attached image ("Trailer #: SWFZ233611").
 *
 * Guardrails:
 *   - The AI must return exact evidence for every unit; nothing is invented.
 *   - Every returned unit is re-validated with the strict unit-format rules
 *     (reserved words like "TRL"/"TRAILER" can never become units).
 *   - Results are cached by Telegram file_unique_id so the same image is never
 *     analyzed twice. Image bytes are never persisted.
 *   - Fail-soft: any error returns null; callers treat that as "no image text".
 */
const { callGeminiJson, GEMINI_API_KEY } = require('./geminiClient');
const { isValidTrailerUnitFormat, normalizeUnitCandidate } = require('./trailerUnitValidation');

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // bound base64 memory cost
const VISION_TIMEOUT_MS = 25_000;
const CACHE_MAX = 200;

// file_unique_id -> extraction result (bounded FIFO cache).
const cache = new Map();

function cacheGet(key) {
  return key ? cache.get(key) : undefined;
}
function cacheSet(key, value) {
  if (!key) return;
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, value);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Download a Telegram file into a bounded Buffer. Throws on failure/oversize. */
async function downloadTelegramImage(telegram, fileId) {
  const fileUrl = await telegram.getFileLink(fileId);
  const response = await fetch(String(fileUrl), { headers: { 'User-Agent': 'DispatchBot/1.0' } });
  if (!response.ok) throw new Error(`Telegram file download failed (${response.status})`);
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`image too large (${arrayBuffer.byteLength} bytes)`);
  }
  return Buffer.from(arrayBuffer);
}

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 1 && n >= 0) return Math.round(n * 100);
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Normalize + validate the AI's vision JSON. Drops any unit without exact
 * evidence or with an invalid format. Never throws.
 */
function sanitizeVisionResult(parsed, source) {
  const units = [];
  for (const u of Array.isArray(parsed?.trailerUnits) ? parsed.trailerUnits : []) {
    const value = normalizeUnitCandidate(u?.value);
    const evidence = u?.exactEvidence != null ? String(u.exactEvidence).trim().slice(0, 300) : null;
    if (!value || !evidence) continue;
    if (!isValidTrailerUnitFormat(value).valid) continue;
    // The evidence text must actually contain the unit (defense against a
    // fabricated unit with unrelated "evidence").
    const evidenceNorm = evidence.toUpperCase().replace(/[#\s]+/g, '');
    if (!evidenceNorm.includes(value)) continue;
    units.push({
      value,
      confidence: clampConfidence(u?.confidence),
      exactEvidence: evidence,
      source,
    });
  }
  const rawText = parsed?.visibleText != null ? String(parsed.visibleText).trim().slice(0, 2000) : null;
  return {
    trailerUnits: units,
    plateNumber: parsed?.plateNumber != null ? String(parsed.plateNumber).trim().slice(0, 40) || null : null,
    vin: parsed?.vin != null ? String(parsed.vin).trim().slice(0, 40) || null : null,
    visibleText: rawText,
  };
}

/**
 * Extract trailer units from ONE Telegram image. `source` labels where the
 * image came from: 'current_image' | 'replied_image'.
 *
 * Returns { trailerUnits: [{value, confidence, exactEvidence, source}], … }
 * or null when vision is unavailable/failed (caller treats as no image text).
 */
async function extractTrailerUnitsFromTelegramImage(telegram, { fileId, fileUniqueId, source = 'replied_image' } = {}) {
  if (!GEMINI_API_KEY || !telegram || !fileId) return null;

  const cacheKey = fileUniqueId ? `${fileUniqueId}` : null;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const buffer = await withTimeout(downloadTelegramImage(telegram, fileId), VISION_TIMEOUT_MS, 'telegram image download');

    const systemText =
      'You read photos from truck-driver Telegram chats and extract ONLY text that is '
      + 'actually visible in the image. You never invent or guess text. If a field is '
      + 'not clearly visible, return null / an empty list. Respond with STRICT JSON only.';
    const userText =
      'Extract trailer identification from this photo (it may be a trailer, a document, '
      + 'or an app screenshot).\n\n'
      + 'Return JSON with EXACTLY these keys:\n'
      + '{\n'
      + '  "trailerUnits": [\n'
      + '    { "value": "SWFZ233611", "confidence": 98, "exactEvidence": "Trailer #: SWFZ233611" }\n'
      + '  ],\n'
      + '  "plateNumber": string | null,\n'
      + '  "vin": string | null,\n'
      + '  "visibleText": string | null   // other clearly printed labels, max ~200 chars\n'
      + '}\n\n'
      + 'Rules:\n'
      + '- "value" must be a real unit identifier VISIBLE in the image (letters/digits, at least one digit).\n'
      + '- "exactEvidence" must quote the exact visible text the unit came from.\n'
      + '- NEVER return generic words like "TRL", "TRAILER", or "UNIT" as a unit value.\n'
      + '- An empty list is the correct answer when no unit number is visible.';

    const { parsed, model } = await withTimeout(
      callGeminiJson({
        systemText,
        userText,
        extraParts: [{ inline_data: { mime_type: 'image/jpeg', data: buffer.toString('base64') } }],
        maxOutputTokens: 500,
        maxRetryWaitMs: 4_000,
        validateParsed: (p) => p && typeof p === 'object' && Array.isArray(p.trailerUnits),
      }),
      VISION_TIMEOUT_MS,
      'trailer vision extraction'
    );
    if (!parsed) {
      cacheSet(cacheKey, null);
      return null;
    }
    const result = sanitizeVisionResult(parsed, source);
    result.aiModel = model || null;
    cacheSet(cacheKey, result);
    return result;
  } catch (err) {
    // No secrets, no image content in logs.
    console.warn('[TRAILER-VISION] extraction failed (non-fatal):', err.message);
    // Do NOT cache transient failures — a later retry may succeed.
    return null;
  }
}

/** Pull the best (largest) photo descriptor out of a Telegram message. */
function photoDescriptor(message) {
  if (!message) return null;
  if (Array.isArray(message.photo) && message.photo.length) {
    const largest = message.photo[message.photo.length - 1];
    if (largest?.file_id) {
      return { fileId: largest.file_id, fileUniqueId: largest.file_unique_id || null };
    }
  }
  if (message.document?.file_id && String(message.document.mime_type || '').startsWith('image/')) {
    return { fileId: message.document.file_id, fileUniqueId: message.document.file_unique_id || null };
  }
  return null;
}

function isVisionConfigured() {
  return Boolean(GEMINI_API_KEY);
}

/** Test helper. */
function _resetCache() {
  cache.clear();
}

module.exports = {
  extractTrailerUnitsFromTelegramImage,
  sanitizeVisionResult,
  photoDescriptor,
  isVisionConfigured,
  downloadTelegramImage,
  _resetCache,
  VISION_TIMEOUT_MS,
  MAX_IMAGE_BYTES,
};
