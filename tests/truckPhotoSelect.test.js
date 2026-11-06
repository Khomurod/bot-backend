'use strict';

/**
 * lib/truckPhotos/selectPhotos.js — which remembered photos go into a PDF.
 * The owner's rule: a reply takes the replied photo's album and its
 * neighbours; a plain word takes the last three hours; photos after the word
 * are ignored; a photo already sent is never sent again; one picture forwarded
 * twice is in once; in the order they were sent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { selectPhotos, windowStart } = require('../lib/truckPhotos/selectPhotos');

const T = (hhmm) => new Date(`2026-11-06T${hhmm}:00Z`);
let nextId = 1;
function photo(messageId, at, over = {}) {
  nextId += 1;
  return {
    id: nextId, messageId, mediaGroupId: null, fileUniqueId: `u${messageId}`, sentAt: T(at), reportId: null, ...over,
  };
}
const ids = (out) => out.photos.map((p) => p.messageId);

test('a plain word takes every photo of the last three hours, album and singles alike, oldest first', () => {
  const photos = [
    photo(10, '08:59'), // too old
    photo(11, '09:01', { mediaGroupId: 'A' }), photo(12, '09:01', { mediaGroupId: 'A' }),
    photo(13, '10:30'), photo(14, '11:15'),
  ];
  const out = selectPhotos({ photos, trigger: { messageId: 20, sentAt: T('12:00') }, lookbackHours: 3 });
  assert.deepEqual(ids(out), [11, 12, 13, 14]);
  assert.deepEqual(out.from, T('09:00'));
});

test('the window follows the setting', () => {
  const photos = [photo(10, '06:30'), photo(11, '10:30')];
  const out = selectPhotos({ photos, trigger: { messageId: 20, sentAt: T('12:00') }, lookbackHours: 6 });
  assert.deepEqual(ids(out), [10, 11]);
});

test('photos sent after the word are ignored — by message order, exact to the message', () => {
  const photos = [photo(10, '11:00'), photo(21, '12:00'), photo(22, '12:05')];
  const out = selectPhotos({ photos, trigger: { messageId: 20, sentAt: T('12:00') }, lookbackHours: 3 });
  assert.deepEqual(ids(out), [10], 'same second as the word but after it in the chat is after it');
});

test('a reply to a photo takes its album and the photos from three hours before it to the word', () => {
  const photos = [
    photo(5, '04:30'), // before the anchor's window
    photo(6, '05:30'), // a neighbour inside the anchor's window
    photo(7, '08:00', { mediaGroupId: 'ALB' }), photo(8, '08:00', { mediaGroupId: 'ALB' }),
    photo(9, '08:00', { mediaGroupId: 'ALB' }),
    photo(15, '11:00'), // a single, before the word
  ];
  const anchor = { messageId: 8, mediaGroupId: 'ALB', sentAt: T('08:00') };
  const out = selectPhotos({ photos, trigger: { messageId: 30, sentAt: T('12:00') }, anchor, lookbackHours: 3 });
  assert.deepEqual(ids(out), [6, 7, 8, 9, 15]);
  assert.deepEqual(windowStart({ trigger: { sentAt: T('12:00') }, anchor, lookbackHours: 3 }), T('05:00'));
});

test('a photo captioned with the word keeps the rest of its album, numbered after it', () => {
  const photos = [
    photo(40, '12:00', { mediaGroupId: 'CAP' }), // the caption "outbound" is on this one
    photo(41, '12:00', { mediaGroupId: 'CAP' }), photo(42, '12:00', { mediaGroupId: 'CAP' }),
    photo(43, '12:01'), // a later single: after the word
  ];
  const anchor = { messageId: 40, mediaGroupId: 'CAP', sentAt: T('12:00') };
  const out = selectPhotos({ photos, trigger: { messageId: 40, sentAt: T('12:00') }, anchor, lookbackHours: 3 });
  assert.deepEqual(ids(out), [40, 41, 42]);
});

test('a photo already in a report is not sent again, and is counted', () => {
  const photos = [photo(10, '10:00', { reportId: 3 }), photo(11, '10:05', { reportId: 3 }), photo(12, '11:00')];
  const out = selectPhotos({ photos, trigger: { messageId: 20, sentAt: T('12:00') }, lookbackHours: 3 });
  assert.deepEqual(ids(out), [12]);
  assert.equal(out.alreadySent, 2);

  const none = selectPhotos({
    photos: photos.slice(0, 2), trigger: { messageId: 20, sentAt: T('12:00') }, lookbackHours: 3,
  });
  assert.deepEqual(none.photos, []);
  assert.equal(none.alreadySent, 2, 'so the recipient can be told why there is nothing');
});

test('one picture forwarded twice is in once — the first time it was sent', () => {
  const photos = [photo(10, '10:00', { fileUniqueId: 'same' }), photo(11, '10:30', { fileUniqueId: 'same' }), photo(12, '11:00')];
  const out = selectPhotos({ photos, trigger: { messageId: 20, sentAt: T('12:00') }, lookbackHours: 3 });
  assert.deepEqual(ids(out), [10, 12]);
  assert.equal(out.duplicates, 1);
});

test('the same moment is ordered by message, whatever order the rows came in', () => {
  const photos = [photo(13, '10:00'), photo(11, '10:00'), photo(12, '10:00')];
  const out = selectPhotos({ photos, trigger: { messageId: 20, sentAt: T('12:00') }, lookbackHours: 3 });
  assert.deepEqual(ids(out), [11, 12, 13]);
});

test('no photos is an empty selection, not an error', () => {
  const out = selectPhotos({ photos: [], trigger: { messageId: 20, sentAt: T('12:00') }, lookbackHours: 3 });
  assert.deepEqual(out.photos, []);
  assert.equal(out.alreadySent, 0);
});
