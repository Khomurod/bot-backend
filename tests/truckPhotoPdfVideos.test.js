'use strict';

/**
 * The videos page of a hand-over PDF, with the real pdf-lib and sharp
 * (services/truckPhotos/pdfVideos.js, pdf.js): it comes right after the cover,
 * each video has a real link annotation that opens its message, a video
 * without a preview is still listed, more videos than fit go on to another
 * page, and only the small previews are downloaded — never a video.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { PDFDocument, PDFName } = require('pdf-lib');

const { buildPdf, normalisePhoto, prepareThumbnails } = require('../services/truckPhotos/pdf');
const { coverLines, videoEntry } = require('../lib/truckPhotos/pdfLayout');

const AT = new Date('2026-11-06T19:45:00Z');
const jpeg = (width, height) => sharp({
  create: { width, height, channels: 3, background: { r: 40, g: 90, b: 140 } },
}).jpeg({ quality: 85 }).toBuffer();

function entry(i, total, chatId = '-1003956955141') {
  return videoEntry({
    number: i + 1, total, sentAt: AT, fromName: 'Tashayla Brooks', durationSeconds: 30 + i, chatId, messageId: 800 + i,
  });
}

/** Every link annotation's URL, page by page. */
function linksOf(doc) {
  return doc.getPages().map((page) => {
    const annots = page.node.Annots();
    if (!annots) return [];
    return annots.asArray().map((ref) => {
      const annot = doc.context.lookup(ref);
      const action = annot.lookup(PDFName.of('A'));
      return action.lookup(PDFName.of('URI')).decodeText();
    });
  });
}

test('the videos page comes right after the cover, each video a link to its message; then the photos', async () => {
  const thumb = await normalisePhoto(await jpeg(320, 180));
  const photo = await normalisePhoto(await jpeg(400, 300));
  const buffer = await buildPdf({
    title: 'outbound 004',
    coverLines: coverLines({ kind: 'outbound', groupName: 'g', triggerAt: AT, photoCount: 1, videoCount: 2, videosHere: true }),
    videos: [{ ...entry(0, 2), thumb }, { ...entry(1, 2), thumb: null }],
    pages: [{ ...photo, caption: 'Photo 1 of 1' }],
  });
  const doc = await PDFDocument.load(buffer);
  assert.equal(doc.getPageCount(), 3, 'cover, videos, one photo');
  assert.deepEqual(linksOf(doc), [[], ['https://t.me/c/3956955141/800', 'https://t.me/c/3956955141/801'], []]);
});

test('many videos run on to another page; a chat with no message links lists them without a link', async () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ ...entry(i, 8), thumb: null }));
  const doc = await PDFDocument.load(await buildPdf({ title: 't', coverLines: [{ text: 'OUTBOUND', size: 30 }], videos: many, pages: [] }));
  assert.equal(doc.getPageCount(), 3, 'a cover and two pages of videos');
  assert.equal(linksOf(doc).flat().length, 8);

  const basic = await PDFDocument.load(await buildPdf({
    title: 't', coverLines: [{ text: 'OUTBOUND', size: 30 }], videos: [{ ...entry(0, 1, '-4012345678'), thumb: null }], pages: [],
  }));
  assert.equal(basic.getPageCount(), 2);
  assert.deepEqual(linksOf(basic).flat(), []);
});

test('only the small previews are downloaded; a video without one, or a failed one, is listed without it', async () => {
  const asked = [];
  const good = await jpeg(320, 180);
  const download = async (_deps, fileId, limits) => {
    asked.push([fileId, limits.maxBytes]);
    if (fileId === 'broken') throw new Error('Telegram answered 400');
    return good;
  };
  const out = await prepareThumbnails(
    [{ fileId: 'VIDEO1', thumbFileId: 'thumb1' }, { fileId: 'VIDEO2', thumbFileId: null }, { fileId: 'VIDEO3', thumbFileId: 'broken' }],
    { telegram: {}, download },
  );
  assert.deepEqual(asked, [['thumb1', 2 * 1024 * 1024], ['broken', 2 * 1024 * 1024]], 'never a video file id');
  assert.equal(out.length, 3);
  assert.ok(out[0] && out[0].jpeg);
  assert.equal(out[1], null);
  assert.equal(out[2], null);
});
