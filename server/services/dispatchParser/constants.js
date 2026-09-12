/**
 * The two tuning caps the surviving reading path shares.
 *
 * WHAT LEFT THIS FILE. It held the rate-confirmation SYSTEM PROMPT — the
 * contract that defined the template a parsed dispatch answer had to fill — the
 * Groq and Gemini model chains for that read, and the three warning lines the
 * template appended. All of it belonged to the Dispatch Center's Send Load tab
 * and went with it; see `docs/architecture/retired-dispatch-center.md`.
 *
 * What is left is what `textExtraction.js` and the pinned-context reader still
 * need, which is why the file still exists rather than being folded away.
 *
 * Split out of server/services/dispatchParserService.js.
 */

/**
 * The biggest file that may be sent to a model inline rather than uploaded.
 * Read by `services/pinnedContext/*` as well as this directory.
 */
const MAX_INLINE_GEMINI_FILE_BYTES = 14 * 1024 * 1024;

const PDF_OCR_MAX_PAGES = 3;

// OCR (tesseract.js) loads a ~5MB language model and spikes memory on each
// run, which is too heavy for the free 512MB instance. It is therefore OFF by
// default; set ENABLE_OCR=true to turn it back on. Text-layer PDFs continue to
// parse normally; only scanned/image-only docs lose OCR (they can still fall
// back to AI vision where configured).
const OCR_ENABLED = process.env.ENABLE_OCR === 'true';

module.exports = {
  MAX_INLINE_GEMINI_FILE_BYTES,
  PDF_OCR_MAX_PAGES,
  OCR_ENABLED,
};
