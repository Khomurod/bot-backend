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
const bolPodSettings = require('../database/bolPodForwardingSettings');
const { classifyDocument } = require('./bolPodClassifier');
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

const MAX_ATTEMPTS = 6;
const DOWNLOAD_TIMEOUT_MS = 60_000;

// Which destinations a delivery mode targets.
function destinationsForMode(mode) {
  return {
    driver: mode === 'driver_group' || mode === 'both',
    central: mode === 'central_group' || mode === 'both',
  };
}

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

/** Minimal caption/filename for an unclear document sent for human review. */
function buildReviewCaption(doc) {
  const load = doc?.loadReference || doc?.orderId;
  return `📄 Document needs review${load ? `\nLoad: ${load}` : ''}`;
}
function buildReviewFilename(doc) {
  const ref = String(doc?.loadReference || doc?.orderId || 'file').replace(/[^A-Za-z0-9._-]/g, '_');
  return `document_${ref}.pdf`;
}

/**
 * Send one document to a group. Lets Telegram fetch the URL directly; falls back
 * to downloading + uploading the bytes when Telegram cannot. In `review` mode
 * (an unclear document forwarded to the central review group) the tracked-type
 * guard is relaxed and a generic caption/filename is used.
 */
async function sendDocumentToGroup(telegramGroupId, doc, { review = false } = {}) {
  if (!review && !isTrackedDocumentType(doc?.fileType)) {
    throw new Error(`Refusing to send unsupported document type: ${doc?.fileType || 'unknown'}`);
  }
  const caption = review ? buildReviewCaption(doc) : buildDocumentCaption(doc);
  const filename = review ? buildReviewFilename(doc) : buildDocumentFilename(doc);
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
 * Mark a destination not-applicable/skipped, but ONLY while it is still
 * un-acted (pending/processing). Never overwrites a terminal sent/failed/skip —
 * so a routing-mode change does not erase an already-recorded outcome.
 */
async function skipIfUnacted(row, destination, skipStatus) {
  const current = destination === 'driver' ? row.status : row.central_status;
  if (current === 'pending' || current === 'processing') {
    await docsDb.markDestinationSkipped(row.id, destination, skipStatus);
  }
}

/**
 * Claim + send one destination. Claim is atomic (two processes cannot both send)
 * and honours the attempt cap + exponential backoff. Returns what happened so
 * the caller can count it. A destination already 'sent' (or not yet due for
 * retry) is not claimed and is left untouched — the successful side is never
 * resent.
 */
async function deliverDestination(id, destination, chatId, doc, extraSent = {}, sendOptions = {}) {
  const claimed = await docsDb.claimDestination(id, destination, { maxAttempts: MAX_ATTEMPTS });
  if (!claimed) return { attempted: false };
  try {
    const result = await sendDocumentToGroup(chatId, doc, sendOptions);
    await docsDb.markDestinationSent(id, destination, {
      telegramGroupId: chatId,
      messageId: result?.message_id || null,
      ...extraSent,
    });
    return { attempted: true, sent: true };
  } catch (err) {
    await docsDb.markDestinationFailed(id, destination, err.message).catch(() => {});
    return { attempted: true, sent: false, error: err.message };
  }
}

/**
 * Route one document per the configured delivery mode + document-type filter +
 * uncertain-document policy. Returns a small tally object.
 */
async function routeDocument(doc, ctx) {
  const { dest, documentTypeMode, uncertainPolicy, centralGroupId, centralApplicable, index, cutoffMs } = ctx;
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
    return { backfill: await docsDb.recordBackfillSuppressed(meta) };
  }

  const { classification, source } = await classifyDocument(doc);
  meta.classification = classification;
  meta.classificationSource = source;

  // Unrelated documents are never forwarded and are not tracked.
  if (classification === 'unrelated') return { skippedUnrelated: true };

  // Document-type filter for confident BOL/POD.
  if ((classification === 'bol' || classification === 'pod')
      && documentTypeMode !== 'both' && documentTypeMode !== classification) {
    return { skippedType: true };
  }

  // Uncertain documents follow the admin policy — NEVER a driver group.
  if (classification === 'unclear') {
    const { row } = await docsDb.upsertDelivery(meta);
    await skipIfUnacted(row, 'driver', 'skipped_unclear');
    if (uncertainPolicy === 'central_review' && centralApplicable) {
      const r = await deliverDestination(row.id, 'central', centralGroupId, doc, {}, { review: true });
      return { skippedUnclear: true, centralSent: r.sent === true, failed: r.attempted && !r.sent, error: r.error };
    }
    await skipIfUnacted(row, 'central', 'skipped_unclear');
    return { skippedUnclear: true };
  }

  // Confident BOL/POD → route to driver and/or central.
  const { row } = await docsDb.upsertDelivery(meta);
  // Only resolve the driver group when the mode needs it, so central-only
  // delivery is never blocked by driver-group lookup.
  const match = dest.driver ? matchDocumentToGroup(doc, index) : null;
  const driverChatId = match ? String(match.group.telegram_group_id) : null;
  // Same-group protection (only meaningful in 'both' mode): if the central group
  // IS the driver's own group, send once and mark central skipped_same_group.
  const sameGroup = dest.driver && centralApplicable && driverChatId
    && driverChatId === String(centralGroupId);

  const out = {};

  if (dest.driver) {
    if (!match) {
      await skipIfUnacted(row, 'driver', 'skipped_no_group');
      out.driverNoGroup = true;
    } else {
      const r = await deliverDestination(row.id, 'driver', match.group.telegram_group_id, doc, {
        groupId: match.group.group_id,
        matchedBy: match.matchedBy,
      });
      if (r.sent) {
        out.driverSent = true;
        console.log(
          `[DATATRUCK-DOCS] Sent ${classification.toUpperCase()} for load `
          + `${doc.loadReference || doc.orderId} to "${match.group.group_name}" (${match.matchedBy})`
        );
      } else if (r.attempted) { out.failed = true; out.error = r.error; }
    }
  } else {
    await skipIfUnacted(row, 'driver', 'skipped_not_applicable');
  }

  if (centralApplicable && !sameGroup) {
    const r = await deliverDestination(row.id, 'central', centralGroupId, doc);
    if (r.sent) out.centralSent = true;
    else if (r.attempted) { out.failed = true; out.error = r.error || out.error; }
  } else if (sameGroup) {
    await skipIfUnacted(row, 'central', 'skipped_same_group');
  } else {
    await skipIfUnacted(row, 'central', 'skipped_not_applicable');
  }

  return out;
}

