'use strict';

/**
 * The videos page of a hand-over PDF: each video's preview, what it is, and a
 * link that opens its message in Telegram (the owner, 6 November 2026 — the
 * person who gets the PDFs is in every driver group).
 *
 * NO VIDEO IS DOWNLOADED. The preview is the small picture Telegram already
 * made for the video (`thumb_file_id`); without one, the entry is words and
 * the link. The link is a real PDF link annotation over the blue text, so a
 * tap in any PDF reader opens it, and the address is printed too.
 *
 * Draws onto a document services/truckPhotos/pdf.js has started; the words
 * come from lib/truckPhotos/pdfLayout.js `videoEntry`.
 */

const { PDFName, PDFString, rgb } = require('pdf-lib');

const PAGE = [612, 792]; // US Letter, portrait
const MARGIN = 40;
const ROW_HEIGHT = 112;
const THUMB_BOX = { w: 140, h: 100 };
const TEXT_X = MARGIN + THUMB_BOX.w + 16;
const LINK_BLUE = rgb(0.05, 0.33, 0.8);

/** A clickable area over `rect` ([x1, y1, x2, y2]) that opens `url`. */
function addLink(doc, page, rect, url) {
  const annotation = doc.context.register(doc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: rect,
    Border: [0, 0, 0],
    A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) },
  }));
  const existing = page.node.Annots();
  if (existing) existing.push(annotation);
  else page.node.set(PDFName.of('Annots'), doc.context.obj([annotation]));
}

function fit(w, h, maxW, maxH) {
  const scale = Math.min(maxW / w, maxH / h, 1);
  return { width: w * scale, height: h * scale };
}

/**
 * @param {PDFDocument} doc
 * @param {Array<{heading, detail, link: string|null, linkText: string, thumb?: {jpeg, width, height}|null}>} videos
 * @param {{regular, bold}} fonts
 * @returns {Promise<number>} the pages added
 */
async function drawVideoPages(doc, videos, { regular, bold }) {
  if (!videos || !videos.length) return 0;
  const perPage = Math.floor((PAGE[1] - MARGIN * 2 - 50) / ROW_HEIGHT);
  let pages = 0;
  for (let start = 0; start < videos.length; start += perPage) {
    const page = doc.addPage(PAGE);
    pages += 1;
    page.drawText(start === 0 ? 'Videos - tap a link to watch it in Telegram' : 'Videos (continued)', {
      x: MARGIN, y: PAGE[1] - MARGIN - 18, size: 16, font: bold, color: rgb(0.1, 0.1, 0.12),
    });
    let top = PAGE[1] - MARGIN - 50;
    for (const video of videos.slice(start, start + perPage)) {
      if (video.thumb && video.thumb.jpeg) {
        // eslint-disable-next-line no-await-in-loop
        const image = await doc.embedJpg(video.thumb.jpeg);
        const drawn = fit(image.width, image.height, THUMB_BOX.w, THUMB_BOX.h);
        page.drawImage(image, {
          x: MARGIN + (THUMB_BOX.w - drawn.width) / 2, y: top - THUMB_BOX.h + (THUMB_BOX.h - drawn.height) / 2,
          width: drawn.width, height: drawn.height,
        });
      } else {
        page.drawRectangle({
          x: MARGIN, y: top - THUMB_BOX.h, width: THUMB_BOX.w, height: THUMB_BOX.h,
          borderColor: rgb(0.75, 0.75, 0.78), borderWidth: 1,
        });
        page.drawText('video', {
          x: MARGIN + THUMB_BOX.w / 2 - 14, y: top - THUMB_BOX.h / 2 - 4, size: 11, font: regular, color: rgb(0.5, 0.5, 0.55),
        });
      }
      page.drawText(video.heading, {
        x: TEXT_X, y: top - 18, size: 11, font: bold, color: rgb(0.1, 0.1, 0.12),
      });
      page.drawText(video.detail, {
        x: TEXT_X, y: top - 34, size: 10, font: regular, color: rgb(0.2, 0.2, 0.22),
      });
      const linkY = top - 56;
      const size = 10;
      page.drawText(video.linkText, {
        x: TEXT_X, y: linkY, size, font: regular, color: video.link ? LINK_BLUE : rgb(0.3, 0.3, 0.32),
      });
      if (video.link) {
        const width = Math.min(regular.widthOfTextAtSize(video.linkText, size), PAGE[0] - TEXT_X - MARGIN);
        page.drawLine({
          start: { x: TEXT_X, y: linkY - 2 }, end: { x: TEXT_X + width, y: linkY - 2 }, thickness: 0.6, color: LINK_BLUE,
        });
        addLink(doc, page, [TEXT_X, linkY - 4, TEXT_X + width, linkY + size + 2], video.link);
      }
      top -= ROW_HEIGHT;
    }
  }
  return pages;
}

module.exports = { drawVideoPages };
