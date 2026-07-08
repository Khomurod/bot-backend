/**
 * AI document classifier for the smart BOL/POD intake pipeline.
 *
 * Given the file bytes a driver sent in their Telegram group, ask Gemini
 * (the repo's vision-capable model, reused via services/geminiClient) to decide
 * whether the batch is a Bill of Lading, a Proof of Delivery, both, unrelated,
 * or unclear — CONSERVATIVELY. The model returns strict JSON only; anything it
 * cannot classify with evidence must come back as "unclear" so a human confirms.
 *
 * Vision: images and PDFs are passed inline (Gemini reads application/pdf and
 * image/* directly). For PDFs we also extract the text layer (pdf-parse) as a
 * cheap assist and to bound how much the model must OCR. Oversized files are
 * described in text rather than inlined. No file is ever auto-classified with
 * high confidence without evidence — that is enforced in the prompt and, as a
 * backstop, by normalizeClassification.
 *
 * The Gemini call is injectable (deps.callJson) so the logic is unit-testable
 * without any network.
 */
const geminiClient = require('./geminiClient');
const {
  BOL_FILE_TYPE,
  POD_FILE_TYPE,
} = require('./datatruckDocumentHelpers');

const DOC_TYPES = Object.freeze(['bol', 'pod', 'both', 'unrelated', 'unclear']);
// Gemini inline payload ceiling (matches dispatchParserService's cap).
const MAX_INLINE_BYTES = 14 * 1024 * 1024;
const MAX_PDF_TEXT_CHARS = 6000;
const IMAGE_MIME_RE = /^image\/(jpe?g|png|webp|heic|heif)$/i;

/** Map an intake doc-type token to the Datatruck file_type used for upload. */
function datatruckFileTypeForDocType(docType) {
  if (docType === 'bol') return BOL_FILE_TYPE;
  if (docType === 'pod') return POD_FILE_TYPE;
  return null; // both/unrelated/unclear are never auto-mapped to one type
}

/** Best-effort PDF text-layer extraction; empty string for scanned/failed PDFs. */
async function extractPdfText(buffer) {
  try {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return String(result?.text || '').slice(0, MAX_PDF_TEXT_CHARS);
    } finally {
      await parser.destroy().catch(() => {});
    }
  } catch {
    return '';
  }
}

/**
 * Build the Gemini `extraParts` (inline_data) plus a per-file text description.
 * @param {Array<{buffer:Buffer, mimeType:string, fileName?:string, kind?:string}>} files
 */
async function buildFileParts(files) {
  const parts = [];
  const descriptions = [];
  for (let i = 0; i < files.length; i += 1) {
    const f = files[i] || {};
    const mime = String(f.mimeType || '').toLowerCase();
    const size = f.buffer ? f.buffer.length : 0;
    const isPdf = mime === 'application/pdf' || String(f.kind).toLowerCase() === 'pdf';
    const isImage = IMAGE_MIME_RE.test(mime) || String(f.kind).toLowerCase() === 'image';
    const desc = { index: i, file_name: f.fileName || `file_${i}`, mime_type: mime || (isPdf ? 'application/pdf' : 'unknown'), bytes: size };

    if (f.buffer && size > 0 && size <= MAX_INLINE_BYTES && (isPdf || isImage)) {
      // HEIC/HEIF are declared but Gemini prefers jpeg/png/webp/pdf — still
      // inline; if the model can't read it, it will report unclear.
      parts.push({ inline_data: { mime_type: mime || 'application/pdf', data: f.buffer.toString('base64') } });
      desc.inlined = true;
    } else {
      desc.inlined = false;
      desc.note = size > MAX_INLINE_BYTES ? 'too large to inline' : 'not inlined';
    }

    if (isPdf && f.buffer) {
      const text = await extractPdfText(f.buffer);
      if (text.trim()) {
        desc.text_layer_excerpt = text;
      }
    }
    descriptions.push(desc);
  }
  return { parts, descriptions };
}

const SYSTEM_TEXT = [
  'You are a conservative freight-document classifier for a US trucking company.',
  'You look at scanned/photographed documents a driver sent and decide if they are',
  'a Bill of Lading (BOL), a Proof of Delivery (POD), both, unrelated, or unclear.',
  'Rules:',
  '- Be conservative. Do NOT call something BOL or POD unless there is clear visible evidence.',
  '- BOL evidence: "Bill of Lading", "BOL", shipper/origin, pickup, seal number, no delivery signature.',
  '- POD evidence: "Proof of Delivery", "POD", "Delivered", consignee/receiver signature, delivery stamp, received-by.',
  '- A single document may contain both BOL and POD pages -> use "both".',
  '- Fuel receipts, repair invoices, rate confirmations, permits, insurance, lumper receipts, scale tickets etc. are "unrelated".',
  '- If you are not sure, or the image is unreadable, use "unclear" (do NOT guess).',
  '- If the pages look like they belong to a DIFFERENT load than the driver\'s current one, say so in belongs_to_other_load.',
  '- Return STRICT JSON only, no prose, no markdown fences.',
].join('\n');

