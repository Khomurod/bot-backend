/**
 * Merge/unite the files of a BOL/POD batch into a single upload for Datatruck.
 *
 * Datatruck attaches ONE file per document, so when a driver sends several
 * pages/photos we combine them, in Telegram message order, into one PDF:
 *   - multiple images  → one PDF (one page per image)
 *   - multiple PDFs    → one concatenated PDF
 *   - mixed images/PDFs → one PDF
 * A single file is uploaded as-is (no needless re-encode). Everything runs
 * in-memory with pdf-lib (pure JS, no native deps) — there are no temp files to
 * leak or clean up. If any input can't be embedded, we throw rather than upload
 * a broken/partial file.
 *
 * pdf-lib costs ~6 MB RSS just to require, and this module sits on the bot's
 * boot path (bot.js → documentIntakeHandlers → bolPodTestMonitorService), so
 * the library is loaded lazily on first merge instead of at startup.
 */
let _PDFDocument = null;
function getPDFDocument() {
  if (!_PDFDocument) ({ PDFDocument: _PDFDocument } = require('pdf-lib'));
  return _PDFDocument;
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const PDF = Buffer.from('%PDF');
const MAX_IMAGE_PAGE_DIM = 2200; // pt — keeps merged pages a sane size

function startsWith(buf, sig) {
  return Buffer.isBuffer(buf) && buf.length >= sig.length && buf.subarray(0, sig.length).equals(sig);
}

/**
 * pdf-lib reads a typed array via its underlying ArrayBuffer; a pooled Node
 * Buffer (non-zero byteOffset / shared pool) makes it read the wrong bytes
 * ("SOI not found"). Hand pdf-lib a tight, offset-0 copy when needed.
 */
function tightBytes(buf) {
  if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) return buf;
  return new Uint8Array(buf);
}

/** Detect the real file kind from magic bytes, falling back to the mime hint. */
function detectKind(buffer, mimeType = '') {
  if (startsWith(buffer, PDF)) return 'pdf';
  if (startsWith(buffer, JPEG)) return 'jpg';
  if (startsWith(buffer, PNG)) return 'png';
  const m = String(mimeType || '').toLowerCase();
  if (m === 'application/pdf') return 'pdf';
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if (m === 'image/png') return 'png';
  return 'unknown';
}

function drawImagePage(pdfDoc, image) {
  let { width, height } = image;
  const longest = Math.max(width, height);
  if (longest > MAX_IMAGE_PAGE_DIM) {
    const scale = MAX_IMAGE_PAGE_DIM / longest;
    width *= scale;
    height *= scale;
  }
  const page = pdfDoc.addPage([width, height]);
  page.drawImage(image, { x: 0, y: 0, width, height });
}

/**
 * Merge an ordered list of files into a single PDF Buffer.
 * @param {Array<{buffer:Buffer, mimeType?:string}>} files
 * @param {{maxOutputBytes?:number}} [opts]
 * @returns {Promise<Buffer>}
 */
async function mergeToPdf(files, { maxOutputBytes = 45 * 1024 * 1024 } = {}) {
  const list = (files || []).filter((f) => f && Buffer.isBuffer(f.buffer) && f.buffer.length > 0);
  if (!list.length) throw new Error('mergeToPdf: no files to merge.');

  const PDFDocument = getPDFDocument();
  const out = await PDFDocument.create();
  for (const f of list) {
    const kind = detectKind(f.buffer, f.mimeType);
    const bytes = tightBytes(f.buffer);
    if (kind === 'pdf') {
      const src = await PDFDocument.load(bytes, { ignoreEncryption: true }).catch((e) => {
        throw new Error(`Could not read a PDF page for merge: ${e.message}`);
      });
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
    } else if (kind === 'jpg') {
      drawImagePage(out, await out.embedJpg(bytes));
    } else if (kind === 'png') {
      drawImagePage(out, await out.embedPng(bytes));
    } else {
      // HEIC/HEIF and other formats can't be embedded without a converter —
      // refuse rather than silently drop a page.
      throw new Error(`Unsupported file type for merge (${f.mimeType || 'unknown'}). Cannot build a complete document.`);
    }
  }

  const bytes = await out.save();
  const buffer = Buffer.from(bytes);
  if (buffer.length > maxOutputBytes) {
    throw new Error(`Merged document is too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB > ${(maxOutputBytes / 1024 / 1024).toFixed(0)} MB).`);
  }
  return buffer;
}

/**
 * Prepare the single file to upload from a batch. One file → as-is; many → a
 * merged PDF. Returns { buffer, filename, mimeType, merged, pageCountHint }.
 * @param {Array<{buffer:Buffer, mimeType?:string, fileName?:string}>} files
 */
async function prepareUpload(files, { baseName = 'document', maxOutputBytes } = {}) {
  const list = (files || []).filter((f) => f && Buffer.isBuffer(f.buffer) && f.buffer.length > 0);
  if (!list.length) throw new Error('prepareUpload: no files.');

  if (list.length === 1) {
    const f = list[0];
    const kind = detectKind(f.buffer, f.mimeType);
    if (kind === 'unknown') {
      throw new Error(`Unsupported file type (${f.mimeType || 'unknown'}).`);
    }
    const ext = kind === 'pdf' ? 'pdf' : (kind === 'png' ? 'png' : 'jpg');
    const mime = kind === 'pdf' ? 'application/pdf' : (kind === 'png' ? 'image/png' : 'image/jpeg');
    return {
      buffer: f.buffer,
      filename: f.fileName || `${baseName}.${ext}`,
      mimeType: mime,
      merged: false,
    };
  }

  const buffer = await mergeToPdf(list, { maxOutputBytes });
  return {
    buffer,
    filename: `${baseName}.pdf`,
    mimeType: 'application/pdf',
    merged: true,
  };
}

module.exports = {
  detectKind,
  mergeToPdf,
  prepareUpload,
  MAX_IMAGE_PAGE_DIM,
};
