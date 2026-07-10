/**
 * Trailer message AI classifier — fallback / enrichment only.
 *
 * The deterministic parser (trailerMessageParser.js) runs first. This module is
 * called only when that pass is uncertain (messy text, ambiguous action, a photo
 * caption that needs understanding). It asks the integrated Gemini stack for a
 * STRICT JSON classification, then validates every field before trusting it.
 *
 * Guardrails (this feeds a driver-responsibility ledger):
 *   - AI output is validated; anything malformed is discarded.
 *   - The AI is NEVER allowed to invent a unit number, location, or condition
 *     that is not grounded in the message text — we cross-check the returned
 *     unit against the message and drop it if absent.
 *   - Low-confidence results collapse to 'unidentified'.
 *   - No secrets are logged; only the model name + a short reason.
 */
const { callGeminiJson, GEMINI_API_KEY } = require('./geminiClient');
const { normalizeUnitNumber } = require('./trailerMessageParser');

const VALID_TYPES = new Set(['pickup', 'dropoff', 'mention_only', 'unidentified']);

function isAiConfigured() {
  return Boolean(GEMINI_API_KEY);
}

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 1 && n >= 0) return Math.round(n * 100); // model may return 0..1
  return Math.max(0, Math.min(100, Math.round(n)));
}

function str(value, max = 500) {
  if (value == null) return null;
  const t = String(value).trim();
  if (!t || t.toLowerCase() === 'null' || t.toLowerCase() === 'none') return null;
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * Classify a message with the AI. `messageText` is the text/caption; `imageParts`
 * is an optional array of Gemini inline_data parts for photo evidence.
 *
 * Returns a normalized result mirroring the deterministic parser's shape, plus
 * `method: 'ai'`, or `null` when the AI is unavailable/failed/invalid (the
 * caller then keeps its deterministic result).
 */
async function classifyTrailerMessageWithAi(messageText, imageParts = []) {
  if (!isAiConfigured()) return null;
  const text = String(messageText || '').trim();
  if (!text && (!Array.isArray(imageParts) || !imageParts.length)) return null;

  const systemText =
    'You classify short truck-driver Telegram messages about TRAILERS (pickups and '
    + 'drop-offs). You never invent facts. If a field is not clearly present in the '
    + 'message, return null for it. Respond with STRICT JSON only.';

  const userText =
    `Classify this driver-group message about a trailer.\n\n`
    + `Message:\n"""${text || '(photo with no caption)'}"""\n\n`
    + `Return JSON with EXACTLY these keys:\n`
    + `{\n`
    + `  "eventType": "pickup" | "dropoff" | "mention_only" | "unidentified",\n`
    + `  "trailerUnit": string | null,   // the trailer unit/number, exactly as written; null if none\n`
    + `  "locationText": string | null,  // e.g. "Lancaster PA"; null if none\n`
    + `  "conditionText": string | null, // e.g. "no pictures", "flat tire"; null if none\n`
    + `  "eventDateText": string | null, // e.g. "7/10"; null if none\n`
    + `  "mentionedDriverName": string | null, // a person named as doing the action; null if none\n`
    + `  "confidence": number,           // 0..100\n`
    + `  "reason": string                // one short sentence\n`
    + `}\n\n`
    + `Rules:\n`
    + `- "picked up" / "pick up" / "grabbed" / "hooked" / "picked up back" => pickup.\n`
    + `- "dropped" / "dropped off" / "left trailer" => dropoff.\n`
    + `- A trailer word with no clear pickup/dropoff => mention_only.\n`
    + `- Vague ("trailer?", "trl", "trailer issue") => unidentified.\n`
    + `- Do NOT guess a unit number, location, or condition that is not in the message.`;

  try {
    const { parsed, model } = await callGeminiJson({
      systemText,
      userText,
      extraParts: Array.isArray(imageParts) ? imageParts : [],
      maxOutputTokens: 600,
      validateParsed: (p) => p && typeof p === 'object' && VALID_TYPES.has(String(p.eventType)),
    });
    if (!parsed) return null;

    let eventType = String(parsed.eventType);
    if (!VALID_TYPES.has(eventType)) eventType = 'unidentified';

    let trailerUnit = normalizeUnitNumber(parsed.trailerUnit);
    // Ground the unit: it must actually appear in the message (defense against
    // hallucinated units). Compare on the normalized/stripped forms.
    if (trailerUnit) {
      const haystack = String(text || '').toUpperCase().replace(/[#\s]+/g, '');
      if (!haystack.includes(trailerUnit)) {
        trailerUnit = null; // not grounded — drop it
      }
    }

    const confidence = clampConfidence(parsed.confidence);

    // An action classification with no grounded unit cannot be a real event.
    if ((eventType === 'pickup' || eventType === 'dropoff') && !trailerUnit) {
      eventType = 'unidentified';
    }
    // Low confidence collapses to unidentified for actions.
    if ((eventType === 'pickup' || eventType === 'dropoff') && confidence < 45) {
      eventType = 'mention_only';
    }

    return {
      isTrailerRelated: true,
      eventType,
      trailerUnit,
      action: eventType === 'pickup' || eventType === 'dropoff' ? eventType : null,
      locationText: str(parsed.locationText, 500),
      conditionText: str(parsed.conditionText, 500),
      eventDateText: str(parsed.eventDateText, 100),
      reportedDriverName: str(parsed.mentionedDriverName, 200),
      confidence,
      reason: str(parsed.reason, 300) || 'ai classification',
      needsReview: eventType === 'unidentified' || eventType === 'mention_only' || confidence < 60,
      method: 'ai',
      aiModel: model || null,
    };
  } catch (err) {
    // Never log the message body or any secret — only a short diagnostic.
    console.warn('[TRAILER] AI classify failed (non-fatal):', err.message);
    return null;
  }
}

module.exports = {
  classifyTrailerMessageWithAi,
  isAiConfigured,
};
