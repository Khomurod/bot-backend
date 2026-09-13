'use strict';

/**
 * Reading finance documents, one at a time, for as long as there are any.
 *
 * STRICTLY SEQUENTIAL, AND THAT IS A MEMORY BUDGET RATHER THAN A PREFERENCE.
 * A document is held whole in memory while it is read, and Render's instance
 * has 512MB with a bot, an HTTP server and thirty other workers in it. So the
 * claim takes exactly one row (`FOR UPDATE SKIP LOCKED ... LIMIT 1`), the
 * buffer is dropped before the next claim, and a drain stops after
 * MAX_PER_DRAIN. `tests/financeDocumentReader.test.js` asserts the concurrency
 * counter never exceeds one, because "we only call it once" is a property that
 * survives exactly until somebody adds a Promise.all.
 *
 * WHAT IT DOES NOT DO IS AS IMPORTANT:
 *
 *   IT NEVER THROWS AT ITS CALLER. Every document has its own try/catch and the
 *   drain has another. A reader that throws takes its tick's run record with it
 *   and, through index.js's unhandledRejection hook, can take the process.
 *
 *   AI BEING UNAVAILABLE IS `needs_review`, NEVER `failed`. A provider outage
 *   is not the document's fault; it must not burn the retry ladder, and the
 *   document is intact — a person can open it right now. `failed` is reserved
 *   for "we could not GET the bytes", which is the only thing worth retrying.
 *
 *   IT NEVER LOGS A CAPTION, A FILE NAME OR EXTRACTED TEXT. Ids and statuses.
 *
 * THE OCR PATH IS DELIBERATELY OFF HERE. `extractTextFromPdf` is called with
 * `allowOcr: false`, so tesseract.js — a ~5MB WASM model — is never even
 * required on this path. A scan goes to AI vision instead, which reads it
 * better anyway. See services/documents/pdfTextExtraction.js.
 */

const financeDocuments = require('../../database/financeDocuments');
const { getFinanceSettings } = require('../../database/financeSettings');
const { extractTextFromPdf } = require('../documents/pdfTextExtraction');
const { prepareImagePartForAi } = require('../aiImagePrep');
const { runCapability, AiUnavailableError } = require('../ai/router');
const { withRunRecord } = require('../operations/runLedger');
const { createQueueWakeScheduler } = require('../jobQueueScheduler');
const { notify } = require('../notifications/send');
const policy = require('../../lib/finance/documentPolicy');
const prompt = require('../../lib/finance/documentPrompt');

/** One drain reads at most this many, then yields and re-arms. */
const MAX_PER_DRAIN = 5;
/** A claim older than this was left behind by a crash; the sweep frees it. */
const STUCK_AFTER_MINUTES = 15;
/** Raw bytes handed to a vision model. Below the provider inline caps. */
const MAX_INLINE_BYTES = 6 * 1024 * 1024;

let scheduler = null;
/** The drain the event wake pokes. Held here because the scheduler owns timers
 *  only — it has no way to be called directly, by design. */
let pokeDrain = null;
let draining = false;
/** Proves the sequential claim to its test; not used for control flow. */
let inFlight = 0;
let maxInFlight = 0;

function log(message) {
  console.log(`[FINANCE DOCS] ${message}`);
}

/**
 * Read one claimed document and record what happened.
 *
 * @returns {Promise<string>} the status it ended in, for the drain's summary
 */
async function readOne(doc, { settings, telegram, download, ai }) {
  const intake = policy.decideIntake(doc, { maxDocumentMb: settings.maxDocumentMb });
  if (!intake.allowed) {
    // Refused BEFORE a byte is fetched — which is the whole point of deciding
    // from Telegram's declared size rather than from what arrives.
    await financeDocuments.skipDocument(doc.id, { status: intake.status, reason: intake.reason });
    return intake.status;
  }

  let buffer = null;
  try {
    buffer = await download(doc.fileId, {
      maxBytes: Math.max(1, settings.maxDocumentMb) * 1024 * 1024,
    });
  } catch (err) {
    // A download failure IS worth retrying, so it is the one thing that gets
    // the backoff ladder. `err.message` here is constructed from a status code
    // or an error name — never from the URL, which carries the bot token.
    const { nextAttemptAt } = policy.decideRetry(doc.attemptCount);
    await financeDocuments.failDocument(doc.id, { error: err.message, nextAttemptAt });
    return 'failed';
  }

  try {
    const isPdfFile = policy.isPdf(doc.mimeType);
    let text = '';
    if (isPdfFile) {
      // allowOcr: false — see the header. A scan goes to vision, not tesseract.
      const extracted = await extractTextFromPdf(buffer, { allowOcr: false });
      text = String(extracted?.text || '');
    }

    const path = policy.decideReadPath({ isPdfFile, textChars: text.length });

    if (!settings.aiReadingEnabled && !path.useText) {
      // Nothing to read it with, and nothing to pretend about.
      await financeDocuments.finishDocument(doc.id, {
        status: policy.STATUS.NEEDS_REVIEW,
        readMethod: path.method,
        textChars: text.length,
        reviewReason: policy.REVIEW_REASON.NO_TEXT,
      });
      return policy.STATUS.NEEDS_REVIEW;
    }

    const answer = await ai({ doc, buffer, text, path, settings });
    const outcome = policy.decideReadOutcome(answer.extracted, {
      aiUnavailable: answer.unavailable,
    });

    await financeDocuments.finishDocument(doc.id, {
      status: outcome.status,
      readMethod: path.method,
      textChars: text.length,
      extracted: answer.extracted,
      reviewReason: outcome.reviewReason,
      aiProvider: answer.provider,
      aiModel: answer.model,
    });
    return outcome.status;
  } finally {
    // Explicit, and load-bearing: the next claim must not begin while this
    // document's bytes are still referenced.
    buffer = null;
  }
}

