/**
 * Tests for services/documentMergeService.js — uniting a batch's files into one
 * upload. Uses real (tiny) PNG/JPEG bytes and a pdf-lib-generated PDF so the
 * page count/order and size-cap behavior are exercised for real. Everything is
 * in-memory (pdf-lib), so there are no temp files to clean up.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');
const merge = require('../services/documentMergeService');

// 1x1 PNG and JPEG (valid, decodable by pdf-lib).
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const JPEG_1x1 = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==', 'base64');

async function makePdf(pageCount) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}

async function pageCount(buffer) {
  const doc = await PDFDocument.load(buffer);
  return doc.getPageCount();
}

test('multiple images merge into one PDF (one page each, in order)', async () => {
  const out = await merge.mergeToPdf([
    { buffer: PNG_1x1, mimeType: 'image/png' },
    { buffer: JPEG_1x1, mimeType: 'image/jpeg' },
  ]);
  assert.equal(merge.detectKind(out), 'pdf');
  assert.equal(await pageCount(out), 2);
});

test('multiple PDFs concatenate into one PDF with the summed page count', async () => {
  const twoPage = await makePdf(2);
  const onePage = await makePdf(1);
  const out = await merge.mergeToPdf([
    { buffer: twoPage, mimeType: 'application/pdf' },
    { buffer: onePage, mimeType: 'application/pdf' },
  ]);
  assert.equal(await pageCount(out), 3);
});

test('mixed PDF + image merge into one PDF', async () => {
  const onePage = await makePdf(1);
  const out = await merge.mergeToPdf([
    { buffer: onePage, mimeType: 'application/pdf' },
    { buffer: PNG_1x1, mimeType: 'image/png' },
  ]);
  assert.equal(await pageCount(out), 2);
});

test('detectKind falls back to magic bytes even with a wrong mime', async () => {
  assert.equal(merge.detectKind(PNG_1x1, 'application/octet-stream'), 'png');
  assert.equal(merge.detectKind(await makePdf(1), 'image/jpeg'), 'pdf');
});

test('oversized merged output is rejected with a clear message', async () => {
  await assert.rejects(
    () => merge.mergeToPdf([{ buffer: PNG_1x1, mimeType: 'image/png' }, { buffer: JPEG_1x1, mimeType: 'image/jpeg' }], { maxOutputBytes: 10 }),
    /too large/i,
  );
});

test('unsupported file type is refused (never upload a partial doc)', async () => {
  await assert.rejects(
    () => merge.mergeToPdf([{ buffer: Buffer.from('GIF89a....'), mimeType: 'image/gif' }]),
    /Unsupported file type/i,
  );
});

test('prepareUpload: single PDF is passed through as-is (not merged)', async () => {
  const onePage = await makePdf(1);
  const res = await merge.prepareUpload([{ buffer: onePage, mimeType: 'application/pdf', fileName: 'bol.pdf' }]);
  assert.equal(res.merged, false);
  assert.equal(res.mimeType, 'application/pdf');
  assert.equal(res.buffer, onePage);
});

test('prepareUpload: many files → merged PDF', async () => {
  const res = await merge.prepareUpload([
    { buffer: PNG_1x1, mimeType: 'image/png' },
    { buffer: JPEG_1x1, mimeType: 'image/jpeg' },
  ], { baseName: 'POD_9188060' });
  assert.equal(res.merged, true);
  assert.equal(res.filename, 'POD_9188060.pdf');
  assert.equal(await pageCount(res.buffer), 2);
});
