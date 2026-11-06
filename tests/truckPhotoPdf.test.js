'use strict';

/**
 * services/truckPhotos/pdf.js with the real pdf-lib and sharp: a PDF is a cover
 * plus one page per photo; each photo is re-encoded to ~1600 px, turned the
 * way the phone held it, and baseline JPEG; a download that fails or a file
 * that is not a picture is counted, never fatal; and nothing is written to disk.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');

const { buildPdf, normalisePhoto, preparePhotos } = require('../services/truckPhotos/pdf');
const { coverLines } = require('../lib/truckPhotos/pdfLayout');

const jpeg = (width, height, extra = {}) => sharp({
  create: { width, height, channels: 3, background: { r: 120, g: 40, b: 30 } },
}).jpeg({ quality: 90 }).withMetadata(extra).toBuffer();

test('pages = photos + the cover, a landscape photo on a landscape page', async () => {
  const photos = [];
  for (const [w, h] of [[400, 300], [300, 400], [500, 500]]) {
    // eslint-disable-next-line no-await-in-loop
    const n = await normalisePhoto(await jpeg(w, h));
    photos.push({ ...n, caption: `Photo ${photos.length + 1} of 3 - sent by Шерзод 🚛` });
  }
  const buffer = await buildPdf({
    title: 'outbound 562',
    coverLines: coverLines({ kind: 'outbound', profile: { first_name: 'Ёқуб' }, groupName: 'g', triggerAt: new Date(), photoCount: 3 }),
    pages: photos,
  });
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
  const doc = await PDFDocument.load(buffer);
  assert.equal(doc.getPageCount(), 4, 'a cover and three photos');
  const sizes = doc.getPages().map((p) => { const { width, height } = p.getSize(); return [width, height]; });
  assert.deepEqual(sizes, [[612, 792], [792, 612], [612, 792], [612, 792]]);
  assert.equal(doc.getTitle(), 'outbound 562');
});

test('a big phone photo comes out ~1600 px on its long side, turned upright, as a baseline JPEG', async () => {
  // EXIF orientation 6: the camera held sideways. The stored pixels are 3000 × 2000.
  const original = await jpeg(3000, 2000, { orientation: 6 });
  const n = await normalisePhoto(original);
  assert.deepEqual([n.width, n.height], [1067, 1600], 'rotated, so the long side is now the height');
  const meta = await sharp(n.jpeg).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.isProgressive, false, 'every PDF reader can show a baseline JPEG');
  assert.ok(!meta.orientation || meta.orientation === 1, 'no orientation flag left to apply twice');
  assert.ok(n.jpeg.length < original.length);
});

test('a small photo is not enlarged; something that is not a picture is null', async () => {
  const n = await normalisePhoto(await jpeg(320, 240));
  assert.deepEqual([n.width, n.height], [320, 240]);
  assert.equal(await normalisePhoto(Buffer.from('not a picture')), null);
  assert.equal(await normalisePhoto(Buffer.alloc(0)), null);
});

test('downloads one at a time; a failed or unreadable download is counted, not fatal', async () => {
  const good = await jpeg(400, 300);
  const order = [];
  let inFlight = 0;
  const download = async (_deps, fileId, limits) => {
    inFlight += 1;
    assert.equal(inFlight, 1, 'never two downloads at once');
    assert.equal(limits.maxBytes, 20 * 1024 * 1024);
    order.push(fileId);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight -= 1;
    if (fileId === 'gone') throw new Error('Telegram answered 400 for this file');
    if (fileId === 'pdf') return Buffer.from('%PDF-1.4');
    return good;
  };
  const photos = [{ fileId: 'a' }, { fileId: 'gone' }, { fileId: 'pdf' }, { fileId: 'b' }];
  const out = await preparePhotos(photos, { telegram: {}, download });
  assert.deepEqual(order, ['a', 'gone', 'pdf', 'b']);
  assert.equal(out.ready.length, 2);
  assert.equal(out.unreadable, 2);
  assert.equal(out.ready[1].photo.fileId, 'b');
});

test('past the deadline, the photos not reached are counted as not downloaded', async () => {
  const out = await preparePhotos([{ fileId: 'a' }, { fileId: 'b' }], {
    telegram: {}, deadlineAt: Date.now() - 1, download: async () => { throw new Error('not called'); },
  });
  assert.deepEqual(out, { ready: [], unreadable: 2 });
});

test('nothing is written to disk', async () => {
  const before = fs.readdirSync(os.tmpdir()).length;
  const n = await normalisePhoto(await jpeg(200, 100));
  await buildPdf({ title: 'x', coverLines: [{ text: 'OUTBOUND', size: 30 }], pages: [{ ...n, caption: 'c' }] });
  assert.equal(fs.readdirSync(os.tmpdir()).length, before);
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'truckPhotos', 'pdf.js'), 'utf8');
  assert.doesNotMatch(src, /require\(['"](?:node:)?fs['"]\)|writeFile|createWriteStream/);
});