/**
 * Ask a model what the document says.
 *
 * Never throws: an unavailable provider, a refused answer and a model that
 * returned prose all come back as `{ unavailable: true }` or
 * `{ extracted: null }`, which `decideReadOutcome` turns into `needs_review`.
 */
/**
 * `runCapability` hands back `{ text, parsed, provider, model }` — `parsed` is
 * already the object when `expects: 'json'`, and `text` is the raw body. Take
 * the object when there is one so the JSON is not parsed a second time.
 */
function shapeAnswer(raw) {
  return {
    extracted: prompt.shapeDocumentAnswer(raw?.parsed ?? raw?.text ?? raw),
    unavailable: false,
    provider: raw?.provider ?? null,
    model: raw?.model ?? null,
  };
}

async function askModel({ doc, buffer, text, path }) {
  try {
    if (path.useText) {
      const raw = await runCapability({
        capability: 'finance_document_extraction',
        systemText: prompt.SYSTEM,
        userText: prompt.buildDocumentPrompt({ text, caption: doc.caption, fileName: doc.fileName }),
        expects: 'json',
        validate: prompt.validateDocumentAnswer,
      });
      return shapeAnswer(raw);
    }

    if (buffer.length > MAX_INLINE_BYTES) {
      // Too big to send inline and nothing else to try. Honest over clever.
      return { extracted: null, unavailable: false, provider: null, model: null };
    }

    const part = await prepareImagePartForAi(buffer, doc.mimeType);
    const raw = await runCapability({
      capability: 'finance_document_extraction',
      systemText: prompt.SYSTEM,
      userText: prompt.buildVisionPrompt({ caption: doc.caption, fileName: doc.fileName }),
      extraParts: [part],
      expects: 'json',
      validate: prompt.validateDocumentAnswer,
    });
    return shapeAnswer(raw);
  } catch (err) {
    if (err instanceof AiUnavailableError) {
      return { extracted: null, unavailable: true, provider: null, model: null };
    }
    // ANYTHING ELSE IS NOT AN OUTAGE, and must not be recorded as one.
    // A bug here would otherwise be filed under `ai_unavailable` — a reason
    // that says "wait for the provider" about a problem no provider will ever
    // fix. `unavailable: false` with nothing extracted reads as
    // `invalid_answer`, which is what actually happened.
    log(`the reader failed for document ${doc?.id ?? 'unknown'}: ${err.message}`);
    return { extracted: null, unavailable: false, provider: null, model: null };
  }
}

/**
 * Tell somebody a document needs eyes.
 *
 * ONE NOTICE PER BATCH, AND A NEW BATCH IS A NEW NOTICE. The subject is
 * constant on purpose — five unreadable scans in one drain are one thing to
 * look at, not five — but the DISCRIMINATOR is the batch's highest document id,
 * because `notify` deduplicates on the whole key and a key built from constants
 * alone would be said once in the life of the installation and never again.
 * This repository has already lost 101 alerts to a queue that went quiet.
 *
 * A drain cannot re-review a document it has moved off `pending`, so the
 * highest id identifies the event rather than merely the condition.
 *
 * The notice carries NO caption, NO file name and NOTHING extracted — a
 * notification lands in a group chat's permanent history, and this is payment
 * data.
 */
async function announceReview(ids) {
  const count = ids.length;
  if (count <= 0) return;
  await notify({
    category: 'finance',
    title: count === 1
      ? 'A finance document could not be read with enough certainty'
      : `${count} finance documents could not be read with enough certainty`,
    lines: ['They are captured and safe; they need a person to look at them.'],
    action: 'Open Settings → Finance Monitor to see the counts.',
    subjectType: 'finance_documents',
    subjectId: 'needs_review',
    discriminator: `batch-${Math.max(...ids.map((id) => Number(id) || 0))}`,
  }).catch(() => null);
}

