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
const datatruck = require('./datatruckApiService');
const docsDb = require('../database/datatruckDocuments');
const bolPodSettings = require('../database/bolPodForwardingSettings');
const { classifyDocument } = require('./bolPodClassifier');
const { listCanonicalDriverGroups } = require('./driverGroupDirectoryService');
const { withRunRecord, noteHeartbeat } = require('./operations/runLedger');
const {
  extractTrackedDocuments,
  buildGroupMatchIndex,
  matchDocumentToGroup,
  isDeliverySettled,
} = require('./datatruckDocumentHelpers');
// Fetching a file and putting it in a Telegram group — its own module, with
// the bandwidth rule that keeps document bytes off this process.
const { downloadDocument, sendDocumentToGroup } = require('./datatruckDocumentSender');

const MAX_ATTEMPTS = 6;

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
  // The row the scan already read for this document, when there is one: it is
  // used as-is rather than upserted and read back again.
  const known = ctx.existing || null;
  const deliveryRow = async (meta) => (known ? { row: known } : docsDb.upsertDelivery(meta));
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
    const { row } = await deliveryRow(meta);
    await skipIfUnacted(row, 'driver', 'skipped_unclear');
    if (uncertainPolicy === 'central_review' && centralApplicable) {
      const r = await deliverDestination(row.id, 'central', centralGroupId, doc, {}, { review: true });
      return { skippedUnclear: true, centralSent: r.sent === true, failed: r.attempted && !r.sent, error: r.error };
    }
    await skipIfUnacted(row, 'central', 'skipped_unclear');
    return { skippedUnclear: true };
  }

  // Confident BOL/POD → route to driver and/or central.
  const { row } = await deliveryRow(meta);
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
    scanned: 0, alreadySettled: 0, backfillSuppressed: 0, driverSent: 0, centralSent: 0,
    skippedNoGroup: 0, skippedType: 0, skippedUnrelated: 0, skippedUnclear: 0, failed: 0,
  };
  const errors = [];

  // ONE narrow read for the whole window, then skip whatever is settled. The
  // window is a week of documents and nearly all of them were dealt with on an
  // earlier pass; each used to cost an upsert and a full-row read back.
  const docsByOrder = orders.map((order) => extractTrackedDocuments(order));
  const known = await docsDb.getDeliveryStates(docsByOrder.flat().map((d) => d.signature));

  for (const docs of docsByOrder) {
    for (const doc of docs) {
      c.scanned += 1;
      const existing = known.get(doc.signature) || null;
      if (isDeliverySettled(existing, MAX_ATTEMPTS)) {
        c.alreadySettled += 1;
        continue;
      }
      try {
        const r = await routeDocument(doc, { ...ctx, existing });
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
    alreadySettled: c.alreadySettled,
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
    // RECORDED AS `blocked`, NOT AS SILENCE. Each of these is a switch a
    // person has to throw, and a feature that is merely off must say so —
    // otherwise it is indistinguishable from one whose timer died.
    if (!config.datatruckDocDeliveryEnabled) {
      await noteHeartbeat('datatruck_documents', {
        status: 'blocked', detail: 'turned off by the deployment kill-switch',
      });
      return;
    }
    if (!datatruck.isConfigured()) {
      await noteHeartbeat('datatruck_documents', {
        status: 'blocked', detail: 'no Datatruck credentials are configured',
      });
      return;
    }
    const settings = await bolPodSettings.getBolPodConfig();
    if (!settings.enabled) {
      await noteHeartbeat('datatruck_documents', {
        status: 'blocked', detail: 'switched off in Settings',
      });
      return;
    }
    await withRunRecord('datatruck_documents', () => runOnce());
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
