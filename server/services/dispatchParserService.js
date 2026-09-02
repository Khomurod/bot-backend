/**
 * Rate-confirmation parsing — the two public entry points.
 *
 * `parseRateConfirmationFile` turns an uploaded rate confirmation into the
 * dispatch card a dispatcher sees; `extractRateConRawTextFromFile` returns just
 * the raw text, which the pinned-context reader uses to answer "what load is
 * this driver on?".
 *
 * Only these two are public. Everything they compose lives in focused modules:
 *
 *   ./dispatchParser/constants.js        the model prompt and the tuning caps
 *   ./dispatchParser/textExtraction.js   PDF text layer, then OCR (both lazy)
 *   ./dispatchParser/aiFailures.js       transient vs exhausted, output cleanup
 *   ./dispatchParser/fieldNormalizers.js PURE per-field tolerant readers
 *   ./dispatchParser/fieldExtraction.js  the deterministic regex parser
 *   ./dispatchParser/templateFormat.js   rendering, and the core-data gate
 *   ./dispatchParser/miles.js            best-effort driving miles
 *   ./dispatchParser/aiRequests.js       the Groq and Gemini reads
 *   ./dispatchParser/rateConfirmation.js text -> merged, rendered card
 *
 * Provider order is decided at RUNTIME, not fixed: Gemini goes first when the
 * extracted text is weak or came from PDF OCR, otherwise Groq first — and if
 * both fail the deterministic parser still answers (APP_BRIEF §6).
 */
require('dotenv').config();

const { MAX_INLINE_GEMINI_FILE_BYTES } = require('./dispatchParser/constants');
const {
  extractTextFromPdf, extractTextFromImage,
} = require('./dispatchParser/textExtraction');
const { formatDispatchRateConfirmation } = require('./dispatchParser/rateConfirmation');

async function parseRateConfirmationFile(file) {
  if (!file) {
    const error = new Error('No file provided');
    error.status = 400;
    throw error;
  }

  const extracted = await extractRateConRawTextFromFile(file);
  const rawText = extracted.text;
  const usedPdfOcr = Boolean(extracted.usedPdfOcr);

  const canParseFromInlineSource = Boolean(
    file?.buffer
    && file?.mimetype
    && (
      file.mimetype === 'application/pdf'
      || file.mimetype.startsWith('image/')
    )
    && file.buffer.length <= MAX_INLINE_GEMINI_FILE_BYTES
  );
  if (!rawText.trim() && !canParseFromInlineSource) {
    const error = new Error('No text could be extracted from that file.');
    error.status = 422;
    throw error;
  }

  const formatted = await formatDispatchRateConfirmation(rawText, file, { usedPdfOcr });
  if (!formatted.text) {
    const error = new Error('The AI model returned an empty response.');
    error.status = 502;
    throw error;
  }

  return {
    text: formatted.text,
    extractedText: rawText,
    filename: file.originalname,
    model: formatted.model,
    fallback: Boolean(formatted.fallback),
  };
}

async function extractRateConRawTextFromFile(file) {
  if (!file) {
    const error = new Error('No file provided');
    error.status = 400;
    throw error;
  }

  let rawText = '';
  let usedPdfOcr = false;
  if (file.mimetype === 'application/pdf') {
    const parsedPdf = await extractTextFromPdf(file.buffer);
    rawText = parsedPdf.text;
    usedPdfOcr = Boolean(parsedPdf.usedPdfOcr);
  } else if (file.mimetype.startsWith('image/')) {
    const parsedImage = await extractTextFromImage(file.buffer);
    rawText = parsedImage.text;
  } else {
    const error = new Error('Only PDF, JPG, PNG, and WEBP files are supported.');
    error.status = 400;
    throw error;
  }

  return {
    text: String(rawText || '').trim(),
    usedPdfOcr: Boolean(usedPdfOcr),
  };
}

module.exports = {
  extractRateConRawTextFromFile,
  parseRateConfirmationFile,
};
