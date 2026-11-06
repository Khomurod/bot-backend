'use strict';

/**
 * Turning remembered photos into a PDF, in memory, and nowhere else.
 *
 * NOTHING IS SAVED. Each photo is downloaded from Telegram by its file id,
 * re-encoded, put on a page, and the PDF's bytes are handed to the sender and
 * dropped. Not the database, not the disk: the owner wants the PDF in one
 * person's chat, and a copy kept in Wenze would be a second place to secure.
 *
 * ONE PHOTO AT A TIME. A phone photo is 3–12 MB; sixty at once is the memory
 * this process does not have. So each is downloaded, re-encoded to a JPEG of
 * ~1600 px on its long side at quality ~80 (rotated the way the phone held it,
 * metadata gone — a few hundred KB), and only that copy is kept. Sixty of
 * those stay well under Telegram's 50 MB document limit.
 *
 * The download (services/telegram/fileDownload.js) refuses anything over 20 MB
 * — the Bot API's own download limit — before and while it reads, and never
 * puts the file URL (which carries the bot token) in an error.
 *
 * The PDF uses Helvetica, which every reader has, so nothing is embedded but
 * the photos; every string is WinAnsi-safe (lib/truckPhotos/pdfText.js).
 */

const sharp = require('sharp');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { downloadTelegramFile } = require('../telegram/fileDownload');
const { pdfSafeText } = require('../../lib/truckPhotos/pdfText');

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Long edge, then quality; a stubborn photo steps down until it is under TARGET_BYTES. */
const ENCODE_LADDER = Object.freeze([
  { dimension: 1600, quality: 80 },
  { dimension: 1400, quality: 72 },
  { dimension: 1200, quality: 65 },
]);
const TARGET_BYTES = 700 * 1024;

const PORTRAIT = [612, 792]; // US Letter, points
const LANDSCAPE = [792, 612];
const MARGIN = 28;
const CAPTION_SPACE = 26;

/**
 * One photo as the PDF will hold it: a baseline JPEG (every PDF reader can
 * show one), EXIF orientation applied. Null when sharp cannot read it.
 *
 * @returns {Promise<{jpeg: Buffer, width: number, height: number}|null>}
 */
async function normalisePhoto(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
  try {
    await sharp(buffer).metadata();
  } catch (_) {
    return null;
  }
  let best = null;
  for (const step of ENCODE_LADDER) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = await sharp(buffer)
        .rotate()
        .resize({
          width: step.dimension, height: step.dimension, fit: 'inside', withoutEnlargement: true,
        })
        .jpeg({ quality: step.quality, progressive: false, chromaSubsampling: '4:2:0' })
        .toBuffer({ resolveWithObject: true });
      best = { jpeg: out.data, width: out.info.width, height: out.info.height };
      if (out.data.length <= TARGET_BYTES) break;
    } catch (_) {
      // An odd colour profile can fail one step; the next may still work.
    }
  }
  return best;
}

/**
 * Download and re-encode each photo in turn.
 *
 * @param {Array<{fileId: string}>} photos
 * @param {object} opts
 * @param {object} opts.telegram     a Telegraf telegram client
 * @param {number} [opts.deadlineAt] epoch ms; photos not reached by then count as unreadable
 * @returns {Promise<{ready: Array<{photo, jpeg, width, height}>, unreadable: number}>}
 */
async function preparePhotos(photos, { telegram, deadlineAt = Infinity, download = downloadTelegramFile } = {}) {
  const ready = [];
  let unreadable = 0;
  for (let i = 0; i < photos.length; i += 1) {
    if (Date.now() > deadlineAt) {
      unreadable += photos.length - i;
      break;
    }
    const photo = photos[i];
    try {
      // eslint-disable-next-line no-await-in-loop
      const original = await download({ telegram }, photo.fileId, {
        maxBytes: MAX_DOWNLOAD_BYTES, timeoutMs: DOWNLOAD_TIMEOUT_MS,
      });
      // eslint-disable-next-line no-await-in-loop
      const normalised = await normalisePhoto(original);
      if (normalised) ready.push({ photo, ...normalised });
      else unreadable += 1;
    } catch (_) {
      // The reason may name the file; only the count leaves this function.
      unreadable += 1;
    }
  }
  return { ready, unreadable };
}

function drawCover(page, lines, { regular, bold }) {
  const { height } = page.getSize();
  let y = height - 96;
  for (const line of lines) {
    y -= (line.gapBefore || 0) + line.size * 1.5;
    page.drawText(line.text, {
      x: 56, y, size: line.size, font: line.bold ? bold : regular, color: rgb(0.1, 0.1, 0.12),
    });
  }
}

/** Fit `w × h` inside `maxW × maxH`, never enlarging. */
function fit(w, h, maxW, maxH) {
  const scale = Math.min(maxW / w, maxH / h, 1);
  return { width: w * scale, height: h * scale };
}

/**
 * Build one PDF: a cover, then one page per photo with its caption.
 *
 * @param {object} args
 * @param {string} args.title
 * @param {Array<{text, size, bold?, gapBefore?}>} args.coverLines  (lib/truckPhotos/pdfLayout.js)
 * @param {Array<{jpeg: Buffer, width: number, height: number, caption: string}>} args.pages
 * @returns {Promise<Buffer>}
 */
async function buildPdf({ title, coverLines, pages }) {
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafeText(title, 120));
  doc.setCreator('Wenze');
  doc.setProducer('Wenze');
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  drawCover(doc.addPage(PORTRAIT), coverLines, { regular, bold });

  for (const item of pages) {
    // eslint-disable-next-line no-await-in-loop
    const image = await doc.embedJpg(item.jpeg);
    const size = item.width > item.height ? LANDSCAPE : PORTRAIT;
    const page = doc.addPage(size);
    const box = { w: size[0] - MARGIN * 2, h: size[1] - MARGIN * 2 - CAPTION_SPACE };
    const drawn = fit(image.width, image.height, box.w, box.h);
    page.drawImage(image, {
      x: (size[0] - drawn.width) / 2,
      y: MARGIN + CAPTION_SPACE + (box.h - drawn.height) / 2,
      width: drawn.width,
      height: drawn.height,
    });
    page.drawText(pdfSafeText(item.caption, 160), {
      x: MARGIN, y: MARGIN, size: 9, font: regular, color: rgb(0.2, 0.2, 0.22),
    });
  }
  return Buffer.from(await doc.save());
}

module.exports = {
  MAX_DOWNLOAD_BYTES,
  TARGET_BYTES,
  normalisePhoto,
  preparePhotos,
  buildPdf,
};
