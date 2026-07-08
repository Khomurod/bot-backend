/**
 * Orchestration for the smart BOL/POD intake — the glue between the DB pipeline,
 * the AI classifier, the load matcher, and the Datatruck uploader. Kept free of
 * Telegram specifics (the bot handler passes in downloadFile/context/auth) so it
 * is unit-testable.
 *
 * Two entry points:
 *   processCollectedBatch(batchId, deps) — download files → classify → match →
 *     decide the next state and produce the message/keyboard the bot should send.
 *   handleConfirmation({ batchId, action, user, authorized }, deps) — react to a
 *     Yes/No/Disregard button press, atomically and idempotently.
 *
 * Safety invariants enforced here:
 *   - An upload confirmation (Yes buttons) is only ever offered for a concrete
 *     bol/pod type WITH a matched Datatruck order. Unrelated → ignored; unclear
 *     or "both" → needs_review; no load → no_match. None of those can upload.
 *   - Yes requires authorization AND an atomic claim, so an unauthorized user or
 *     a double-click can never cause an upload (or a second upload).
 */
const helpers = require('./documentIntakeHelpers');
const classifierDefault = require('./documentClassifierService');

function uploadableType(docType) {
  return docType === 'bol' || docType === 'pod';
}

/**
 * Classify + match a collected batch and decide what to do. Returns:
 *   { action:'confirm'|'no_match'|'ignored'|'needs_review',
 *     status, message, keyboard?, classification, match, docType }
 */
async function processCollectedBatch(batchId, deps = {}) {
  const docs = deps.docs || require('../database/telegramDocuments');
  const classifier = deps.classifier || classifierDefault;
  const matcher = deps.matcher || require('./documentLoadMatcher');
  const config = deps.config || require('../config/config');
  const downloadFile = deps.downloadFile;
  const getContext = deps.getContext || (async () => ({ group: null, driverProfile: null }));

  const batch = await docs.getBatchById(batchId);
  if (!batch) return { action: 'gone', status: null };
  if (batch.status !== 'collecting') {
    // Already progressed (restart/retry double-fire) — do nothing.
    return { action: 'noop', status: batch.status };
  }

  await docs.updateBatch(batchId, { status: 'classifying' });
  const fileRows = await docs.listBatchFiles(batchId);

  // Download the bytes (bounded by the size cap the caller enforces).
  const files = [];
  for (const row of fileRows) {
    try {
      const buffer = await downloadFile(row.telegram_file_id);
      if (buffer && buffer.length) {
        files.push({ buffer, mimeType: row.mime_type, fileName: row.file_name, kind: row.kind });
      }
    } catch { /* skip a file we couldn't fetch */ }
  }

  const { group, driverProfile } = await getContext(batch);
  const driverName = driverProfile?.full_name
    || [driverProfile?.first_name, driverProfile?.last_name].filter(Boolean).join(' ').trim()
    || batch.sender_username
    || null;

  // 1) Classify.
  const classification = await classifier.classifyBatch(files, {
    driverName, unitNumber: driverProfile?.unit_number || null,
  }, deps.classifierDeps || {});

  // 2) Match to a Datatruck load.
  let match = { confidence: 'none', orderId: null, loadReference: null, reasons: [] };
  try {
    match = await matcher.matchLoadForBatch({ group, driverProfile, classification }, deps.matcherDeps || {});
  } catch { /* leave as none */ }

  const docType = classification.type;
  const reason = [classification.summary, ...(match.reasons || [])].filter(Boolean).join(' ');

  // 3) Decide.
  let action; let status;
  if (docType === 'unrelated') {
    action = 'ignored'; status = 'ignored';
  } else if (!uploadableType(docType)) {
    // 'both' or 'unclear' — a human must review/classify; never auto-offer upload.
    action = 'needs_review'; status = 'needs_review';
  } else if (!match.orderId) {
    action = 'no_match'; status = 'no_match';
  } else if (match.confidence === 'mismatch') {
    // The document looks like it belongs to a DIFFERENT load — never offer a
    // one-click upload to the matched order. A human must resolve the mismatch.
    action = 'needs_review'; status = 'needs_review';
  } else {
    action = 'confirm'; status = 'waiting_confirmation';
  }

  await docs.updateBatch(batchId, {
    status,
    detected_doc_type: docType,
    datatruck_order_id: match.orderId || null,
    datatruck_load_reference: match.loadReference || null,
    match_confidence: match.confidence || null,
    confidence: typeof classification.confidence === 'number' ? classification.confidence : null,
    ai_summary: classification.summary || null,
  });

  const result = { action, status, classification, match, docType, batch };

  if (action === 'confirm') {
    result.message = helpers.buildConfirmationMessage({
      mentionHtml: deps.mentionHtml || null,
      driverName,
      docType,
      loadReference: match.loadReference,
      matchConfidence: match.confidence,
      reason: reason.slice(0, 400),
      fileCount: files.length,
      dryRun: config.datatruckDocUploadDryRun,
    });
    result.keyboard = helpers.buildConfirmationKeyboard(batchId);
  } else if (action === 'no_match') {
    result.message = `📄 A ${helpers.DOC_TYPE_LABEL[docType] || 'document'} was detected from ${helpers.escapeHtml(driverName || 'the driver')}, but it could not be confidently matched to a Datatruck load. Set the driver's current load and resend, or handle it manually.`;
  } else if (action === 'needs_review') {
    result.message = match.confidence === 'mismatch'
      ? `📄 A ${helpers.escapeHtml(helpers.DOC_TYPE_LABEL[docType] || 'document')} was detected from ${helpers.escapeHtml(driverName || 'the driver')}, but it looks like it belongs to a DIFFERENT load than the current one — a dispatcher should review before any upload. ${helpers.escapeHtml(reason.slice(0, 300))}`
      : `📄 A document was detected but the type is ${helpers.escapeHtml(helpers.DOC_TYPE_LABEL[docType] || 'unclear')} — needs a human to review before any upload.`;
  }
  return result;
}

