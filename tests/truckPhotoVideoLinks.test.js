'use strict';

/**
 * Videos in the hand-over PDF are links to their message in Telegram
 * (lib/truckPhotos/videoLinks.js, pdfLayout.js): a supergroup's message has
 * one, a basic group's has none; how long a video is; how the cover and the
 * caption count videos; and the note for a photo Wenze saw only with the reply.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { telegramMessageLink, durationText } = require('../lib/truckPhotos/videoLinks');
const layout = require('../lib/truckPhotos/pdfLayout');

const AT = new Date('2026-11-06T19:45:00Z'); // 1:45 PM in Chicago
const texts = (lines) => lines.map((l) => l.text);

test('a supergroup message has a t.me/c link; a basic group, a bad id or a private chat has none', () => {
  assert.equal(telegramMessageLink('-1003956955141', 812), 'https://t.me/c/3956955141/812');
  assert.equal(telegramMessageLink(-1003956955141, '33'), 'https://t.me/c/3956955141/33');
  assert.equal(telegramMessageLink('-4012345678', 812), null);
  assert.equal(telegramMessageLink('777000', 812), null);
  assert.equal(telegramMessageLink('-1003956955141', 0), null);
  assert.equal(telegramMessageLink('-1003956955141', null), null);
});

test('a video\'s length', () => {
  assert.deepEqual([0, 5, 35, 65, 245, 3723].map(durationText), ['0:00', '0:05', '0:35', '1:05', '4:05', '1:02:03']);
  assert.equal(durationText(null), null);
  assert.equal(durationText(-1), null);
});

test('the cover counts the videos and says where their links are; a later part points back to part 1', () => {
  const base = { kind: 'outbound', groupName: 'g', triggerAt: AT, photoCount: 4 };
  assert.ok(texts(layout.coverLines({ ...base, videoCount: 2, videosHere: true })).includes('Videos: 2 - links on the next page'));
  assert.ok(texts(layout.coverLines({ ...base, videoCount: 2, part: 2, parts: 2 })).includes('Videos: 2 - links in part 1'));
  assert.ok(!texts(layout.coverLines(base)).some((t) => t.startsWith('Videos')));
});

test('the caption and an inbound\'s "Outbound on" line count photos and videos', () => {
  const caption = layout.deliveryCaption({
    kind: 'inbound', groupName: 'g', triggerAt: AT, photoCount: 4, videoCount: 2,
    outbound: { at: AT, photoCount: 3, videoCount: 1 },
  });
  assert.match(caption, /4 photos, 2 videos/);
  assert.match(caption, /Outbound on Nov 6, 2026, 3 photos, 1 video$/m);
  assert.equal(layout.mediaCount(0, 2), '2 videos');
  assert.equal(layout.mediaCount(1, 0), '1 photo');
});

test('one video\'s entry: what it is on two short lines, and its link', () => {
  const entry = layout.videoEntry({
    number: 1, total: 2, sentAt: AT, fromName: 'Tashayla Brooks', durationSeconds: 35, chatId: '-1003956955141', messageId: 812,
  });
  assert.deepEqual(entry, {
    heading: 'Video 1 of 2 - 0:35',
    detail: 'Nov 6, 2026 1:45 PM CST - sent by Tashayla Brooks',
    link: 'https://t.me/c/3956955141/812',
    linkText: 'https://t.me/c/3956955141/812',
  });
  const none = layout.videoEntry({ number: 1, total: 1, sentAt: AT, chatId: '-4012345678', messageId: 5 });
  assert.equal(none.link, null);
  assert.match(none.linkText, /No link in this chat/);
});

test('a photo Wenze saw only with the reply: the cover and the caption say photos may be missing', () => {
  const note = { kind: 'photo', sentAt: new Date('2026-10-27T20:29:56Z') };
  const cover = texts(layout.coverLines({ kind: 'outbound', groupName: 'g', triggerAt: AT, photoCount: 1, anchorNote: note }));
  assert.match(cover.join(' '), /the photo this was a reply to was sent Oct 27, 2026 3:29 PM CDT, before Wenze saw it/);
  assert.match(cover.join(' '), /forward them to the group and write "outbound" again/);
  assert.ok(cover.every((t) => t.length <= 75), 'no cover line runs past the page');
  const caption = layout.deliveryCaption({ kind: 'outbound', groupName: 'g', triggerAt: AT, photoCount: 1, anchorNote: note });
  assert.match(caption, /photos sent with it may be missing/);
  assert.doesNotMatch(layout.deliveryCaption({ kind: 'outbound', groupName: 'g', triggerAt: AT, photoCount: 1 }), /missing/);
});
