/**
 * Master-list snapshot extraction — the Gemini vision prompt and response shape.
 *
 * Reads ONE image of the official trailer list and returns its rows with
 * per-field confidence. Kept separate from the ingest loop (imageIngest.js) so
 * the prompt and the response normalization can be tested without touching
 * disk, and so the AI provider stays swappable.
 *
 * Guardrails, in priority order:
 *   1. NEVER invent a value. Unreadable -> null, and the row is flagged.
 *   2. Report confidence honestly, per field, so review effort goes where it
 *      is needed.
 *   3. Headers, totals and footers are not trailers.
 *
 * geminiClient is required LAZILY so the module and its base64/image work stay
 * off the boot path — imports run rarely.
 */
'use strict';

const { normalizeUnitNumber } = require('./normalize');
const { prepareImagePartForAi } = require('../aiImagePrep');

/** Fields extracted per trailer row. unit_number is the identity. */
const EXTRACTED_FIELDS = [
  'unit_number', 'make', 'model', 'mc_number', 'plate_number',
  'type', 'vin', 'year', 'ownership_status',
];

/** Below this, a row is flagged for review rather than trusted. */
const LOW_CONFIDENCE = 60;

/** Trim, and treat the model's "empty" spellings as genuinely absent. */
function str(value, max = 100) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  if (lower === 'null' || lower === 'n/a' || lower === 'none' || lower === 'unknown' || text === '-') return null;
  return text.length > max ? text.slice(0, max) : text;
}

/** Clamp a model-supplied confidence to 0..100, or null when absent. */
function confidence(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

const PROMPT = `You are reading ONE photo or screenshot of a trucking company's OFFICIAL TRAILER LIST.
Each data row is one trailer. Read EVERY data row in this image, top to bottom.

CRITICAL RULES:
- NEVER guess or invent a value. If a cell is blank, cut off, blurred or unreadable, return null.
- Do NOT return header rows, column titles, page totals, subtotals or footer rows.
- Read characters exactly as printed. Do NOT "correct" what you think is a typo.
- If you cannot read a character with confidence, lower that field's confidence rather than guessing.

For each trailer return:
- unit_number: the trailer unit / fleet number. This is the identity; a row without one is useless.
- make: manufacturer (e.g. Wabash, Great Dane, Utility)
- model
- mc_number
- plate_number: license plate
- type: e.g. Dry Van, Reefer, Flatbed
- vin
- year
- ownership_status: e.g. Owned, Leased, Rented
- row_confidence: 0..100, how sure you are of this row overall
- field_confidence: an object giving 0..100 per field you returned, e.g. {"unit_number":99,"vin":70}
- unclear_fields: array of field names you could not read reliably
- notes: optional short note, e.g. "row partially cut off at image edge"

Respond with STRICT JSON only:
{"trailers":[{"unit_number":"","make":null,"model":null,"mc_number":null,"plate_number":null,
"type":null,"vin":null,"year":null,"ownership_status":null,"row_confidence":0,
"field_confidence":{},"unclear_fields":[],"notes":null}]}`;

/**
 * Normalize one raw AI row into a staged row.
 * @param {object} raw model output for a single trailer
 * @param {number} imageIndex which uploaded image it came from
 */
function normalizeExtractedRow(raw, imageIndex) {
  const unit = normalizeUnitNumber(raw.unit_number);
  const row = {
    unit_number: unit,
    make: str(raw.make),
    model: str(raw.model),
    mc_number: str(raw.mc_number),
    plate_number: str(raw.plate_number),
    type: str(raw.type),
    vin: str(raw.vin, 40),
    year: str(raw.year, 10),
    ownership_status: str(raw.ownership_status),
    confidence: confidence(raw.row_confidence),
    source_image_index: imageIndex,
    raw_row: raw,
  };

  const fieldConfidence = {};
  if (raw.field_confidence && typeof raw.field_confidence === 'object') {
    for (const field of EXTRACTED_FIELDS) {
      const value = confidence(raw.field_confidence[field]);
      if (value != null) fieldConfidence[field] = value;
    }
  }
  row.field_confidence = fieldConfidence;

  const unclear = Array.isArray(raw.unclear_fields)
    ? raw.unclear_fields.filter((f) => EXTRACTED_FIELDS.includes(f))
    : [];

  // Flag for review rather than trust, whenever identity is weak: no unit
  // number, low confidence, the model said so, or almost nothing was readable.
  const filled = EXTRACTED_FIELDS.filter((f) => row[f] != null).length;
  row.needs_review = Boolean(
    !unit
    || (row.confidence != null && row.confidence < LOW_CONFIDENCE)
    || (fieldConfidence.unit_number != null && fieldConfidence.unit_number < LOW_CONFIDENCE)
    || unclear.length > 0
    || filled < 2,
  );
  row.conflict_details = unclear.length || raw.notes
    ? { unclear_fields: unclear, notes: str(raw.notes, 300) }
    : null;
  return row;
}

/**
 * Extract every trailer row from ONE image.
 *
 * @param {{ bytes: Buffer, mimeType: string }} image
 * @param {number} imageIndex position in the upload, recorded on each row
 * @returns {Promise<{rows: Array<object>, rawText: string|null}>}
 */
async function extractRowsFromImage(image, imageIndex) {
  const { callGeminiJson, GEMINI_API_KEY } = require('../geminiClient');
  if (!GEMINI_API_KEY) {
    throw Object.assign(new Error('AI vision is not configured (GEMINI_API_KEY missing).'), { status: 503 });
  }

  const { parsed, text } = await callGeminiJson({
    userText: PROMPT,
    extraParts: [await prepareImagePartForAi(image.bytes, image.mimeType)],
    maxOutputTokens: 8000,
    validateParsed: (p) => Array.isArray(p?.trailers),
  });

  const rows = (parsed?.trailers || [])
    .map((raw) => normalizeExtractedRow(raw, imageIndex))
    // A row with no unit number and no other readable field is noise, not data.
    .filter((row) => row.unit_number || EXTRACTED_FIELDS.some((f) => row[f] != null));

  return { rows, rawText: typeof text === 'string' ? text.slice(0, 50000) : null };
}

module.exports = {
  extractRowsFromImage,
  normalizeExtractedRow,
  EXTRACTED_FIELDS,
  LOW_CONFIDENCE,
  PROMPT,
};