/**
 * Drain what is due. Never throws.
 *
 * @returns a summary `withRunRecord` reads: `{blocked}` when the feature is
 *   switched off, otherwise counts.
 */
async function drainFinanceDocuments(deps = {}) {
  const telegram = deps.telegram ?? null;
  const download = deps.download ?? defaultDownload(telegram);
  const ai = deps.ai ?? askModel;

  let settings;
  try {
    settings = await getFinanceSettings();
  } catch (err) {
    return { error: `the Finance Monitor settings could not be read (${err.message})` };
  }

  if (!settings.enabled || !settings.captureDocuments) {
    return { blocked: 'the Finance Monitor is off, or document capture is switched off' };
  }
  if (!telegram && !deps.download) {
    return { blocked: 'no Telegram client is available to fetch documents' };
  }

  await financeDocuments.releaseStuckDocuments({ olderThanMinutes: STUCK_AFTER_MINUTES })
    .catch(() => 0);

  const counts = { read: 0, needsReview: 0, failed: 0, skipped: 0 };
  const reviewIds = [];
  for (let i = 0; i < MAX_PER_DRAIN; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const doc = await financeDocuments.claimNextDocument();
    if (!doc) break;

    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      // eslint-disable-next-line no-await-in-loop
      const status = await readOne(doc, { settings, telegram, download, ai });
      if (status === policy.STATUS.READ) counts.read += 1;
      else if (status === policy.STATUS.NEEDS_REVIEW) { counts.needsReview += 1; reviewIds.push(doc.id); }
      else if (status === policy.STATUS.FAILED) counts.failed += 1;
      else counts.skipped += 1;
      log(`document ${doc.id} -> ${status}`);
    } catch (err) {
      // The per-document net. A document that breaks the reader must not stop
      // the four behind it.
      counts.failed += 1;
      log(`document ${doc.id} threw: ${err.message}`);
      // eslint-disable-next-line no-await-in-loop
      await financeDocuments.failDocument(doc.id, {
        error: err.message,
        nextAttemptAt: policy.decideRetry(doc.attemptCount).nextAttemptAt,
      }).catch(() => {});
    } finally {
      inFlight -= 1;
    }
  }

  await announceReview(reviewIds);
  return counts;
}

function defaultDownload(telegram) {
  const { downloadFinanceFile } = require('./telegramFileDownload');
  return (fileId, limits) => downloadFinanceFile({ telegram }, fileId, limits);
}

/** One tick, wrapped so /api/health can see whether it ran. */
async function tick(deps = {}) {
  try {
    return await withRunRecord('finance_document_reader', () => drainFinanceDocuments(deps));
  } catch (err) {
    // withRunRecord re-throws what the pass threw; the pass does not throw, so
    // reaching here means the LEDGER broke. That is not worth the process.
    log(`tick failed: ${err.message}`);
    return { error: err.message };
  }
}

/**
 * Start the worker.
 *
 * Event wake from capture, a precise retry wake after each drain, and a slow
 * idle sweep as the backstop — the shape services/jobQueueScheduler.js exists
 * for, and the reason this costs a handful of queries a day instead of tens of
 * thousands.
 */
function startFinanceDocumentReader(deps = {}) {
  if (scheduler) return scheduler;

  const runDrain = async () => {
    if (draining) return;
    draining = true;
    try {
      await tick(deps);
      await scheduler?.afterDrain();
    } finally {
      draining = false;
    }
  };

  pokeDrain = runDrain;
  scheduler = createQueueWakeScheduler({
    onWake: () => { runDrain().catch(() => {}); },
    getNextDueAt: () => financeDocuments.nextDueAt(),
    logger: console,
  });
  scheduler.start();
  return scheduler;
}

function stopFinanceDocumentReader() {
  scheduler?.stop();
  scheduler = null;
  pokeDrain = null;
}

/** Poke the worker: capture calls this the moment it queues a document. */
function wakeFinanceDocumentReader() {
  if (!scheduler?.isRunning() || !pokeDrain) return;
  // Fire-and-forget on purpose: the caller is the capture handler, in the
  // middle of Telegram's message pipeline, and it must not wait on a drain.
  pokeDrain().catch(() => {});
}

module.exports = {
  drainFinanceDocuments,
  tick,
  startFinanceDocumentReader,
  stopFinanceDocumentReader,
  wakeFinanceDocumentReader,
  askModel,
  MAX_PER_DRAIN,
  MAX_INLINE_BYTES,
  __maxInFlight: () => maxInFlight,
  __resetInFlight: () => { maxInFlight = 0; inFlight = 0; },
};
