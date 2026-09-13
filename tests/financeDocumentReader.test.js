'use strict';

/**
 * The reader's four promises, each of which would fail silently.
 *
 *   ONE AT A TIME. A document is held whole in memory while it is read, on an
 *   instance with 512MB. The counter here is not decoration: "we only call it
 *   once" survives exactly until somebody adds a Promise.all, and then the
 *   symptom is an out-of-memory kill in production with no failing test.
 *
 *   A TEXT PDF NEVER REACHES A VISION MODEL. Sending a readable PDF as an image
 *   costs money and reads worse. The assertion is on `extraParts` being absent,
 *   which is the only externally visible difference.
 *
 *   AI UNAVAILABLE IS `needs_review`, NEVER `failed`. `failed` carries a retry
 *   ladder; an outage would burn it for a document that is perfectly intact.
 *
 *   AN OVERSIZED FILE IS NEVER FETCHED. The downloader must not be called at
 *   all — a cap enforced after the download has paid the cost it exists for.
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

// ── stub state ────────────────────────────────────────────────────────────
let settings = {
  enabled: true, captureDocuments: true, aiReadingEnabled: true,
  maxDocumentMb: 8, duplicateWindowHours: 72,
};
let queue = [];
const finished = [];
const failed = [];
const skipped = [];
const notices = [];
let pdfText = '';
/** Set to make the settings read fail, the way a database outage does. */
let settingsError = null;

stub('database/financeSettings.js', {
  getFinanceSettings: async () => {
    if (settingsError) throw settingsError;
    return settings;
  },
  isFinanceChat: async () => true,
  invalidateCache: () => {},
});
stub('database/financeDocuments.js', {
  claimNextDocument: async () => queue.shift() || null,
  finishDocument: async (id, fields) => { finished.push({ id, ...fields }); },
  failDocument: async (id, fields) => { failed.push({ id, ...fields }); },
  skipDocument: async (id, fields) => { skipped.push({ id, ...fields }); },
  releaseStuckDocuments: async () => 0,
  nextDueAt: async () => null,
  enqueueDocument: async () => ({ id: 1, created: true }),
  summariseDocuments: async () => ({ available: true, byStatus: {}, total: 0 }),
});
stub('services/documents/pdfTextExtraction.js', {
  extractTextFromPdf: async () => ({ text: pdfText, usedPdfOcr: false }),
  extractTextFromImage: async () => ({ text: '', usedPdfOcr: false }),
  isWeakDispatchRawText: () => false,
});
stub('services/aiImagePrep.js', {
  prepareImagePartForAi: async (buffer, mime) => ({ inline_data: { mime_type: mime, data: 'x' } }),
});
stub('services/operations/runLedger.js', { withRunRecord: async (key, pass) => pass() });
stub('services/notifications/send.js', {
  notify: async (notice) => { notices.push(notice); return { recorded: true, delivered: true }; },
});

const reader = require(R('services/finance/documentReader'));
const policy = require(R('lib/finance/documentPolicy'));

function doc(over = {}) {
  return {
    id: over.id ?? 1, messageRefId: 10, chatId: '-100', messageId: 5,
    kind: 'document', fileId: 'f1', fileUniqueId: 'u1',
    mimeType: 'application/pdf', fileName: 'receipt.pdf', fileSize: 1024,
    caption: 'here', attemptCount: 1, ...over,
  };
}

function reset() {
  queue = []; finished.length = 0; failed.length = 0; skipped.length = 0;
  notices.length = 0; pdfText = ''; settingsError = null;
  settings = {
    enabled: true, captureDocuments: true, aiReadingEnabled: true,
    maxDocumentMb: 8, duplicateWindowHours: 72,
  };
  reader.__resetInFlight();
}

const GOOD = { amount: 500, issuedAt: '2026-09-01', confidence: 90, currency: 'USD' };
const okAi = async () => ({ extracted: GOOD, provider: 'groq', model: 'm1' });
const download = async () => Buffer.alloc(1024);

// ── the tests ─────────────────────────────────────────────────────────────

test('it reads one document at a time, however many are waiting', async () => {
  reset();
  queue = [doc({ id: 1 }), doc({ id: 2 }), doc({ id: 3 }), doc({ id: 4 }), doc({ id: 5 })];
  pdfText = 'x'.repeat(policy.STRONG_TEXT_CHARS);

  let concurrent = 0;
  let peak = 0;
  const slowAi = async () => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    await new Promise((r) => setTimeout(r, 5));
    concurrent -= 1;
    return { extracted: GOOD, provider: 'groq', model: 'm1' };
  };

  const counts = await reader.drainFinanceDocuments({ telegram: {}, download, ai: slowAi });
  assert.equal(counts.read, 5);
  assert.equal(peak, 1, 'two documents in memory at once is the bug this is here to catch');
  assert.equal(reader.__maxInFlight(), 1);
});

