/**
 * Silent BOL/POD TEST monitor — reporting only.
 *
 * Given the result of the existing detect→classify→match pipeline
 * (processCollectedBatch), this builds a diagnostic report and posts it — and
 * optionally the file(s) — to a configured TEST Telegram group. It exists to
 * audit whether AI classification + load matching are correct WITHOUT touching
 * the driver group and WITHOUT ever uploading to Datatruck.
 *
 * Hard guarantees (see PART 9 of the spec):
 *   - This module NEVER requires or calls the Datatruck uploader. It only reads
 *     a classification/match result, formats text, and sends to the test group.
 *   - It never replies in the driver group (the caller decides that separately).
 *   - It never throws to its caller (a monitor failure must not break intake).
 *
 * Toggle behavior (PART 8):
 *   - type 'unrelated' → reported only when settings.sendUnrelated
 *   - type 'unclear'   → reported only when settings.sendUnclear
 *   - bol / pod / both / mismatch / no-load → always reported when enabled
 */
const helpers = require('./documentIntakeHelpers');
const mergeDefault = require('./documentMergeService');
const settingsDbDefault = require('../database/bolPodMonitorSettings');
const { safeSend, sendTelegramHtmlChunks } = require('./telegramHtml');

const esc = helpers.escapeHtml;
const DOC_TYPE_LABEL = helpers.DOC_TYPE_LABEL;
const CONFIDENCE_LABEL = helpers.CONFIDENCE_LABEL;

// Guard so a very large single file can't blow past Telegram's bot upload limit.
const MAX_SEND_BYTES = 45 * 1024 * 1024;

/** Should a document of this classified type be reported, per the toggles? */
function shouldReport(docType, settings) {
  if (docType === 'unrelated') return settings.sendUnrelated === true;
  if (docType === 'unclear') return settings.sendUnclear === true;
  return true; // bol / pod / both / anything with a real match outcome
}

function pct(conf) {
  const n = Number(conf);
  if (!Number.isFinite(n)) return null;
  return `${Math.round((n <= 1 ? n * 100 : n))}%`;
}

/** Friendly "location hint" line from the matcher's stage/distance output. */
function locationHint(match = {}) {
  if (match.stageHint === 'pickup') {
    const d = Number.isFinite(match.distanceToPickupMiles) ? ` (~${match.distanceToPickupMiles.toFixed(1)} mi)` : '';
    return `near pickup${d} → BOL likely`;
  }
  if (match.stageHint === 'delivery') {
    const d = Number.isFinite(match.distanceToDeliveryMiles) ? ` (~${match.distanceToDeliveryMiles.toFixed(1)} mi)` : '';
    return `near delivery${d} → POD likely`;
  }
  if (Number.isFinite(match.distanceToPickupMiles) || Number.isFinite(match.distanceToDeliveryMiles)) {
    return 'not near pickup or delivery';
  }
  return 'no location available';
}

function docLoadMatchLine(classification = {}) {
  if (classification.sameLoad === true) return 'document load number/address MATCHES current Datatruck load';
  if (classification.belongsToOtherLoad === true) return 'document looks like a DIFFERENT load';
  return 'unknown (no confident cross-check)';
}

/**
 * Build the Telegram-HTML report string. Pure (no I/O) so it is unit-testable.
 * @param {object} p
 * @param {object} p.result       processCollectedBatch result (classification, match, docType, batch)
 * @param {object} [p.group]      { group_name, ... }
 * @param {object} [p.driverProfile]
 * @param {object} [p.fileInfo]   { count, merged } describing what will be attached
 */
function buildReport({ result = {}, group = null, driverProfile = null, fileInfo = null } = {}) {
  const classification = result.classification || {};
  const match = result.match || {};
  const batch = result.batch || {};
  const docType = result.docType || classification.type || 'unclear';

  const driverName = driverProfile?.full_name
    || [driverProfile?.first_name, driverProfile?.last_name].filter(Boolean).join(' ').trim()
    || batch.sender_username
    || 'Unknown';

  const senderUser = batch.sender_username ? `@${esc(batch.sender_username)}` : '(no username)';
  const senderId = batch.telegram_user_id != null ? ` (id ${esc(batch.telegram_user_id)})` : '';

  const aiConf = pct(classification.confidence);
  const matchConf = CONFIDENCE_LABEL[match.confidence] || CONFIDENCE_LABEL.none || 'None';
  const reasonBits = [classification.summary, ...((match.reasons) || [])].filter(Boolean);
  const reason = reasonBits.length ? reasonBits.join(' ') : 'No additional evidence provided.';

  const lines = [];
  lines.push('📄 <b>BOL/POD Test Detection</b>');
  lines.push('');
  lines.push('<b>Mode:</b> TEST ONLY — no Datatruck upload');
  lines.push(`<b>Driver group:</b> ${esc(group?.group_name || 'Unknown')}`);
  if (batch.telegram_chat_id != null) lines.push(`<b>Group ID:</b> ${esc(batch.telegram_chat_id)}`);
  lines.push(`<b>Driver:</b> ${esc(driverName)}`);
  if (driverProfile?.unit_number) lines.push(`<b>Unit:</b> ${esc(driverProfile.unit_number)}`);
  lines.push(`<b>Sender:</b> ${senderUser}${senderId}`);
  lines.push('');
  lines.push(`<b>Detected type:</b> ${esc(DOC_TYPE_LABEL[docType] || docType)}`);
  if (aiConf) lines.push(`<b>AI confidence:</b> ${aiConf}`);
  lines.push(`<b>Load match:</b> ${esc(matchConf)}`);
  lines.push(`<b>Datatruck order ID:</b> ${match.orderId ? esc(match.orderId) : '—'}`);
  lines.push(`<b>Load / reference:</b> ${match.loadReference ? esc(match.loadReference) : '—'}`);
  lines.push(`<b>Location hint:</b> ${esc(locationHint(match))}`);
  lines.push(`<b>Doc ↔ load:</b> ${esc(docLoadMatchLine(classification))}`);
  lines.push('');
  lines.push('<b>Reason:</b>');
  lines.push(esc(reason.slice(0, 900)));
  lines.push('');
  if (fileInfo && fileInfo.count > 0) {
    lines.push(`<b>Files:</b> ${fileInfo.count}${fileInfo.merged ? ', merged into one PDF for testing' : ''}${fileInfo.warning ? ` — ${esc(fileInfo.warning)}` : ''}`);
  } else {
    lines.push('<b>Files:</b> not attached (test_send_files off or none available)');
  }
  lines.push('<b>Duplicate check:</b> skipped (test monitor never uploads)');
  lines.push('<b>Action:</b> Sent to test group only. No upload happened.');
  return lines.join('\n');
}

