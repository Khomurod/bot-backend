/**
 * Getting raw TEXT out of a rate confirmation file.
 *
 * A PDF's text layer first; OCR only when that layer is missing or unusable,
 * because OCR is slow and the worker is heavy. pdf-parse and tesseract.js are
 * required LAZILY for exactly that reason — importing them eagerly would load
 * both on every boot of a memory-constrained instance.
 *
 * `isWeakDispatchRawText` is what tells the caller the text is too poor to trust,
 * which is what flips the provider order to Gemini-first.
 *
 * Split out of server/services/dispatchParserService.js.
 */
const { PDF_OCR_MAX_PAGES, OCR_ENABLED } = require('./constants');

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

async function extractTextFromPdf(buffer) {
  const parser = new (getPDFParse())({ data: buffer });
  try {
    const result = await parser.getText();
    const textLayer = String(result?.text || '').trim();
    if (!isWeakDispatchRawText(textLayer)) {
      return { text: textLayer, usedPdfOcr: false };
    }

    let screenshotOcrText = '';
    try {
      if (!OCR_ENABLED) {
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

async function extractTextFromImage(buffer) {
  if (!OCR_ENABLED) {
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
