/**
 * Pure helpers for the smart BOL/POD intake — attachment detection, ignore
 * rules, uploader authorization, and confirmation-message/keyboard building.
 * No Telegram, DB, or network here, so all of it is unit-testable.
 */
const CALLBACK_PREFIX = 'dtdoc';

const PDF_EXT_RE = /\.pdf$/i;
const IMAGE_EXT_RE = /\.(jpe?g|png|heic|heif)$/i;
const IMAGE_MIME_RE = /^image\/(jpe?g|png|heic|heif)$/i;

/** Classify a document by mime/filename → 'pdf' | 'image' | null. */
function classifyDocKind(mimeType, fileName) {
  const mime = String(mimeType || '').toLowerCase();
  const name = String(fileName || '');
  if (mime === 'application/pdf' || PDF_EXT_RE.test(name)) return 'pdf';
  if (IMAGE_MIME_RE.test(mime) || IMAGE_ext(name)) return 'image';
  return null;
}
function IMAGE_ext(name) { return IMAGE_EXT_RE.test(name); }

/**
 * Detect a PDF/image attachment on a Telegram message. Returns the file handle
 * or null. Photos (message.photo) and PDF/image documents are detected; videos,
 * voice, audio, stickers, animations are ignored (they live on other fields, so
 * they simply don't match here).
 */
function detectAttachment(message) {
  if (!message || typeof message !== 'object') return null;

  if (Array.isArray(message.photo) && message.photo.length) {
    // photo is an array of sizes ascending; the last is the largest.
    const largest = message.photo[message.photo.length - 1];
    return {
      kind: 'image',
      fileId: largest.file_id,
      fileUniqueId: largest.file_unique_id,
      fileName: null,
      mimeType: 'image/jpeg',
      fileSize: largest.file_size != null ? Number(largest.file_size) : null,
    };
  }

  const doc = message.document;
  if (doc && doc.file_id) {
    const kind = classifyDocKind(doc.mime_type, doc.file_name);
    if (!kind) return null;
    return {
      kind,
      fileId: doc.file_id,
      fileUniqueId: doc.file_unique_id,
      fileName: doc.file_name || null,
      mimeType: (doc.mime_type || (kind === 'pdf' ? 'application/pdf' : 'image/jpeg')).toLowerCase(),
      fileSize: doc.file_size != null ? Number(doc.file_size) : null,
    };
  }
  return null;
}

/**
 * Should this message be ignored for intake? Blocks the bot's own messages, any
 * bot's messages, messages sent via an inline bot, and files forwarded from a
 * bot (which is how our own Datatruck→Telegram forwarding would come back —
 * loop prevention). A human forwarding a shipper's document is NOT ignored.
 */
function isIgnorableMessage(message, { selfBotId = null } = {}) {
  if (!message) return { ignore: true, reason: 'no message' };
  const from = message.from || {};
  if (from.is_bot === true) return { ignore: true, reason: 'sender is a bot' };
  if (selfBotId != null && String(from.id) === String(selfBotId)) return { ignore: true, reason: 'sender is this bot' };
  if (message.via_bot) return { ignore: true, reason: 'sent via inline bot' };
  const fwd = message.forward_from || message.forward_origin?.sender_user || null;
  if (fwd && fwd.is_bot === true) return { ignore: true, reason: 'forwarded from a bot' };
  if (message.forward_from?.id != null && selfBotId != null && String(message.forward_from.id) === String(selfBotId)) {
    return { ignore: true, reason: 'forwarded from this bot' };
  }
  return { ignore: false, reason: null };
}

/** Is a file within the configured size limit? */
function sizeWithinLimit(fileSize, maxBytes) {
  if (fileSize == null) return true; // unknown until download; download enforces the cap
  return Number(fileSize) <= Number(maxBytes);
}

/**
 * Authorize a user to press the upload buttons. `privileged` is computed by the
 * caller from the app's existing dispatch/accounting/global-admin helpers; on
 * top of that an explicit approver list and the group's Telegram admins are
 * allowed. Everyone else is rejected — random group chatter can never upload.
 */
