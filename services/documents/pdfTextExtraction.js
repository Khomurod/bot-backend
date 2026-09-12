'use strict';

/**
 * Getting raw TEXT out of a PDF or an image. Two callers, two appetites.
 *
 * A PDF's text layer first; OCR only when that layer is missing or unusable,
 * because OCR is slow and the worker is heavy. pdf-parse and tesseract.js are
 * required LAZILY for exactly that reason — importing them eagerly would load
 * both on every boot of a memory-constrained instance.
 *
 * `allowOcr` IS A CALLER'S DECISION, NOT A GLOBAL ONE. The rate-confirmation
 * reader wants every character it can get and accepts the cost. The Finance
 * Monitor's document reader passes `allowOcr: false` and means it: it drains
 * documents one at a time on a 512MB instance, it has an AI-vision path that
 * reads a scan far better than OCR does, and tesseract.js loading a ~5MB WASM
 * model in the middle of that drain is exactly the memory spike the sequential
 * design exists to avoid. With it false, `getCreateWorker` is never reached, so
 * the dependency is never required at all — asserted in
 * tests/pdfTextExtraction.test.js rather than assumed.
 *
 * `ENABLE_OCR` still has the last word: `allowOcr: true` asks, it does not
 * override. The env switch is off by default for the memory reason above.
 *
 * `isWeakDispatchRawText` is what tells the caller the text is too poor to
 * trust — it flips the dispatch provider order to Gemini-first, and it is what
 * sends a finance document to AI vision instead of a text-only read.
 *
 * MOVED here from server/services/dispatchParser/textExtraction.js. It was
 * never dispatch-specific; leaving it there would have had a `services/finance`
 * worker reaching up into `server/`, against the one-way dependency rule.
 */
/** How many rendered pages OCR will look at before giving up. */
const PDF_OCR_MAX_PAGES = 3;

// OCR (tesseract.js) loads a ~5MB language model and spikes memory on each run,
// which is too heavy for the free 512MB instance. It is therefore OFF by
// default; set ENABLE_OCR=true to turn it back on. Text-layer PDFs continue to
// parse normally; only scanned/image-only docs lose OCR, and they can still
// fall back to AI vision where a caller has one.
//
// These two used to live in server/services/dispatchParser/constants.js, whose
// only other export (MAX_INLINE_GEMINI_FILE_BYTES) had no importer left —
// services/pinnedContext/constants.js carries its own copy. With this module
// moved out, that file had no reader at all, so it is gone rather than left as
// a two-line indirection nobody follows.
const OCR_ENABLED = process.env.ENABLE_OCR === 'true';

// Heavy deps — lazy-loaded on first use so they don't sit resident in memory
// on the 512MB free instance. pdf-parse pulls in a large parser and
// tesseract.js loads WASM + a ~5MB model; most requests never touch a PDF/OCR.
let _PDFParse = null;

function getPDFParse() {
  if (!_PDFParse) ({ PDFParse: _PDFParse } = require('pdf-parse'));
  return _PDFParse;
}

let _createWorker = null;

function getCreateWorker() {
  if (!_createWorker) ({ createWorker: _createWorker } = require('tesseract.js'));
  return _createWorker;
}

async function extractTextFromPdf(buffer, { allowOcr = true } = {}) {
  const parser = new (getPDFParse())({ data: buffer });
  try {
    const result = await parser.getText();
    const textLayer = String(result?.text || '').trim();
    if (!isWeakDispatchRawText(textLayer)) {
      return { text: textLayer, usedPdfOcr: false };
    }

    let screenshotOcrText = '';
    try {
      if (!allowOcr || !OCR_ENABLED) {
        return { text: textLayer, usedPdfOcr: false };
      }
      const screenshots = await parser.getScreenshot({ scale: 2, imageDataUrl: false });
      const pages = Array.isArray(screenshots?.pages) ? screenshots.pages.slice(0, PDF_OCR_MAX_PAGES) : [];
      if (pages.length > 0) {
        const worker = await getCreateWorker()('eng');
        try {
          const fragments = [];
          for (const page of pages) {
            const pngBytes = page?.data;
            if (!pngBytes || !pngBytes.length) continue;
            const ocrResult = await worker.recognize(Buffer.from(pngBytes));
            const pageText = String(ocrResult?.data?.text || '').trim();
            if (pageText) fragments.push(pageText);
          }
          screenshotOcrText = fragments.join('\n\n').trim();
        } finally {
          await worker.terminate();
        }
      }
    } catch {
      screenshotOcrText = '';
    }

    return {
      text: [textLayer, screenshotOcrText].filter(Boolean).join('\n\n').trim(),
      usedPdfOcr: Boolean(screenshotOcrText),
    };
  } finally {
    try {
      await parser.destroy();
    } catch {
      // No cleanup action needed if parser teardown fails.
    }
  }
}

async function extractTextFromImage(buffer, { allowOcr = true } = {}) {
  if (!allowOcr || !OCR_ENABLED) {
    return { text: '', usedPdfOcr: false };
  }
  const worker = await getCreateWorker()('eng');
  try {
    const result = await worker.recognize(buffer);
    return {
      text: String(result?.data?.text || '').trim(),
      usedPdfOcr: false,
    };
  } finally {
    await worker.terminate();
  }
}

function isWeakDispatchRawText(rawText) {
  const source = String(rawText || '');
  const normalized = source.replace(/\s+/g, ' ').trim();
  if (!normalized) return true;

  const alphaWordCount = (normalized.match(/[A-Za-z]{3,}/g) || []).length;
  const digitCount = (normalized.match(/\d/g) || []).length;
  const boilerplateOnly = /^(\s*--\s*\d+\s+of\s+\d+\s*--\s*)+$/i.test(normalized);

  return boilerplateOnly || (alphaWordCount < 12 && digitCount < 18);
}

module.exports = {
  extractTextFromPdf,
  extractTextFromImage,
  isWeakDispatchRawText,
};
