/**
 * Getting the raw text out of an uploaded rate confirmation.
 *
 * ONE PUBLIC FUNCTION NOW. `extractRateConRawTextFromFile` returns the text, and
 * the pinned-context reader uses it to answer "what load is this driver on?"
 * when a dispatcher shares a document in a driver's chat.
 *
 * `parseRateConfirmationFile` — which turned that text into a rendered dispatch
 * card through a Groq/Gemini read, a deterministic regex parser and a template —
 * went with the Dispatch Center's Send Load tab. See
 * `docs/architecture/retired-dispatch-center.md` for what was removed and the
 * commit to read it at. The reading path that survives is the one with a caller
 * outside the deleted page.
 *
 * Its one remaining piece — getting text out of a file — moved OUT to
 * ../../services/documents/pdfTextExtraction.js, because a services/finance
 * worker needs it too and reaching up into server/ from there would invert the
 * dependency direction. `./dispatchParser/constants.js` went with it: its OCR
 * constants belong to that module, and its only other export had no importer
 * left.
 */
require('dotenv').config();

const {
  extractTextFromPdf, extractTextFromImage,
} = require('../../services/documents/pdfTextExtraction');

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

module.exports = { extractRateConRawTextFromFile };
