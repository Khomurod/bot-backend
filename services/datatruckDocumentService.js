/**
 * Datatruck BOL/POD document delivery service.
 *
 * Polls the Datatruck OpenAPI for recently-picked-up and recently-delivered orders, finds newly
 * uploaded Bill of Lading and Proof of Delivery documents, matches each order to its driver's
 * Telegram group by driver name only, and forwards
 * the file to that group with a short caption.
 *
 * Safety properties:
 *  - Idempotent: every (order, document) is delivered at most once, guarded by a
 *    UNIQUE signature in datatruck_document_deliveries.
 *  - No backfill spam: documents uploaded before the feature first activated
 *    (or before DATATRUCK_DOC_SINCE) are recorded as suppressed, never sent.
 *  - Retryable: a failed send or a document whose group did not exist yet stays
 *    eligible for a later scan, up to an attempt cap.
 *  - Read-only against Datatruck; paced by the shared API client's rate limiter.
 */
const config = require('../config/config');
const { Input } = require('telegraf');
const { bot } = require('../bot/bot');
const { safeSend, isPermanentSendError } = require('./telegramHtml');
const datatruck = require('./datatruckApiService');
const docsDb = require('../database/datatruckDocuments');
const { listCanonicalDriverGroups } = require('./driverGroupDirectoryService');
const {
  isTrackedDocumentType,
  extractTrackedDocuments,
  buildGroupMatchIndex,
  matchDocumentToGroup,
  buildDocumentCaption,
  buildDocumentFilename,
  resolveDocumentUrl,
} = require('./datatruckDocumentHelpers');

const CLAIM_OPTS = { staleMinutes: 60, maxAttempts: 6 };
const DOWNLOAD_TIMEOUT_MS = 60_000;

let serviceTimer = null;
let serviceStopped = false;
let tickRunning = false;
let lastRunSummary = null;

function authHeaders() {
  return { Authorization: `Token ${config.datatruckApiToken}` };
}

/**
 * Download a document's bytes for upload to Telegram (used only when Telegram
 * cannot fetch the URL itself). Tries unauthenticated first (Datatruck hands
 * back presigned links); retries with the API token if access is denied.
 */