/**
 * One full scan: fetch recent orders and route any new BOL/POD documents per the
 * admin settings. Returns a summary (also stored for the admin status panel).
 * @returns {Promise<object>} summary
 */
async function runOnce({ referenceMs = Date.now() } = {}) {
  if (!datatruck.isConfigured()) {
    return { configured: false, reason: 'datatruck_not_configured' };
  }
  const settings = await bolPodSettings.getBolPodConfig();
  if (!settings.enabled) {
    return { configured: true, enabled: false, reason: 'feature_disabled', ranAt: new Date().toISOString() };
  }

  const dest = destinationsForMode(settings.deliveryMode);
  const centralGroupId = settings.centralGroupId; // string | null
  const centralApplicable = dest.central && Boolean(centralGroupId);

  const cutoffMs = await resolveCutoffMs();
  const { startIso, endIso } = windowIso(referenceMs);
  const orders = await datatruck.fetchOrdersByDocumentWindow(startIso, endIso);

  // The driver-group directory is only needed when a mode routes to drivers.
  const index = dest.driver
    ? buildGroupMatchIndex(await listCanonicalDriverGroups({ operational: true, includeNonDrivers: false }))
    : { byNameKey: new Map() };

  const ctx = {
    dest,
    documentTypeMode: settings.documentTypeMode,
    uncertainPolicy: settings.uncertainDocumentPolicy,
    centralGroupId,
    centralApplicable,
    index,
    cutoffMs,
  };

  const c = {
    scanned: 0, backfillSuppressed: 0, driverSent: 0, centralSent: 0,
    skippedNoGroup: 0, skippedType: 0, skippedUnrelated: 0, skippedUnclear: 0, failed: 0,
  };
  const errors = [];

  for (const order of orders) {
    const docs = extractTrackedDocuments(order);
    for (const doc of docs) {
      c.scanned += 1;
      try {
        const r = await routeDocument(doc, ctx);
        if (r.backfill) c.backfillSuppressed += 1;
        if (r.skippedType) c.skippedType += 1;
        if (r.skippedUnrelated) c.skippedUnrelated += 1;
        if (r.skippedUnclear) c.skippedUnclear += 1;
        if (r.driverNoGroup) c.skippedNoGroup += 1;
        if (r.driverSent) c.driverSent += 1;
        if (r.centralSent) c.centralSent += 1;
        if (r.failed) { c.failed += 1; if (r.error) errors.push({ signature: doc.signature, error: r.error }); }
      } catch (err) {
        // One bad document never stops the batch.
        c.failed += 1;
        errors.push({ signature: doc.signature, error: err.message });
        console.error(`[DATATRUCK-DOCS] Error routing document ${doc.signature}: ${err.message}`);
      }
    }
  }

  const summary = {
    configured: true,
    enabled: true,
    deliveryMode: settings.deliveryMode,
    window: { startIso, endIso },
    cutoffIso: new Date(cutoffMs).toISOString(),
    ordersScanned: orders.length,
    documentsScanned: c.scanned,
    driverSent: c.driverSent,
    centralSent: c.centralSent,
    backfillSuppressed: c.backfillSuppressed,
    skippedNoGroup: c.skippedNoGroup,
    skippedType: c.skippedType,
    skippedUnrelated: c.skippedUnrelated,
    skippedUnclear: c.skippedUnclear,
    failed: c.failed,
    errors,
    ranAt: new Date().toISOString(),
  };
  lastRunSummary = summary;
  console.log(
    `[DATATRUCK-DOCS] Scan complete (${settings.deliveryMode}): ${orders.length} orders, `
    + `${c.scanned} BOL/POD docs, ${c.driverSent} driver-sent, ${c.centralSent} central-sent, `
    + `${c.backfillSuppressed} backfill, ${c.skippedNoGroup} no-group, ${c.failed} failed`
  );
  return summary;
}

async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    if (!config.datatruckDocDeliveryEnabled) return; // env kill-switch
    if (!datatruck.isConfigured()) return;
    const settings = await bolPodSettings.getBolPodConfig();
    if (!settings.enabled) return; // DB master toggle — OFF by default
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
    `[DATATRUCK-DOCS] BOL/POD forwarding poller started — every ${config.datatruckDocPollMinutes} min `
    + `(lookback ${config.datatruckDocLookbackDays}d). Idle until enabled in Settings → BOL / POD `
    + `(off by default).`
    + (datatruck.isConfigured() ? '' : ' Datatruck API not configured yet.')
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
  routeDocument,
  deliverDestination,
  destinationsForMode,
};
