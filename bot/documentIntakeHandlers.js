/**
 * Telegram wiring for the smart BOL/POD intake.
 *
 * Two independent modes share the same detection/batching machinery:
 *   1. Upload pipeline (config.datatruckDocUploadEnabled) — posts the inline
 *      Yes/No/Disregard card in the driver group and, on Yes, uploads to
 *      Datatruck (dry-run by default). Unchanged existing behavior.
 *   2. Silent test monitor (DB setting, admin Settings → BOL/POD Monitor) — runs
 *      the SAME detect→classify→match, but sends a diagnostic report (and
 *      optionally the files) to a configured TEST group ONLY. It never replies
 *      in the driver group, shows no buttons, and NEVER uploads to Datatruck.
 *
 * The message handler runs when EITHER mode is active. Follows repo conventions:
 * takes `bot` as a param (no require('./bot') — avoids the circular dep),
 * resolves the group via db.getGroupByTelegramId, guards group_type==='driver'
 * && active, downloads via telegram.getFileLink, and is registered BEFORE the
 * callback_query catch-all in bot.js. Never throws out of a handler (intake must
 * never break normal message processing).
 */
const config = require('../config/config');
const db = require('../database/db');
const docsDb = require('../database/telegramDocuments');
const intake = require('../services/documentIntakeService');
const helpers = require('../services/documentIntakeHelpers');
const { safeSend } = require('../services/telegramHtml');
const monitorSettingsService = require('../services/bolPodMonitorSettingsService');
const testMonitor = require('../services/bolPodTestMonitorService');

// Debounce timers keyed by batch id (in-memory; a restart is covered by the
// expires_at housekeeping sweep + collecting-batch expiry).
const debounceTimers = new Map();

const DOWNLOAD_TIMEOUT_MS = 60_000;

function maxFileBytes() {
  return config.datatruckDocIntakeMaxFileMb * 1024 * 1024;
}