function authorizeUploader(user, {
  approvers = [], groupAdminIds = [], privileged = false,
} = {}) {
  if (!user || user.id == null) return { allowed: false, reason: 'no user' };
  if (privileged) return { allowed: true, reason: 'privileged admin' };
  const uname = String(user.username || '').replace(/^@+/, '').toLowerCase();
  const idStr = String(user.id);
  const approverList = (approvers || []).map((a) => String(a).replace(/^@+/, '').toLowerCase());
  if (uname && approverList.includes(uname)) return { allowed: true, reason: 'configured approver (username)' };
  if (approverList.includes(idStr)) return { allowed: true, reason: 'configured approver (id)' };
  if ((groupAdminIds || []).map(String).includes(idStr)) return { allowed: true, reason: 'group admin' };
  return { allowed: false, reason: 'not authorized' };
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const CONFIDENCE_LABEL = { high: 'High', medium: 'Medium', low: 'Low', mismatch: 'Mismatch', none: 'None' };
const DOC_TYPE_LABEL = { bol: 'BOL', pod: 'POD', both: 'BOL + POD', unrelated: 'Unrelated', unclear: 'Unclear' };

/**
 * Build the inline confirmation message (HTML). Includes a clear TEST-MODE
 * banner in dry-run so ops can see the feature working.
 */
function buildConfirmationMessage({
  mentionHtml, driverName, docType, loadReference, matchConfidence, reason, fileCount = 1, dryRun = false,
}) {
  const typeLabel = DOC_TYPE_LABEL[docType] || 'Document';
  const who = mentionHtml || escapeHtml(driverName || 'driver');
  const lines = ['📄 <b>Document detected</b>', ''];
  lines.push(`Driver: ${who}`);
  if (loadReference) lines.push(`Load: <b>${escapeHtml(loadReference)}</b>`);
  lines.push(`Type: <b>${escapeHtml(typeLabel)}</b>`);
  lines.push(`Confidence: ${escapeHtml(CONFIDENCE_LABEL[matchConfidence] || 'Unknown')}`);
  if (fileCount > 1) lines.push(`Files: ${fileCount} (will be merged into one PDF)`);
  if (reason) lines.push(`Reason: ${escapeHtml(reason)}`);
  lines.push('');
  lines.push(dryRun
    ? `🧪 <i>Test mode:</i> confirming will simulate the upload of this ${escapeHtml(typeLabel)} to Datatruck (no file is sent).`
    : `Upload this ${escapeHtml(typeLabel)} to Datatruck?`);
  return lines.join('\n');
}

/** Inline keyboard: ✅ Yes / ❌ No / 🗑 Disregard. Telegraf Markup-free shape. */
function buildConfirmationKeyboard(batchId) {
  return {
    inline_keyboard: [[
      { text: '✅ Yes, upload', callback_data: `${CALLBACK_PREFIX}:yes:${batchId}` },
      { text: '❌ No', callback_data: `${CALLBACK_PREFIX}:no:${batchId}` },
      { text: '🗑 Disregard', callback_data: `${CALLBACK_PREFIX}:disc:${batchId}` },
    ]],
  };
}

/** Parse a callback_query data string → { action, batchId } or null. */
function parseCallbackData(data) {
  const m = String(data || '').match(new RegExp(`^${CALLBACK_PREFIX}:(yes|no|disc):(\\d+)$`));
  if (!m) return null;
  return { action: m[1], batchId: Number(m[2]) };
}

module.exports = {
  CALLBACK_PREFIX,
  classifyDocKind,
  detectAttachment,
  isIgnorableMessage,
  sizeWithinLimit,
  authorizeUploader,
  buildConfirmationMessage,
  buildConfirmationKeyboard,
  parseCallbackData,
  escapeHtml,
  DOC_TYPE_LABEL,
  CONFIDENCE_LABEL,
};