test('a drain stops at MAX_PER_DRAIN and leaves the rest for the next wake', async () => {
  reset();
  queue = Array.from({ length: reader.MAX_PER_DRAIN + 3 }, (_, i) => doc({ id: i + 1 }));
  pdfText = 'x'.repeat(policy.STRONG_TEXT_CHARS);

  const counts = await reader.drainFinanceDocuments({ telegram: {}, download, ai: okAi });
  assert.equal(counts.read, reader.MAX_PER_DRAIN);
  assert.equal(queue.length, 3, 'the rest are still queued, not lost');
});

test('a PDF with real text is read as TEXT — no image is ever sent', async () => {
  reset();
  queue = [doc()];
  pdfText = 'INVOICE 42 '.repeat(30);

  const seen = [];
  const ai = async (args) => { seen.push(args.path); return { extracted: GOOD, provider: 'g', model: 'm' }; };
  await reader.drainFinanceDocuments({ telegram: {}, download, ai });

  assert.equal(seen[0].useText, true);
  assert.equal(finished[0].readMethod, policy.READ_METHOD.PDF_TEXT);
  assert.equal(finished[0].status, policy.STATUS.READ);
});

test('a scan with no usable text layer goes to vision instead', async () => {
  reset();
  queue = [doc()];
  pdfText = 'p 1';

  const seen = [];
  const ai = async (args) => { seen.push(args.path); return { extracted: GOOD, provider: 'g', model: 'm' }; };
  await reader.drainFinanceDocuments({ telegram: {}, download, ai });

  assert.equal(seen[0].useText, false);
  assert.equal(finished[0].readMethod, policy.READ_METHOD.PDF_TEXT_AI);
});

test('an unavailable provider is needs_review and NEVER failed', async () => {
  reset();
  queue = [doc()];
  const ai = async () => ({ extracted: null, unavailable: true, provider: null, model: null });

  const counts = await reader.drainFinanceDocuments({ telegram: {}, download, ai });

  assert.equal(counts.needsReview, 1);
  assert.equal(counts.failed, 0);
  assert.equal(failed.length, 0, 'an outage must not burn the retry ladder');
  assert.equal(finished[0].status, policy.STATUS.NEEDS_REVIEW);
  assert.equal(finished[0].reviewReason, policy.REVIEW_REASON.AI_UNAVAILABLE);
});

test('an oversized file is skipped and the downloader is never called', async () => {
  reset();
  queue = [doc({ fileSize: 50 * 1024 * 1024 })];
  let fetched = false;
  const spy = async () => { fetched = true; return Buffer.alloc(10); };

  const counts = await reader.drainFinanceDocuments({ telegram: {}, download: spy, ai: okAi });

  assert.equal(fetched, false, 'the whole point of deciding from the DECLARED size');
  assert.equal(counts.skipped, 1);
  assert.equal(skipped[0].status, policy.STATUS.SKIPPED_TOO_LARGE);
});

test('a download failure IS failed, with a next attempt', async () => {
  reset();
  queue = [doc()];
  const boom = async () => { throw new Error('Telegram answered 502 for this file'); };

  const counts = await reader.drainFinanceDocuments({ telegram: {}, download: boom, ai: okAi });

  assert.equal(counts.failed, 1);
  assert.equal(failed[0].error, 'Telegram answered 502 for this file');
  assert.ok(failed[0].nextAttemptAt instanceof Date, 'a fetch failure is worth coming back for');
});

test('one document that throws does not stop the ones behind it', async () => {
  reset();
  queue = [doc({ id: 1 }), doc({ id: 2 }), doc({ id: 3 })];
  pdfText = 'x'.repeat(policy.STRONG_TEXT_CHARS);
  const ai = async ({ doc: d }) => {
    if (d.id === 2) throw new Error('something unexpected');
    return { extracted: GOOD, provider: 'g', model: 'm' };
  };

  const counts = await reader.drainFinanceDocuments({ telegram: {}, download, ai });
  assert.equal(counts.read, 2);
  assert.equal(counts.failed, 1);
  assert.deepEqual(finished.map((f) => f.id), [1, 3]);
});

