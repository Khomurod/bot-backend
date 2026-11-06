'use strict';

/**
 * What the truck-photo PDF says, as data. Pure — services/truckPhotos/pdf.js
 * only draws it.
 *
 * THE COVER (the owner, 6 November 2026): OUTBOUND or INBOUND; the driver; the
 * truck as Wenze knows it — number, fleet and, for an owner's truck, the owner
 * (lib/drivers/truckIdentity.js: by the truck an owner-operator, by the driver
 * a company driver, docs/architecture/fleet-type-and-unit-identity.md); the
 * chat; when it was marked, in Chicago time; who marked it; how many photos and
 * how many a model left out as not the truck. An INBOUND cover says when the
 * truck went out — "Outbound on <date>, <n> photos" — or "No outbound on
 * record", so the two PDFs can be laid side by side.
 *
 * VIDEOS (the owner, 6 November 2026) are counted on the cover and listed on
 * the page after it, each with a link to its message in Telegram
 * (lib/truckPhotos/videoLinks.js) — never the video itself.
 *
 * A PHOTO WENZE SAW LATE. A bot cannot read a chat's history; it knows a photo
 * only from the moment it arrives while Truck Photos is on. When the word
 * replies to a photo Wenze had not seen — sent before the switch went on —
 * Telegram hands over that one photo with the reply, but not the rest of its
 * album. The PDF then says so on the cover and in its caption, rather than
 * quietly holding one photo where there were four (the owner, 6 November 2026).
 *
 * In English, every string through pdfSafeText (the PDF's font is WinAnsi).
 */

const { DateTime } = require('luxon');
const { truckOfProfile } = require('../drivers/truckIdentity');
const { pdfSafeText } = require('./pdfText');
const { telegramMessageLink, durationText } = require('./videoLinks');

const ZONE = 'America/Chicago';
const FLEET_LABEL = Object.freeze({
  company: 'Company', lease: 'Lease', owner_operator: 'Owner-Operator', unknown: 'fleet not known',
});
const TITLE = Object.freeze({ outbound: 'OUTBOUND', inbound: 'INBOUND' });
const SUBTITLE = Object.freeze({ outbound: 'Truck hand-over', inbound: 'Truck return' });

function toDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? DateTime.fromJSDate(date).setZone(ZONE) : null;
}

/** "Nov 6, 2026 10:14 AM CST", or "time unknown". */
function chicagoTime(value) {
  const dt = toDateTime(value);
  return dt ? dt.toFormat('LLL d, yyyy h:mm a ZZZZ') : 'time unknown';
}

/** "Nov 6, 2026". */
function chicagoDay(value) {
  const dt = toDateTime(value);
  return dt ? dt.toFormat('LLL d, yyyy') : 'date unknown';
}

/** "2026-11-06" for a file name. */
function chicagoIsoDay(value) {
  const dt = toDateTime(value);
  return dt ? dt.toISODate() : 'undated';
}