/** Download a Telegram file to a Buffer, enforcing the size cap. */
async function downloadTelegramFile(telegram, fileId, maxBytes = maxFileBytes()) {
  const link = await telegram.getFileLink(fileId);
  const res = await fetch(String(link), { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Telegram file download failed: HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('File exceeds size limit.');
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error('File exceeds size limit.');
  return buffer;
}

/** Context resolver passed to the orchestration service. */
async function getContext(batch) {
  let driverProfile = null;
  try {
    if (batch.group_id != null) driverProfile = await db.getDriverProfileByGroupId(batch.group_id);
  } catch { /* ignore */ }
  const group = driverProfile
    ? { id: batch.group_id, group_name: driverProfile.group_name }
    : (batch.group_id != null ? { id: batch.group_id, group_name: null } : null);
  return { group, driverProfile };
}

/** Download every file of a batch to Buffers (for the silent monitor). */
async function downloadBatchFiles(telegram, batchId) {
  const rows = await docsDb.listBatchFiles(batchId).catch(() => []);
  const files = [];
  for (const row of rows || []) {
    try {
      const buffer = await downloadTelegramFile(telegram, row.telegram_file_id);
      if (buffer && buffer.length) files.push({ buffer, mimeType: row.mime_type, fileName: row.file_name });
    } catch { /* skip a file we couldn't fetch */ }
  }
  return files;
}

/** Finalize a collected batch: classify → match → (monitor report and/or card). */
async function finalizeBatch(telegram, batchId) {
  debounceTimers.delete(batchId);
  try {
    const result = await intake.processCollectedBatch(batchId, {
      docs: docsDb,
      getContext,
      downloadFile: (fileId) => downloadTelegramFile(telegram, fileId),
      config,
    });

    // ── Silent test monitor (independent of the upload pipeline) ──
    // Reports to the configured TEST group only; never touches the driver group
    // and never uploads to Datatruck.
    try {
      const monitorSettings = await monitorSettingsService.getEffectiveSettings();
      if (monitorSettings.enabled && result?.batch && result.action !== 'gone' && result.action !== 'noop') {
        const { group, driverProfile } = await getContext(result.batch);
        await testMonitor.reportDetection({
          telegram,
          result,
          settings: monitorSettings,
          group,
          driverProfile,
          loadFiles: () => downloadBatchFiles(telegram, batchId),
        });
      }
    } catch (err) {
      console.error(`[DOC-INTAKE] monitor ${batchId} error:`, err.message);
    }

    // ── Driver-group confirmation card — ONLY when the upload pipeline is on ──
    if (!config.datatruckDocUploadEnabled) return;
    if (!result?.message) return;
    const batch = result.batch;
    const chatId = batch?.telegram_chat_id;
    if (!chatId) return;
    const extra = { parse_mode: 'HTML', disable_web_page_preview: true };
    if (result.keyboard) extra.reply_markup = result.keyboard;
    const sent = await safeSend(() => telegram.sendMessage(chatId, result.message, extra)).catch(() => null);
    if (sent?.message_id && result.action === 'confirm') {
      await docsDb.updateBatch(batchId, { confirmation_chat_id: chatId, confirmation_message_id: sent.message_id }).catch(() => {});
    }
    console.log(`[DOC-INTAKE] Batch ${batchId}: ${result.action} (type=${result.docType}, match=${result.match?.confidence})`
      + (config.datatruckDocUploadDryRun ? ' [DRY-RUN]' : ''));
  } catch (err) {
    console.error(`[DOC-INTAKE] finalizeBatch ${batchId} error:`, err.message);
    await docsDb.updateBatch(batchId, { status: 'failed' }).catch(() => {});
  }
}

function scheduleFinalize(telegram, batchId) {
  const waitMs = config.datatruckDocIntakeBatchWaitSeconds * 1000;
  const existing = debounceTimers.get(batchId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => { finalizeBatch(telegram, batchId).catch(() => {}); }, waitMs);
  t.unref?.();
  debounceTimers.set(batchId, t);
}

/** Handle one incoming message that may carry a document/photo. */
async function handleIntakeMessage(ctx) {
  const message = ctx.message;
  const attachment = helpers.detectAttachment(message);
  if (!attachment) return;

  const ignore = helpers.isIgnorableMessage(message, { selfBotId: ctx.botInfo?.id });
  if (ignore.ignore) return;

  if (!helpers.sizeWithinLimit(attachment.fileSize, maxFileBytes())) return;

  const chat = ctx.chat;
  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return;

  let group = null;
  try { group = await db.getGroupByTelegramId(chat.id); } catch { return; }
  if (!group || group.group_type !== 'driver' || group.active === false) return;

  // Mode gate: process only when EITHER the upload pipeline is enabled OR the
  // silent test monitor is enabled. Reading the monitor setting is cached +
  // fail-safe and only happens for real PDF/image messages in a driver group.
  const uploadEnabled = config.datatruckDocUploadEnabled === true;
  let monitorEnabled = false;
  if (!uploadEnabled) {
    try { monitorEnabled = (await monitorSettingsService.getEffectiveSettings()).enabled === true; }
    catch { monitorEnabled = false; }
  }
  if (!uploadEnabled && !monitorEnabled) return;

  const from = ctx.from || {};
  const expiresAt = new Date(Date.now() + Math.max(30, config.datatruckDocIntakeBatchWaitSeconds + 30) * 1000).toISOString();

  // Resolve the batch: album → one batch; else reuse an open sender batch, or start one.
  let batch = null;
  const mediaGroupId = message.media_group_id ? String(message.media_group_id) : null;
  try {
    if (mediaGroupId) {
      batch = await docsDb.getOrCreateBatchForMediaGroup({
        mediaGroupId, telegramChatId: chat.id, groupId: group.id,
        telegramUserId: from.id || null, senderUsername: from.username || null, expiresAt,
      });
    } else {
      batch = await docsDb.findOpenBatchForSender({
        telegramChatId: chat.id, telegramUserId: from.id || null,
        windowSeconds: config.datatruckDocIntakeBatchWaitSeconds,
      });
      if (!batch) {
        batch = await docsDb.createBatch({
          telegramChatId: chat.id, groupId: group.id, telegramUserId: from.id || null,
          senderUsername: from.username || null, expiresAt,
        });
      }
    }
  } catch (err) {
    console.error('[DOC-INTAKE] batch upsert error:', err.message);
    return;
  }
  if (!batch) return;

  // Enforce the per-batch file cap.
  let existingFiles = [];
  try { existingFiles = await docsDb.listBatchFiles(batch.id); } catch { /* ignore */ }
  if (existingFiles.length >= config.datatruckDocIntakeMaxFiles) {
    return; // silently stop adding; the batch will finalize with what it has
  }

  try {
    await docsDb.addFileToBatch(batch.id, {
      telegramFileId: attachment.fileId,
      telegramFileUniqueId: attachment.fileUniqueId,
      telegramMessageId: message.message_id,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      fileSize: attachment.fileSize,
      kind: attachment.kind,
      sortOrder: message.message_id || existingFiles.length,
    });
  } catch (err) {
    // A failure here means the file row never landed, so finalizeBatch is never
    // scheduled and no classification/match/monitor report happens — the exact
    // symptom of the "silent monitor does nothing" bug. Log enough to tell an
    // ON CONFLICT / unique-index mismatch apart from an ordinary insert failure,
    // WITHOUT leaking any file bytes or secrets (ids/codes only).
    const pgCode = err && err.code ? ` [pg ${err.code}]` : '';
    const conflictHint = /ON CONFLICT/i.test(err?.message || '')
      ? ' (likely ON CONFLICT / unique-index mismatch — check addFileToBatch vs schema.sql idx_tg_doc_files_unique_id)'
      : '';
    console.error(
      `[DOC-INTAKE] addFileToBatch error for batch ${batch.id}`
      + `${pgCode}: ${err.message}${conflictHint}`
    );
    return;
  }

  scheduleFinalize(ctx.telegram, batch.id);
}

async function handleIntakeCallback(ctx) {
  const parsed = helpers.parseCallbackData(ctx.callbackQuery?.data);
  if (!parsed) return false; // not ours — let the catch-all ack it
  const { action, batchId } = parsed;

  // Group-open buttons: anyone who can see the card may press Yes/No/Disregard.
  // There is no authorization gate; duplicate uploads are still prevented by the
  // atomic claim in the service. Record who clicked for audit/history only.
  const from = ctx.from || {};
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim() || '—';
  console.log(`[DOC-INTAKE] Batch ${batchId}: '${action}' pressed by user ${from.id ?? '—'} (@${from.username || '—'}, ${name})`);

  let result;
  try {
    result = await intake.handleConfirmation({
      batchId, action, user: from,
    }, {
      docs: docsDb,
      downloadFile: (fileId) => downloadTelegramFile(ctx.telegram, fileId),
    });
  } catch (err) {
    console.error('[DOC-INTAKE] confirmation error:', err.message);
    await ctx.answerCbQuery('Something went wrong handling that.').catch(() => {});
    return true;
  }

  if (!result.handled) {
    // e.g. "Already handled." (double-click / late click) — toast, don't touch
    // the card (another click already replaced it or it's terminal).
    await ctx.answerCbQuery(result.reply || undefined).catch(() => {});
    return true;
  }
  // Handled outcome → ack and replace the card with the result (drops buttons).
  await ctx.answerCbQuery().catch(() => {});
  const text = `📄 ${result.reply}`;
  await safeSend(() => ctx.editMessageText(text, { parse_mode: 'HTML' })).catch(async () => {
    const chatId = ctx.callbackQuery?.message?.chat?.id || ctx.chat?.id;
    if (chatId) await safeSend(() => ctx.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' })).catch(() => {});
  });
  return true;
}

function registerDocumentIntakeHandlers(bot) {
  bot.on('message', async (ctx, next) => {
    try {
      // handleIntakeMessage decides internally whether either mode (upload
      // pipeline or silent test monitor) is active — so the monitor can run even
      // when the upload pipeline is off.
      await handleIntakeMessage(ctx);
    } catch (err) {
      console.error('[DOC-INTAKE] message handler error:', err.message);
    }
    return next();
  });

  bot.action(/^dtdoc:(yes|no|disc):(\d+)$/, async (ctx) => {
    try {
      await handleIntakeCallback(ctx);
    } catch (err) {
      console.error('[DOC-INTAKE] action handler error:', err.message);
      await ctx.answerCbQuery().catch(() => {});
    }
  });

  console.log('[DOC-INTAKE] Telegram BOL/POD intake handlers registered'
    + (config.datatruckDocUploadEnabled
      ? (config.datatruckDocUploadDryRun ? ' (upload: enabled, DRY-RUN)' : ' (upload: enabled, LIVE)')
      : ' (upload: disabled)')
    + ' (silent test monitor: DB-controlled via admin Settings)');
}

module.exports = {
  registerDocumentIntakeHandlers,
  // exported for tests / reuse
  handleIntakeMessage,
  handleIntakeCallback,
  downloadTelegramFile,
  downloadBatchFiles,
  finalizeBatch,
  getContext,
};