/** Build the user prompt. Pure. */
function buildUserPrompt(context = {}, descriptions = []) {
  const ctxLines = [];
  if (context.driverName) ctxLines.push(`Driver: ${context.driverName}`);
  if (context.unitNumber) ctxLines.push(`Unit: ${context.unitNumber}`);
  if (context.loadReference) ctxLines.push(`Likely current load: ${context.loadReference}`);
  if (context.stageHint) ctxLines.push(`Location hint: driver appears to be near ${context.stageHint}.`);
  const schema = {
    batch: {
      type: 'bol|pod|both|unrelated|unclear',
      confidence: '0..1',
      same_load: 'true if all files belong to one load',
      belongs_to_other_load: 'true if it looks like a different load than the current one',
      summary: 'one short sentence of the evidence',
    },
    load_numbers: ['strings found on the documents'],
    addresses: ['pickup/delivery addresses found'],
    dates: ['dates found'],
    driver_info: 'driver/truck info found or null',
    evidence: ['short phrases actually visible, e.g. "Proof of Delivery", "consignee signature"'],
    files: [{ index: 0, type: 'bol|pod|both|unrelated|unclear', confidence: '0..1', evidence: ['...'] }],
  };
  return [
    ctxLines.length ? `Context:\n${ctxLines.join('\n')}` : 'Context: none provided.',
    '',
    `Files (${descriptions.length}), in the order the driver sent them:`,
    JSON.stringify(descriptions, null, 2),
    '',
    'Classify the batch as a whole AND each file. Return JSON EXACTLY in this shape:',
    JSON.stringify(schema, null, 2),
  ].join('\n');
}

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return n > 1 && n <= 100 ? n / 100 : 1; // tolerate 0..100 scale
  return n;
}

function normalizeDocType(value) {
  const t = String(value || '').trim().toLowerCase();
  if (DOC_TYPES.includes(t)) return t;
  if (t === 'bill_of_lading' || t === 'bill of lading') return 'bol';
  if (t === 'proof_of_delivery' || t === 'proof of delivery') return 'pod';
  return 'unclear';
}

function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v ?? '').trim()).filter(Boolean).slice(0, 20);
}

/**
 * Normalize whatever the model returned into a safe, predictable shape. A
 * missing/garbage response degrades to "unclear" with confidence 0 so the
 * pipeline asks a human. Pure.
 */
function normalizeClassification(parsed, fileCount = 0) {
  if (!parsed || typeof parsed !== 'object') {
    return {
      type: 'unclear',
      confidence: 0,
      sameLoad: null,
      belongsToOtherLoad: null,
      loadNumbers: [],
      addresses: [],
      dates: [],
      driverInfo: null,
      evidence: [],
      summary: 'Could not classify (no structured AI result).',
      files: [],
      ok: false,
    };
  }
  const batch = parsed.batch && typeof parsed.batch === 'object' ? parsed.batch : parsed;
  const type = normalizeDocType(batch.type);
  let confidence = clampConfidence(batch.confidence);
  // Backstop the "be conservative" rule: unclear/unrelated never carry high
  // confidence toward an upload decision.
  if (type === 'unclear') confidence = Math.min(confidence, 0.4);

  const files = Array.isArray(parsed.files)
    ? parsed.files.slice(0, Math.max(fileCount, parsed.files.length)).map((f, i) => ({
      index: Number.isInteger(f?.index) ? f.index : i,
      type: normalizeDocType(f?.type),
      confidence: clampConfidence(f?.confidence),
      evidence: toStringArray(f?.evidence),
    }))
    : [];

  return {
    type,
    confidence,
    sameLoad: typeof batch.same_load === 'boolean' ? batch.same_load : null,
    belongsToOtherLoad: typeof batch.belongs_to_other_load === 'boolean' ? batch.belongs_to_other_load : null,
    loadNumbers: toStringArray(parsed.load_numbers),
    addresses: toStringArray(parsed.addresses),
    dates: toStringArray(parsed.dates),
    driverInfo: parsed.driver_info ? String(parsed.driver_info).slice(0, 200) : null,
    evidence: toStringArray(parsed.evidence),
    summary: batch.summary ? String(batch.summary).slice(0, 300) : (parsed.summary ? String(parsed.summary).slice(0, 300) : ''),
    files,
    ok: true,
  };
}

function isConfigured() {
  return Boolean(geminiClient.GEMINI_API_KEY);
}

/**
 * Classify a batch of files. Returns a normalized classification (never throws).
 * @param {Array} files  [{ buffer, mimeType, fileName, kind }]
 * @param {object} context  { driverName, unitNumber, loadReference, stageHint }
 * @param {object} [deps]  { callJson } — inject to test without Gemini.
 */
async function classifyBatch(files, context = {}, deps = {}) {
  const list = Array.isArray(files) ? files : [];
  const callJson = deps.callJson || (isConfigured() ? geminiClient.callGeminiJson : null);
  if (!callJson) {
    const out = normalizeClassification(null, list.length);
    out.summary = 'AI classifier not configured (GEMINI_API_KEY unset) — needs human review.';
    out.configured = false;
    return out;
  }

  let descriptions = [];
  let parts = [];
  try {
    ({ parts, descriptions } = await buildFileParts(list));
  } catch {
    descriptions = list.map((f, i) => ({ index: i, file_name: f?.fileName || `file_${i}` }));
    parts = [];
  }

  const userText = buildUserPrompt(context, descriptions);
  try {
    const { parsed } = await callJson({
      systemText: SYSTEM_TEXT,
      userText,
      extraParts: parts,
      maxOutputTokens: 900,
      generationConfig: { temperature: 0.1 },
    });
    const normalized = normalizeClassification(parsed, list.length);
    normalized.configured = true;
    return normalized;
  } catch (err) {
    const out = normalizeClassification(null, list.length);
    out.summary = `AI classification failed (${String(err?.message || err).slice(0, 120)}) — needs human review.`;
    out.configured = true;
    out.error = true;
    return out;
  }
}

module.exports = {
  DOC_TYPES,
  MAX_INLINE_BYTES,
  isConfigured,
  datatruckFileTypeForDocType,
  extractPdfText,
  buildFileParts,
  buildUserPrompt,
  normalizeClassification,
  normalizeDocType,
  clampConfidence,
  classifyBatch,
  SYSTEM_TEXT,
};
