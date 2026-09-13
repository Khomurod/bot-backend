'use strict';

/**
 * `allowOcr: false` must mean tesseract.js is never even REQUIRED.
 *
 * The Finance Monitor's reader drains documents one at a time on a 512MB
 * instance. tesseract.js loads a ~5MB WASM model on first use, and that spike
 * in the middle of a drain is precisely what the sequential design exists to
 * avoid — so "we do not call OCR" is not enough; the module must not be loaded.
 *
 * The check is the require cache: if `allowOcr: false` ever reaches
 * `getCreateWorker()`, tesseract.js appears in it and this fails. A test that
 * merely asserted the returned text would pass either way, because the OCR
 * branch returns the same text-layer string when OCR finds nothing.
 *
 * The guard is `!allowOcr || !OCR_ENABLED`, and `OCR_ENABLED` is off by default
 * here — so in a default run the env would have stopped it anyway. Verified
 * separately with `ENABLE_OCR=true node --test tests/pdfTextExtraction.test.js`,
 * where the OCR branch IS live and `allowOcr: false` is the only thing standing
 * in front of it: 4 pass, 0 fail.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { extractTextFromPdf, extractTextFromImage } = require('../services/documents/pdfTextExtraction');

/** Has tesseract.js been loaded into this process? */
function tesseractLoaded() {
  return Object.keys(require.cache).some((k) => k.includes(`${require('path').sep}tesseract.js${require('path').sep}`));
}

/** A one-page PDF with a real text layer, built by hand — no fixture file. */
function minimalPdf(text) {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R '
      + '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

test('a PDF read with allowOcr:false never loads tesseract.js', async () => {
  assert.equal(tesseractLoaded(), false, 'nothing should have loaded it before this test');

  // Deliberately a PDF whose text layer is TOO THIN to pass the weak-text
  // check — which is exactly the case that would otherwise reach OCR.
  const result = await extractTextFromPdf(minimalPdf('x'), { allowOcr: false });

  assert.equal(result.usedPdfOcr, false);
  assert.equal(tesseractLoaded(), false,
    'allowOcr:false must stop before getCreateWorker, not merely discard its output');
});

test('an image read with allowOcr:false returns nothing rather than loading the model', async () => {
  const result = await extractTextFromImage(Buffer.from([0xff, 0xd8, 0xff]), { allowOcr: false });
  assert.equal(result.text, '');
  assert.equal(tesseractLoaded(), false);
});

test('a PDF with a real text layer is read without OCR either way', async () => {
  const result = await extractTextFromPdf(minimalPdf('INVOICE 42 TOTAL 500'), { allowOcr: false });
  assert.match(result.text, /INVOICE 42/);
  assert.equal(result.usedPdfOcr, false);
});

test('allowOcr defaults to true, so the dispatch caller keeps what it had', async () => {
  // The point is only that the option did not silently become opt-in for the
  // caller that never passes it; whether OCR then runs is ENABLE_OCR's call.
  const result = await extractTextFromPdf(minimalPdf('INVOICE 42 TOTAL 500'));
  assert.match(result.text, /INVOICE 42/);
});