/** "John Smith", "John Smith / Bob Lee" for a team, or null. */
function driverNameOf(profile) {
  if (!profile) return null;
  const first = [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim();
  const second = [profile.secondary_first_name, profile.secondary_last_name].filter(Boolean).join(' ').trim();
  if (first && second) return `${first} / ${second}`;
  return first || second || null;
}

/** The truck the profile names: number, fleet, owner, and how to say it. */
function truckOf(profile, groupName) {
  const unit = String(profile?.unit_number ?? '').trim() || null;
  const { fleetType, owner } = truckOfProfile(profile || {}, groupName || null);
  const bits = [unit || 'number not on record', FLEET_LABEL[fleetType] || FLEET_LABEL.unknown];
  if (owner) bits.push(`owner ${owner}`);
  return { unit, fleetType, owner, text: bits.join(' - ') };
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "4 photos", "4 photos, 2 videos", "2 videos". */
function mediaCount(photoCount, videoCount = 0) {
  const photos = plural(Number(photoCount) || 0, 'photo');
  const videos = Number(videoCount) || 0;
  if (!videos) return photos;
  return Number(photoCount) ? `${photos}, ${plural(videos, 'video')}` : plural(videos, 'video');
}

/** "Outbound on Nov 1, 2026, 38 photos" — or "No outbound on record". */
function outboundLine(outbound) {
  if (!outbound || !outbound.at) return 'No outbound on record';
  return `Outbound on ${chicagoDay(outbound.at)}, ${mediaCount(outbound.photoCount, outbound.videoCount)}`;
}

/**
 * The words about a photo the reply pointed at that Wenze had not seen when it
 * was sent: `anchorNote` is `{kind: 'photo'|'video', sentAt}`.
 */
function lateAnchorLines(anchorNote, kind) {
  if (!anchorNote) return [];
  const what = anchorNote.kind === 'video' ? 'video' : 'photo';
  const word = kind === 'inbound' ? 'inbound' : 'outbound';
  // Three short lines: the cover's font is large and a line is never wrapped.
  return [
    `Note: the ${what} this was a reply to was sent ${chicagoTime(anchorNote.sentAt)},`,
    'before Wenze saw it, so photos sent with it may be missing.',
    `To include them, forward them to the group and write "${word}" again.`,
  ];
}

/**
 * The cover page, line by line.
 *
 * @returns {Array<{text: string, size: number, bold?: boolean, gapBefore?: number}>}
 */
function coverLines({
  kind, profile = null, groupName = null, triggerAt, markedBy = null,
  photoCount = 0, excludedCount = 0, unreadableCount = 0, omittedCount = 0, outbound = null,
  part = 1, parts = 1, firstNumber = 1, lastNumber = photoCount, videoCount = 0, videosHere = false,
  anchorNote = null,
}) {
  const truck = truckOf(profile, groupName);
  const photos = `Photos: ${photoCount}${excludedCount ? ` (excluded ${excludedCount} - not the truck)` : ''}`;
  const lines = [
    { text: TITLE[kind] || String(kind || '').toUpperCase(), size: 30, bold: true },
    { text: SUBTITLE[kind] || '', size: 14 },
    { text: `Driver: ${driverNameOf(profile) || 'not on record'}`, size: 13, gapBefore: 18 },
    { text: `Truck: ${truck.text}`, size: 13 },
    { text: `Chat: ${groupName || 'unknown'}`, size: 13 },
    { text: `Marked: ${chicagoTime(triggerAt)}`, size: 13 },
    { text: `Marked by: ${markedBy || 'unknown'}`, size: 13 },
    { text: photos, size: 13 },
  ];
  if (videoCount) {
    lines.push({
      text: `Videos: ${videoCount}${videosHere ? ' - links on the next page' : ' - links in part 1'}`, size: 13,
    });
  }
  if (unreadableCount) {
    lines.push({ text: `${plural(unreadableCount, 'photo')} could not be downloaded from Telegram`, size: 11 });
  }
  if (omittedCount) {
    lines.push({ text: `${plural(omittedCount, 'earlier photo')} left out (too many for one hand-over)`, size: 11 });
  }
  lateAnchorLines(anchorNote, kind).forEach((text, i) => {
    lines.push({ text, size: 11, bold: true, gapBefore: i === 0 ? 10 : 0 });
  });
  if (kind === 'inbound') lines.push({ text: outboundLine(outbound), size: 13, bold: true, gapBefore: 10 });
  if (parts > 1) {
    lines.push({ text: `Part ${part} of ${parts} (photos ${firstNumber}-${lastNumber})`, size: 13, bold: true, gapBefore: 10 });
  }
  lines.push({
    text: "Made by Wenze from the photos sent in the driver's Telegram group.", size: 9, gapBefore: 24,
  });
  return lines.map((line) => ({ ...line, text: pdfSafeText(line.text, 160) }));
}

/**
 * One video's entry on the videos page: what it is, and the link to its
 * message (or, in a chat that has no message links, where to find it).
 *
 * @returns {{heading: string, detail: string, link: string|null, linkText: string}}
 */
function videoEntry({
  number, total, sentAt, fromName, durationSeconds, chatId, messageId,
}) {
  const length = durationText(durationSeconds);
  const link = telegramMessageLink(chatId, messageId);
  return {
    heading: pdfSafeText(`Video ${number} of ${total}${length ? ` - ${length}` : ''}`, 40),
    detail: pdfSafeText(`${chicagoTime(sentAt)} - sent by ${fromName || 'unknown'}`, 75),
    link,
    linkText: link || 'No link in this chat - find it there at the time above',
  };
}

/** "Photo 3 of 42 - Nov 6, 2026 10:02 AM CST - sent by John Smith". */
function photoCaption({ number, total, sentAt, fromName }) {
  return pdfSafeText(
    `Photo ${number} of ${total} - ${chicagoTime(sentAt)} - sent by ${fromName || 'unknown'}`, 160,
  );
}

/** `outbound_562_2026-11-06.pdf`, `inbound_562_2026-11-06_part1of2.pdf`. */
function fileName({ kind, unit, at, part = 1, parts = 1 }) {
  const safeUnit = String(unit || '').replace(/[^A-Za-z0-9-]+/g, '') || 'no-unit';
  const suffix = parts > 1 ? `_part${part}of${parts}` : '';
  return `${kind === 'inbound' ? 'inbound' : 'outbound'}_${safeUnit}_${chicagoIsoDay(at)}${suffix}.pdf`;
}

/** The short caption on the document in the recipient's chat. Plain text. */
function deliveryCaption({
  kind, profile = null, groupName = null, triggerAt, photoCount, excludedCount = 0, part = 1, parts = 1, outbound = null,
  videoCount = 0, anchorNote = null,
}) {
  const truck = truckOf(profile, groupName);
  const lines = [
    `${TITLE[kind] || kind} - ${driverNameOf(profile) || groupName || 'driver not on record'}`,
    `Truck ${truck.text}`,
    `${chicagoTime(triggerAt)} - ${mediaCount(photoCount, videoCount)}${excludedCount ? ` (excluded ${excludedCount})` : ''}`,
  ];
  if (kind === 'inbound') lines.push(outboundLine(outbound));
  if (parts > 1) lines.push(`Part ${part} of ${parts}`);
  if (anchorNote && part === 1) lines.push(lateAnchorLines(anchorNote, kind).join(' '));
  return lines.join('\n').slice(0, 1000);
}

module.exports = {
  ZONE,
  FLEET_LABEL,
  chicagoTime,
  chicagoDay,
  driverNameOf,
  truckOf,
  outboundLine,
  mediaCount,
  lateAnchorLines,
  coverLines,
  videoEntry,
  photoCaption,
  fileName,
  deliveryCaption,
};
