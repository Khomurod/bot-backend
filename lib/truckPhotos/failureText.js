'use strict';

/**
 * What the recipient is told, privately, when a hand-over did not become a PDF.
 * Pure.
 *
 * NOTHING IS EVER WRITTEN IN THE DRIVER'S GROUP (the owner, 6 November 2026).
 * When no PDF can be made — no photos, a model that could not tell, a send
 * that failed — the one person who receives the PDFs is told, in their private
 * chat with the bot, what failed and why, and what would fix it.
 *
 * FIXED PHRASES ONLY. Nothing a model wrote and nothing from the message
 * itself goes in, and no link: the chat's title, the person who marked it and
 * the time are enough to find the message. The title is a string somebody
 * typed, so any URL in it is taken out too. The same "why" sentence is what
 * `truck_photo_reports.reason` stores, so Settings shows exactly what the
 * recipient was told.
 */

const { stripUrls } = require('../security/redactUrls');
const { chicagoTime } = require('./pdfLayout');

const REASON_CODES = Object.freeze([
  'no_photos', 'already_sent', 'all_excluded', 'unclear', 'ai_unavailable',
  'download_failed', 'not_delivered', 'part_not_delivered', 'interrupted', 'too_large',
]);

function hoursText(hours) {
  const n = Number(hours) > 0 ? Number(hours) : 3;
  return `${n} hour${n === 1 ? '' : 's'}`;
}

/**
 * The "why", one sentence.
 *
 * @param {string} code  one of REASON_CODES
 * @param {object} [ctx] {kind, lookbackHours, photoCount, part, parts}
 */
function reasonText(code, ctx = {}) {
  const kind = ctx.kind === 'inbound' ? 'inbound' : 'outbound';
  switch (code) {
    case 'no_photos':
      return `No photos or videos from the ${hoursText(ctx.lookbackHours)} before the message were found in the chat.`;
    case 'already_sent':
      return 'Every photo and video from that time was already in an earlier PDF.';
    case 'all_excluded':
      return `None of the ${Number(ctx.photoCount) || 0} photos looked like the truck (documents, screenshots or people).`;
    case 'unclear':
      return 'Wenze could not tell whether the message is about handing over or returning the truck.';
    case 'ai_unavailable':
      return `The message says more than "${kind}", and the AI that checks such messages could not be reached, so Wenze did not guess.`;
    case 'download_failed':
      return 'None of the photos could be downloaded from Telegram.';
    case 'not_delivered':
      return 'Telegram did not accept the PDF.';
    case 'part_not_delivered':
      return `Part ${Number(ctx.part) || '?'} of ${Number(ctx.parts) || '?'} could not be sent; the parts before it were.`;
    case 'interrupted':
      return 'Wenze stopped (a restart) before it could finish this PDF.';
    case 'too_large':
      return 'The PDF came out larger than Telegram accepts.';
    default:
      return 'Something went wrong while making the PDF.';
  }
}

/** What would fix it. */
function adviceText(code, kind) {
  const word = kind === 'inbound' ? 'inbound' : 'outbound';
  if (code === 'no_photos' || code === 'already_sent' || code === 'all_excluded') {
    return `Send the truck photos in the group, then write "${word}" again.`;
  }
  if (code === 'unclear' || code === 'ai_unavailable') {
    return `If it is the truck, write just "${word}" in the group, as a reply to the photos.`;
  }
  if (code === 'interrupted') return `If no PDF arrived for it, write "${word}" in the group again.`;
  return `Write "${word}" in the group again to try once more.`;
}

/**
 * The whole private message. Plain text (no parse mode).
 *
 * @param {object} args
 * @param {string} args.code
 * @param {'outbound'|'inbound'} args.kind
 * @param {string} [args.chatTitle]
 * @param {string} [args.markedBy]
 * @param {Date|string} [args.at]
 * @param {object} [args.ctx]  extra values for the reason sentence
 */
function failureMessage({ code, kind, chatTitle = null, markedBy = null, at = null, ctx = {} }) {
  const title = stripUrls(String(chatTitle || 'a driver group')).replace(/\s+/g, ' ').trim().slice(0, 120);
  const who = stripUrls(String(markedBy || 'someone')).replace(/\s+/g, ' ').trim().slice(0, 80);
  return [
    'Truck photos: no PDF was made.',
    `${kind === 'inbound' ? 'INBOUND' : 'OUTBOUND'} in "${title}", marked by ${who}, ${chicagoTime(at)}.`,
    `Why: ${reasonText(code, { ...ctx, kind })}`,
    adviceText(code, kind),
  ].join('\n');
}

module.exports = {
  REASON_CODES, reasonText, adviceText, failureMessage,
};