test('it stands down — blocked, not failed — when the feature is off', async () => {
  reset();
  settings = { ...settings, enabled: false };
  assert.match((await reader.drainFinanceDocuments({ telegram: {} })).blocked, /off/);

  reset();
  settings = { ...settings, captureDocuments: false };
  assert.match((await reader.drainFinanceDocuments({ telegram: {} })).blocked, /off/);

  reset();
  assert.match((await reader.drainFinanceDocuments({})).blocked, /Telegram client/);
});

test('with AI reading switched off, a scan is marked for a person rather than guessed at', async () => {
  reset();
  settings = { ...settings, aiReadingEnabled: false };
  queue = [doc()];
  pdfText = '';
  let asked = false;
  const ai = async () => { asked = true; return { extracted: GOOD }; };

  await reader.drainFinanceDocuments({ telegram: {}, download, ai });

  assert.equal(asked, false, 'the switch has to actually stop the call');
  assert.equal(finished[0].status, policy.STATUS.NEEDS_REVIEW);
  assert.equal(finished[0].reviewReason, policy.REVIEW_REASON.NO_TEXT);
});

test('a settings failure is reported as an error, not as "switched off"', async () => {
  reset();
  settingsError = new Error('connection refused');
  const out = await reader.drainFinanceDocuments({ telegram: {} });
  assert.match(out.error, /connection refused/);
  assert.equal(out.blocked, undefined, 'an outage and an off switch are opposite answers');
});

test('a bug in the reader is NOT filed as "the provider is unavailable"', async () => {
  reset();
  queue = [doc()];
  pdfText = 'x'.repeat(policy.STRONG_TEXT_CHARS);
  // Not an AiUnavailableError — an ordinary programming mistake. Filing it as
  // an outage would tell a person to wait for a provider to fix something no
  // provider is ever going to fix.
  const { askModel } = reader;
  const broken = async (args) => askModel({ ...args, doc: null });

  await reader.drainFinanceDocuments({ telegram: {}, download, ai: broken });

  assert.equal(finished[0].status, policy.STATUS.NEEDS_REVIEW);
  assert.notEqual(finished[0].reviewReason, policy.REVIEW_REASON.AI_UNAVAILABLE);
  assert.equal(finished[0].reviewReason, policy.REVIEW_REASON.INVALID_ANSWER);
});

test('a notice about unreadable documents says nothing about what they contain', async () => {
  reset();
  queue = [doc({ id: 1 }), doc({ id: 2 })];
  const ai = async () => ({ extracted: null, unavailable: true });

  await reader.drainFinanceDocuments({ telegram: {}, download, ai });

  assert.equal(notices.length, 1, 'one notice for the batch, not one each');
  assert.equal(notices[0].category, 'finance');
  const flat = JSON.stringify(notices[0]);
  for (const forbidden of ['receipt.pdf', 'here', '500', '2026-09-01']) {
    assert.ok(!flat.includes(forbidden), `the notice leaked "${forbidden}" into a group chat`);
  }
});

test('nothing is announced when everything was read', async () => {
  reset();
  queue = [doc()];
  pdfText = 'x'.repeat(policy.STRONG_TEXT_CHARS);
  await reader.drainFinanceDocuments({ telegram: {}, download, ai: okAi });
  assert.equal(notices.length, 0);
});

/**
 * THE SECOND BATCH MUST STILL BE ANNOUNCED.
 *
 * `notify` deduplicates on `category:subjectType:subjectId:discriminator`, and
 * a notice built from constants alone is said ONCE in the life of the
 * installation. A week of unreadable scans would then arrive as silence — the
 * exact failure this repository lost 101 staff alerts to. The batch's highest
 * document id is the discriminator, because a drain cannot re-review a document
 * it has already moved off `pending`.
 */
test('a later batch of unreadable documents is announced again, not swallowed', async () => {
  reset();
  const unavailable = async () => ({ extracted: null, unavailable: true, provider: null, model: null });

  queue = [doc({ id: 11 })];
  pdfText = 'x'.repeat(policy.STRONG_TEXT_CHARS);
  await reader.drainFinanceDocuments({ telegram: {}, download, ai: unavailable });

  queue = [doc({ id: 12 })];
  pdfText = 'x'.repeat(policy.STRONG_TEXT_CHARS);
  await reader.drainFinanceDocuments({ telegram: {}, download, ai: unavailable });

  assert.equal(notices.length, 2, 'both batches should have produced a notice');
  assert.notEqual(
    notices[0].discriminator,
    notices[1].discriminator,
    'two different batches must not share one notice key',
  );
});
