'use strict';

/**
 * Capture handing an attachment to the queue — the seam between the two halves
 * of the Finance Monitor.
 *
 * IT QUEUES, IT NEVER READS. This runs inside Telegram's message pipeline.
 * Downloading a file here would hold that pipeline open for as long as the
 * download took, on every finance message, and a slow file would delay every
 * driver's message behind it. A row and a poke is all it may do — asserted,
 * because "just fetch it here" is the obvious shortcut.
 *
 * AND IT RESPECTS THE SWITCH. `capture_documents` off means no row at all, not
 * a row nobody reads: a queue quietly filling up with work that will never be
 * done is worse than no queue.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const R = (rel) => path.resolve(ROOT, rel);
function stub(rel, exports) {
  const filename = require.resolve(R(rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let settings = {
  enabled: true, chatId: '-100', captureDocuments: true, aiReadingEnabled: true,
  maxDocumentMb: 8, duplicateWindowHours: 72,
};
let enqueued = [];
let pokes = 0;
let enqueueCreated = true;

stub('database/financeSettings.js', {
  getFinanceSettings: async () => settings,
  isFinanceChat: async (chatId) => settings.enabled && String(chatId) === settings.chatId,
  invalidateCache: () => {},
});
stub('database/financeMessages.js', {
  captureMessage: async () => ({ id: 77, created: true }),
  applyEdit: async () => 77,
  recordMoneycode: async () => 1,
  findDuplicateCandidates: async () => [],
  summariseCapture: async () => ({ available: true, byStatus: {}, total: 0 }),
});
stub('database/financeDocuments.js', {
  enqueueDocument: async (fields) => { enqueued.push(fields); return { id: 5, created: enqueueCreated }; },
  claimNextDocument: async () => null,
  nextDueAt: async () => null,
  releaseStuckDocuments: async () => 0,
  summariseDocuments: async () => ({ available: true, byStatus: {}, total: 0 }),
});
stub('services/finance/documentReader.js', {
  wakeFinanceDocumentReader: () => { pokes += 1; },
});

const capture = require(R('services/finance/captureService'));

function message(over = {}) {
  return {
    message_id: 5,
    chat: { id: -100 },
    from: { id: 11, first_name: 'A', last_name: 'Poster' },
    date: 1757700000,
    ...over,
  };
}

const PHOTO = [
  { file_id: 'small', file_unique_id: 'us', file_size: 100 },
  { file_id: 'large', file_unique_id: 'ul', file_size: 90000 },
];

function reset() {
  enqueued = []; pokes = 0; enqueueCreated = true;
  settings = {
    enabled: true, chatId: '-100', captureDocuments: true, aiReadingEnabled: true,
    maxDocumentMb: 8, duplicateWindowHours: 72,
  };
}

test('a document is queued with what Telegram said about it, and the reader is poked', async () => {
  reset();
  const result = await capture.captureFinanceMessage(message({
    caption: 'receipt for the load',
    document: {
      file_id: 'f1', file_unique_id: 'u1', mime_type: 'application/pdf',
      file_name: 'receipt.pdf', file_size: 4096,
    },
  }));

  assert.equal(result.handled, true);
  assert.equal(enqueued.length, 1);
  assert.deepEqual(
    {
      kind: enqueued[0].kind, fileUniqueId: enqueued[0].fileUniqueId,
      mimeType: enqueued[0].mimeType, fileSize: enqueued[0].fileSize,
      caption: enqueued[0].caption, messageRefId: enqueued[0].messageRefId,
    },
    {
      kind: 'document', fileUniqueId: 'u1', mimeType: 'application/pdf',
      fileSize: 4096, caption: 'receipt for the load', messageRefId: 77,
    },
  );
  assert.equal(pokes, 1, 'the poke is what makes delivery instant without a poll');
});

test('a photo queues its LARGEST size, which is the only one worth reading', async () => {
  reset();
  await capture.captureFinanceMessage(message({ photo: PHOTO, caption: '$500 sent' }));

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].kind, 'photo');
  assert.equal(enqueued[0].fileId, 'large');
  assert.equal(enqueued[0].fileSize, 90000);
});

test('with document capture switched off, nothing is queued at all', async () => {
  reset();
  settings = { ...settings, captureDocuments: false };

  const result = await capture.captureFinanceMessage(message({
    document: { file_id: 'f1', file_unique_id: 'u1', mime_type: 'application/pdf', file_size: 10 },
  }));

  assert.equal(result.handled, true, 'the MESSAGE is still captured — only the file is not');
  assert.equal(enqueued.length, 0, 'a queue filling with work nobody will do is worse than no queue');
  assert.equal(pokes, 0);
});

test('a message with no attachment queues nothing', async () => {
  reset();
  await capture.captureFinanceMessage(message({ text: 'money code 1111 2222 3333' }));
  assert.equal(enqueued.length, 0);
  assert.equal(pokes, 0);
});

test('a redelivered file is not poked about a second time', async () => {
  reset();
  enqueueCreated = false;
  await capture.captureFinanceMessage(message({
    document: { file_id: 'f1', file_unique_id: 'u1', mime_type: 'application/pdf', file_size: 10 },
  }));
  assert.equal(enqueued.length, 1, 'the insert is still attempted — the database decides');
  assert.equal(pokes, 0, 'waking the reader for a row that already existed is pure noise');
});

test('an edit that ADDS an attachment still queues it', async () => {
  reset();
  await capture.captureFinanceMessage(message({
    document: { file_id: 'f1', file_unique_id: 'u1', mime_type: 'image/png', file_size: 10 },
  }), { isEdit: true });
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].mimeType, 'image/png');
});

test('capture never fetches the file itself', () => {
  const source = require('node:fs').readFileSync(
    require.resolve(R('services/finance/captureService')), 'utf8',
  );
  // The shortcut this file must not take: reading the document inline would
  // hold Telegram's message pipeline open behind every finance attachment.
  for (const forbidden of ['getFileLink', 'downloadFinanceFile', 'extractTextFromPdf', 'runCapability']) {
    assert.equal(source.includes(forbidden), false, `capture started reading files: ${forbidden}`);
  }
});

test('a document from another chat is never queued', async () => {
  reset();
  const result = await capture.captureFinanceMessage(message({
    chat: { id: -999 },
    document: { file_id: 'f1', file_unique_id: 'u1', mime_type: 'application/pdf', file_size: 10 },
  }));
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'not the finance chat');
  assert.equal(enqueued.length, 0);
});
