'use strict';

/**
 * Building and sending one hand-over's PDFs, part by part, to the recipient.
 *
 * The pages are planned already (lib/truckPhotos/pagePlan.js): the truck
 * photos in parts, numbered across the parts; the hand-over form on its own
 * pages after the last part's photos; the videos page in part 1. Each part has
 * its own cover and its own caption in the recipient's chat.
 *
 * NOTHING IS STORED: each PDF is built in memory, sent, and dropped
 * (services/truckPhotos/pdf.js). What comes back is what was delivered — the
 * photos (to be marked as sent) and the message each part became in the
 * recipient's chat — or which part failed and why.
 */

const {
  coverLines, photoCaption, fileName, deliveryCaption, truckOf,
} = require('../../lib/truckPhotos/pdfLayout');

/** Telegram takes a document of up to 50 MB from a bot. */
const MAX_PDF_BYTES = 49 * 1024 * 1024;

/** One page of the PDF: a truck photo, or a page of the hand-over form. */
function pageOf(item, { number, total, form = false }) {
  return {
    jpeg: item.jpeg,
    width: item.width,
    height: item.height,
    caption: photoCaption({
      number, total, sentAt: item.photo.sentAt, fromName: item.photo.fromName, form,
    }),
  };
}

/**
 * @param {object} args
 * @param {object} args.plan          lib/truckPhotos/pagePlan.js `planPages`
 * @param {Array} args.videos         the videos, in order
 * @param {Array} args.videoPages     their entries for the videos page
 * @param {object} args.cover         what every cover and caption says:
 *   {kind, profile, groupName, triggerAt, markedBy, truckDecision, outbound,
 *    anchorNote, unreadableCount, omittedCount, checkedTotal}
 * @param {{telegram, recipient}} args.to
 * @param {{buildPdf, sendPdf}} deps
 * @returns {Promise<{delivered: Array, messages: Array<{part: number, messageId: number|null}>,
 *   failure: null|{code: string, part: number, parts: number}}>}
 *   `delivered` holds every photo (and video) in a part that went out
 */
async function sendReportParts({
  plan, videos = [], videoPages = [], cover, to,
}, deps) {
  const { parts } = plan;
  const unit = truckOf(cover.profile, cover.groupName, cover.truckDecision).unit;
  const delivered = [];
  const messages = [];
  let number = 0;
  for (let p = 0; p < parts.length; p += 1) {
    const last = p === parts.length - 1;
    const first = number + 1;
    const pages = parts[p].map((item) => {
      number += 1;
      return pageOf(item, { number, total: plan.truck.length });
    });
    if (last) {
      plan.forms.forEach((item, i) => pages.push(pageOf(item, { number: i + 1, total: plan.forms.length, form: true })));
    }
    const shared = {
      ...cover,
      photoCount: plan.truck.length,
      excludedCount: plan.leftOut.length,
      formCount: plan.forms.length,
      uncheckedCount: plan.unchecked,
      part: p + 1,
      parts: parts.length,
      videoCount: videos.length,
    };
    // eslint-disable-next-line no-await-in-loop
    const buffer = await deps.buildPdf({
      title: `${cover.kind} ${unit || ''}`.trim(),
      coverLines: coverLines({
        ...shared, leftOutText: plan.leftOutText, firstNumber: first, lastNumber: number, videosHere: p === 0,
      }),
      pages,
      videos: p === 0 ? videoPages : [],
    });
    if (buffer.length > MAX_PDF_BYTES) {
      return { delivered, messages, failure: { code: 'too_large', part: p + 1, parts: parts.length } };
    }
    let sent;
    try {
      // eslint-disable-next-line no-await-in-loop
      sent = await deps.sendPdf({
        telegram: to.telegram,
        recipient: to.recipient,
        buffer,
        fileName: fileName({
          kind: cover.kind, unit, at: cover.triggerAt, part: p + 1, parts: parts.length,
        }),
        caption: deliveryCaption(shared),
      });
    } catch (err) {
      console.warn('[TRUCK PHOTOS] a PDF was not delivered:', err?.response?.error_code || err?.name || 'error');
      return {
        delivered,
        messages,
        failure: { code: p === 0 ? 'not_delivered' : 'part_not_delivered', part: p + 1, parts: parts.length },
      };
    }
    messages.push({ part: p + 1, messageId: Number.isInteger(sent?.message_id) ? sent.message_id : null });
    delivered.push(...parts[p]);
    if (last) delivered.push(...plan.forms);
    if (p === 0) delivered.push(...videos.map((video) => ({ photo: video })));
  }
  return { delivered, messages, failure: null };
}

module.exports = { MAX_PDF_BYTES, pageOf, sendReportParts };