/**
 * Handle a Yes/No/Disregard press. `authorized` is precomputed by the caller
 * (dispatch/accounting/global admins + configured approvers + group admins).
 * Returns { handled, reply, alert?, status } — reply is what to show the user.
 */
async function handleConfirmation({ batchId, action, user = {}, authorized = false }, deps = {}) {
  const docs = deps.docs || require('../database/telegramDocuments');
  const uploader = deps.uploader || require('./datatruckUploadService');
  const downloadFile = deps.downloadFile;

  const decidedBy = { decidedByUserId: user.id != null ? String(user.id) : null, decidedByUsername: user.username || null };

  const batch = await docs.getBatchById(batchId);
  if (!batch) return { handled: false, reply: 'This document request is no longer available.' };

  if (action === 'disc') {
    const row = await docs.markBatchDecision(batchId, { status: 'ignored', ...decidedBy });
    if (!row) return { handled: false, reply: 'Already handled.' };
    return { handled: true, reply: '🗑 Disregarded — I won\'t ask about these files again.', status: 'ignored' };
  }

  if (action === 'no') {
    const row = await docs.markBatchDecision(batchId, { status: 'needs_review', ...decidedBy });
    if (!row) return { handled: false, reply: 'Already handled.' };
    return { handled: true, reply: '❌ Not uploaded. Marked for review — a dispatcher can set the correct type/load.', status: 'needs_review' };
  }

  if (action === 'yes') {
    if (!authorized) {
      return { handled: false, alert: true, reply: 'You are not authorized to upload documents to Datatruck.' };
    }
    // Atomic claim: only the first Yes transitions waiting_confirmation→uploading.
    const claimed = await docs.claimBatchForUpload(batchId, decidedBy);
    if (!claimed) return { handled: false, reply: 'Already handled.' };

    const docType = claimed.detected_doc_type;
    const datatruckType = classifierDefault.datatruckFileTypeForDocType(docType);
    if (!datatruckType || !claimed.datatruck_order_id) {
      await docs.updateBatch(batchId, { status: 'needs_review' });
      return { handled: true, reply: 'Could not upload: missing document type or load — needs review.', status: 'needs_review' };
    }

    // Download the batch files (in order) for merge + upload.
    const fileRows = await docs.listBatchFiles(batchId);
    const files = [];
    for (const row of fileRows) {
      try {
        const buffer = await downloadFile(row.telegram_file_id);
        if (buffer && buffer.length) files.push({ buffer, mimeType: row.mime_type, fileName: row.file_name });
      } catch { /* skip */ }
    }
    if (!files.length) {
      await docs.updateBatch(batchId, { status: 'failed' });
      return { handled: true, reply: 'Could not download the files to upload — please resend.', status: 'failed' };
    }

    const result = await uploader.uploadConfirmedBatch({
      batchId,
      orderId: claimed.datatruck_order_id,
      loadReference: claimed.datatruck_load_reference,
      documentType: datatruckType,
      files,
    }, deps.uploaderDeps || {});

    if (result.status === 'uploaded') {
      await docs.updateBatch(batchId, { status: 'uploaded' });
      return { handled: true, reply: '✅ Datatruck upload succeeded.', status: 'uploaded', result };
    }
    if (result.status === 'dry_run') {
      await docs.updateBatch(batchId, { status: 'uploaded' });
      return { handled: true, reply: `✅ ${result.message}`, status: 'uploaded', result };
    }
    if (result.status === 'skipped_duplicate') {
      await docs.updateBatch(batchId, { status: 'duplicate' });
      return { handled: true, reply: 'ℹ️ This file appears already uploaded to Datatruck.', status: 'duplicate', result };
    }
    await docs.updateBatch(batchId, { status: 'failed' });
    return { handled: true, reply: `⚠️ Datatruck upload failed: ${result.error || 'unknown error'}`, status: 'failed', result };
  }

  return { handled: false, reply: 'Unknown action.' };
}

module.exports = {
  uploadableType,
  processCollectedBatch,
  handleConfirmation,
};