function inputFromBuffer(deps, buffer, filename) {
  const Input = deps.Input || require('telegraf').Input;
  return Input.fromBuffer(buffer, filename);
}

/**
 * Prepare + send the batch files to the test group. Returns
 * { count, merged, warning } describing what happened (for the report).
 * Never throws — on failure it returns a warning and sends none/partial.
 */
async function sendFiles(telegram, chatId, files, { baseName, merge, deps }) {
  const list = (files || []).filter((f) => f && Buffer.isBuffer(f.buffer) && f.buffer.length > 0);
  if (!list.length) return { count: 0, merged: false };

  // Try to unite into the single artifact the real pipeline would upload.
  let prepared = null;
  try {
    prepared = await merge.prepareUpload(list, { baseName });
  } catch (err) {
    // Merge/unsupported failure → fall back to sending originals separately.
    let sentAny = false;
    for (let idx = 0; idx < list.length; idx += 1) {
      const f = list[idx];
      if (f.buffer.length > MAX_SEND_BYTES) continue;
      try {
        await safeSend(() => telegram.sendDocument(
          String(chatId),
          inputFromBuffer(deps, f.buffer, f.fileName || `${baseName}_${idx + 1}`),
          { caption: `Original file ${idx + 1}/${list.length}` }
        ));
        sentAny = true;
      } catch { /* keep going; report a warning */ }
    }
    return { count: list.length, merged: false, warning: `merge failed (${err.message.slice(0, 80)}); sent original files separately`, sentAny };
  }

  if (prepared.buffer.length > MAX_SEND_BYTES) {
    return { count: list.length, merged: prepared.merged, warning: 'file too large to send to Telegram; report sent without the file' };
  }

  try {
    await safeSend(() => telegram.sendDocument(
      String(chatId),
      inputFromBuffer(deps, prepared.buffer, prepared.filename),
      { caption: prepared.merged ? 'Merged BOL/POD (test monitor)' : 'BOL/POD (test monitor)' }
    ));
    return { count: list.length, merged: prepared.merged };
  } catch (err) {
    return { count: list.length, merged: prepared.merged, warning: `could not send file: ${err.message.slice(0, 80)}` };
  }
}

/**
 * Report one detected batch to the test group. Silent, upload-free.
 *
 * @param {object} p
 * @param {object} p.telegram      telegraf telegram client
 * @param {object} p.result        processCollectedBatch result
 * @param {object} p.settings      effective monitor settings (from settings service)
 * @param {object} [p.group]
 * @param {object} [p.driverProfile]
 * @param {Function} [p.loadFiles] async () => Array<{buffer,mimeType,fileName}> (only called when needed)
 * @param {object} [deps]          { merge, settingsDb, Input } injectable for tests
 * @returns {Promise<{sent:boolean, reason?:string, error?:string, docType?:string}>}
 */
async function reportDetection({ telegram, result, settings, group = null, driverProfile = null, loadFiles = null }, deps = {}) {
  const merge = deps.merge || mergeDefault;
  const settingsDb = deps.settingsDb || settingsDbDefault;

  try {
    if (!settings || settings.enabled !== true) return { sent: false, reason: 'monitor_disabled' };
    const chatId = settings.testGroupId;
    if (!chatId) return { sent: false, reason: 'no_test_group' };
    if (!result || result.action === 'gone' || result.action === 'noop') {
      return { sent: false, reason: 'no_result' };
    }

    const classification = result.classification || {};
    const docType = result.docType || classification.type || 'unclear';
    if (!shouldReport(docType, settings)) {
      return { sent: false, reason: 'suppressed_by_toggle', docType };
    }

    // Optionally attach the file(s) — only load/download them when asked.
    let fileInfo = null;
    if (settings.sendFiles === true && typeof loadFiles === 'function') {
      let files = [];
      try { files = await loadFiles(); } catch { files = []; }
      if (files && files.length) {
        const baseName = `${(docType === 'pod' ? 'POD' : docType === 'bol' ? 'BOL' : 'DOC')}_test`;
        fileInfo = await sendFiles(telegram, chatId, files, { baseName, merge, deps });
      }
    }

    const html = buildReport({ result, group, driverProfile, fileInfo });
    await sendTelegramHtmlChunks(telegram, String(chatId), html, { disable_web_page_preview: true });

    // Best-effort audit stamp (never fatal).
    try { await settingsDb.recordReportSent(1); } catch { /* ignore */ }

    return { sent: true, docType, chatId: String(chatId) };
  } catch (err) {
    // A monitor failure must never break intake — log and swallow.
    console.error('[BOLPOD MONITOR] report failed:', err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = {
  reportDetection,
  buildReport,
  shouldReport,
  locationHint,
  MAX_SEND_BYTES,
};
