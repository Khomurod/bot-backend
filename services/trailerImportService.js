/**
 * Trailer master-list screenshot import (Admin Portal only).
 *
 * An admin uploads a screenshot/photo of a trailer list. Gemini vision reads
 * every row and returns the trailer fields (make, model, unit #, MC #, plate,
 * type, VIN, year, ownership). We store the parsed rows in an import batch so
 * the admin can review/edit before committing them into `trailers`.
 *
 * Same shape as services/homeTimeImportService.js. Telegram-free and pure-ish:
 * extractRows() (parse) and commitRows() (write, via database/trailers.js).
 *
 * Guardrails: never invent missing fields. Anything the model is unsure about is
 * left blank and the row is flagged needs_review. Commit NEVER overwrites an
 * existing trailer field with a blank (see upsertTrailerByUnitNumber).
 */
const db = require('../database/db');
const { callGeminiJson, GEMINI_API_KEY } = require('./geminiClient');
const { normalizeUnitNumber } = require('./trailerMessageParser');

const MAX_INLINE_BYTES = 8 * 1024 * 1024; // per image
const FIELDS = ['make', 'model', 'unit_number', 'mc_number', 'plate_number', 'type', 'vin', 'year', 'ownership_status'];

function str(value, max = 100) {
  if (value == null) return null;
  const t = String(value).trim();
  if (!t || t.toLowerCase() === 'null' || t.toLowerCase() === 'n/a' || t === '-') return null;
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * Run Gemini vision over the uploaded image(s) and return raw trailer rows.
 * Throws a 4xx-tagged error when no image is readable or AI is unconfigured.
 */
async function extractFromImages(files) {
  if (!GEMINI_API_KEY) {
    const err = new Error('AI vision is not configured (GEMINI_API_KEY missing).');
    err.status = 503;
    throw err;
  }
  const images = (Array.isArray(files) ? files : [])
    .filter((f) => f?.buffer && f?.mimetype?.startsWith('image/') && f.buffer.length <= MAX_INLINE_BYTES)
    .map((f) => ({ inline_data: { mime_type: f.mimetype, data: f.buffer.toString('base64') } }));

  if (!images.length) {
    const err = new Error('No readable image files were uploaded.');
    err.status = 400;
    throw err;
  }

  const prompt =
    `You are reading a screenshot / photo of a trucking company's TRAILER list. `
    + `Each data row is one trailer. Read EVERY data row across ALL attached images.\n\n`
    + `For each trailer return these fields (use null when a value is not clearly present — `
    + `do NOT guess or invent values):\n`
    + `- make: manufacturer (e.g. Wabash, Great Dane, Utility)\n`
    + `- model\n`
    + `- unit_number: the trailer unit / fleet number (REQUIRED to be a real cell; the primary key)\n`
    + `- mc_number\n`
    + `- plate_number: license plate\n`
    + `- type: e.g. Dry Van, Reefer, Flatbed\n`
    + `- vin\n`
    + `- year\n`
    + `- ownership_status: e.g. Owned, Leased, Rented\n`
    + `- confidence: 0..100 for how sure you are of THIS row\n\n`
    + `Ignore header rows and totals. Respond with STRICT JSON only:\n`
    + `{"trailers":[{"make":null,"model":null,"unit_number":"","mc_number":null,"plate_number":null,`
    + `"type":null,"vin":null,"year":null,"ownership_status":null,"confidence":0}]}`;

  const { parsed, text } = await callGeminiJson({
    userText: prompt,
    extraParts: images,
    maxOutputTokens: 6000,
    validateParsed: (p) => Array.isArray(p?.trailers),
  });

  const rows = (parsed?.trailers || [])
    .map((r) => {
      const unit = normalizeUnitNumber(r.unit_number);
      const out = {
        make: str(r.make), model: str(r.model), unit_number: unit,
        mc_number: str(r.mc_number), plate_number: str(r.plate_number),
        type: str(r.type), vin: str(r.vin, 40), year: str(r.year, 10),
        ownership_status: str(r.ownership_status),
        confidence: r.confidence != null ? Math.max(0, Math.min(100, Math.round(Number(r.confidence)))) : null,
      };
      // A row needs review if the unit is missing/low-confidence or key fields blank.
      const filled = FIELDS.filter((f) => out[f] != null).length;
      out.needs_review = !unit || (out.confidence != null && out.confidence < 60) || filled < 3;
      out.raw_row = r;
      return out;
    })
    .filter((r) => r.unit_number || Object.values(r).some((v) => typeof v === 'string' && v)); // drop fully-empty rows

  return { rows, rawText: typeof text === 'string' ? text.slice(0, 50000) : null };
}

/**
 * Parse the screenshot(s) into an import batch (status 'parsed') the admin can
 * review. Returns { batch, rows }.
 */
async function extractAndStage(files, { uploadedBy = null, fileName = null } = {}) {
  const { rows, rawText } = await extractFromImages(files);
  const parsedCount = rows.length;
  const errorCount = rows.filter((r) => r.needs_review).length;
  const batch = await db.createImportBatch({
    uploadedBy, fileName, parsedCount, errorCount,
    rawAiResult: { rawText, rowCount: parsedCount },
  });
  const stored = await db.insertImportRows(batch.id, rows);
  return { batch, rows: stored };
}

/**
 * Commit reviewed rows into the `trailers` master list. Each row is upserted by
 * unit number (only non-blank provided fields are written; blanks never clobber
 * existing data). Rows without a unit number are skipped. Returns a summary.
 */
async function commitRows(batchId, rows) {
  const summary = { created: 0, updated: 0, skipped: 0 };
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    const unit = normalizeUnitNumber(row.unit_number);
    if (!unit) { summary.skipped += 1; continue; }
    const before = await db.getTrailerByUnitNumber(unit);
    await db.upsertTrailerByUnitNumber({
      unit_number: unit,
      make: row.make, model: row.model, mc_number: row.mc_number,
      plate_number: row.plate_number, type: row.type, vin: row.vin,
      year: row.year, ownership_status: row.ownership_status,
      needs_review: Boolean(row.needs_review),
      source: before ? undefined : 'screenshot_import',
    });
    if (before) summary.updated += 1; else summary.created += 1;
  }
  if (batchId != null) await db.markImportBatchCommitted(batchId);
  return summary;
}

module.exports = {
  extractFromImages,
  extractAndStage,
  commitRows,
};