async function downloadDocument(fileLink) {
  const maxBytes = config.datatruckDocMaxFileMb * 1024 * 1024;
  async function attempt(withAuth) {
    const res = await fetch(fileLink, {
      headers: withAuth ? authHeaders() : undefined,
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      const err = new Error(`Document download failed: HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`Document too large to forward (${declared} bytes).`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error(`Document too large to forward (${buffer.length} bytes).`);
    }
    return buffer;
  }
  try {
    return await attempt(false);
  } catch (err) {
    if ((err.status === 401 || err.status === 403) && config.datatruckApiToken) {
      return attempt(true);
    }
    throw err;
  }
}

/**
 * Send one document to a driver group. Lets Telegram fetch the URL directly;
 * falls back to downloading + uploading the bytes when Telegram cannot.
 */
async function sendDocumentToGroup(telegramGroupId, doc) {
  if (!isTrackedDocumentType(doc?.fileType)) {
    throw new Error(`Refusing to send unsupported document type: ${doc?.fileType || 'unknown'}`);
  }
  const caption = buildDocumentCaption(doc);
  const filename = buildDocumentFilename(doc);
  const fileUrl = resolveDocumentUrl(doc.fileLink, config.datatruckDocMediaBaseUrl);
  if (!fileUrl) throw new Error('Document has no resolvable file URL.');
  const extra = { caption, parse_mode: 'HTML' };
  try {
    return await safeSend(() => bot.telegram.sendDocument(
      telegramGroupId,
      Input.fromURL(fileUrl, filename),
      extra,
    ));
  } catch (err) {
    if (isPermanentSendError(err)) throw err;
    // Telegram could not fetch/serve the URL (e.g. file > 20MB URL limit) —
    // download the bytes and upload them ourselves.
    const buffer = await downloadDocument(fileUrl);
    return safeSend(() => bot.telegram.sendDocument(
      telegramGroupId,
      Input.fromBuffer(buffer, filename),
      extra,
    ));
  }
}

function windowIso(referenceMs = Date.now()) {
  const startMs = referenceMs - config.datatruckDocLookbackDays * 24 * 60 * 60 * 1000;
  // Small forward buffer so a delivery just logged isn't missed by clock skew.
  const endMs = referenceMs + 60 * 60 * 1000;
  return { startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString() };
}

/**
 * Resolve the cutoff (ms): documents uploaded before this are backfill. Uses
 * DATATRUCK_DOC_SINCE when set, otherwise the durable first-activation time.
 */
async function resolveCutoffMs() {
  const activation = await docsDb.ensureActivationTime();
  const activationMs = activation.getTime();
  if (config.datatruckDocSinceIso) {
    const sinceMs = Date.parse(config.datatruckDocSinceIso);
    // A configured cutoff may make suppression stricter, but it must never move
    // before this rollout's activation and accidentally release historic docs.
    if (Number.isFinite(sinceMs)) return Math.max(activationMs, sinceMs);
  }
  return activationMs;
}

/**
 * One full scan: fetch recent orders, forward any new BOL/POD documents.
 * @returns {Promise<object>} summary
 */
async function runOnce({ referenceMs = Date.now() } = {}) {
  if (!datatruck.isConfigured()) {
    return { configured: false, reason: 'datatruck_not_configured' };
  }

  const cutoffMs = await resolveCutoffMs();
  const { startIso, endIso } = windowIso(referenceMs);
  const orders = await datatruck.fetchOrdersByDocumentWindow(startIso, endIso);

  const directory = await listCanonicalDriverGroups({ operational: true, includeNonDrivers: false });
  const index = buildGroupMatchIndex(directory);

  let scanned = 0;
  let backfillSuppressed = 0;
  let sent = 0;
  let skippedNoGroup = 0;
  let failed = 0;
  const errors = [];

  for (const order of orders) {
    const docs = extractTrackedDocuments(order);
    for (const doc of docs) {
      scanned += 1;
      const meta = {
        signature: doc.signature,
        orderId: doc.orderId,
        loadReference: doc.loadReference,
        fileType: doc.fileType,
        fileLink: doc.fileLink,
        uploadedBy: doc.uploadedBy,
        uploadedAt: doc.uploadedAt,
        driverName: doc.driverNames.join(' / ') || null,
        unitNumber: doc.unitNumber || null,
      };

      // Backfill / undatable documents are recorded once and never sent.
      if (doc.uploadedAtMs == null || doc.uploadedAtMs < cutoffMs) {
        if (await docsDb.recordBackfillSuppressed(meta)) backfillSuppressed += 1;
        continue;
      }

      const claimed = await docsDb.claimDocumentDelivery(meta, CLAIM_OPTS);
      if (!claimed) continue; // already sent/suppressed, or not yet due for retry

      const match = matchDocumentToGroup(doc, index);
      if (!match) {
        await docsDb.markSkippedNoGroup(claimed.id, {
          driverName: meta.driverName,
          unitNumber: meta.unitNumber,
        });
        skippedNoGroup += 1;
        continue;
      }

      try {
        const result = await sendDocumentToGroup(match.group.telegram_group_id, doc);
        await docsDb.markSent(claimed.id, {
          groupId: match.group.group_id,
          telegramGroupId: match.group.telegram_group_id,
          messageId: result?.message_id || null,
          matchedBy: match.matchedBy,
        });
        sent += 1;
        console.log(
          `[DATATRUCK-DOCS] Sent ${doc.fileType} for load ${doc.loadReference || doc.orderId} `
          + `to "${match.group.group_name}" (matched by ${match.matchedBy})`
        );
      } catch (err) {
        await docsDb.markFailed(claimed.id, err.message).catch(() => {});
        failed += 1;
        errors.push({ signature: doc.signature, error: err.message });
        console.error(
          `[DATATRUCK-DOCS] Failed to send ${doc.fileType} for load `
          + `${doc.loadReference || doc.orderId}: ${err.message}`
        );
      }
    }
  }

  const summary = {
    configured: true,
    window: { startIso, endIso },
    cutoffIso: new Date(cutoffMs).toISOString(),
    ordersScanned: orders.length,
    documentsScanned: scanned,
    sent,
    backfillSuppressed,
    skippedNoGroup,
    failed,
    errors,
    ranAt: new Date().toISOString(),
  };
  lastRunSummary = summary;
  console.log(
    `[DATATRUCK-DOCS] Scan complete: ${orders.length} orders, ${scanned} BOL/POD docs, `
    + `${sent} sent, ${backfillSuppressed} backfill, ${skippedNoGroup} no-group, ${failed} failed`
  );
  return summary;
}

async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    if (!config.datatruckDocDeliveryEnabled) return;
    if (!datatruck.isConfigured()) return;
    await runOnce();
  } catch (err) {
    console.error('[DATATRUCK-DOCS] Scan error:', err.message);
  } finally {
    tickRunning = false;
  }
}

function startDatatruckDocumentService() {
  serviceStopped = false;
  if (!config.datatruckDocDeliveryEnabled) {
    console.log('[DATATRUCK-DOCS] Service disabled (DATATRUCK_DOC_DELIVERY_ENABLED=false).');
    return;
  }
  const pollMs = config.datatruckDocPollMinutes * 60 * 1000;
  console.log(
    `[DATATRUCK-DOCS] Service started — scanning every ${config.datatruckDocPollMinutes} min `
    + `(lookback ${config.datatruckDocLookbackDays}d)`
    + (datatruck.isConfigured() ? '' : ' (Datatruck API not configured yet — idle)')
  );
  // Defer the first scan so the bot/telegram is fully ready, and so activation
  // time is set a little after boot (a doc uploaded during boot still counts).
  setTimeout(() => { if (!serviceStopped) tick(); }, 30 * 1000).unref?.();
  serviceTimer = setInterval(() => { if (!serviceStopped) tick(); }, pollMs);
  serviceTimer.unref?.();
}

function stopDatatruckDocumentService() {
  serviceStopped = true;
  if (serviceTimer) {
    clearInterval(serviceTimer);
    serviceTimer = null;
  }
}

function getLastRunSummary() {
  return lastRunSummary;
}

module.exports = {
  startDatatruckDocumentService,
  stopDatatruckDocumentService,
  runOnce,
  tick,
  getLastRunSummary,
  // exported for tests
  windowIso,
  downloadDocument,
  sendDocumentToGroup,
};
