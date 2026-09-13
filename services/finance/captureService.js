/**
 * Storing what the finance group says, and reading as much of it as is certain.
 *
 * ONE GATE, AND IT IS THE CHAT ID. `isFinanceChat` is asked about every message
 * before anything else happens, and it answers false unless the monitor is
 * switched on AND pointed at a validated group. A message from any other chat
 * leaves no trace here at all — not a row, not a log line.
 *
 * IT NEVER THROWS AT THE BOT. The handler that calls this sits in the middle of
 * Telegram's message pipeline, and a capture failure must not stop a driver's
 * message being processed by everything downstream. Failures are counted and
 * logged as ids and statuses; the message itself is never logged, because the
 * whole point of the table is that payment text lives in ONE auditable place.
 *
 * A DUPLICATE IS RECORDED, NEVER ACTED ON. Wenze does not issue money codes and
 * cannot recall one. The strongest thing it does is write `duplicate_of_id` and
 * a reason, so a person reading the list can see it. See lib/finance/duplicates.js
 * for why the two reasons stay apart.
 */
const { parseMoneycodeMessage, STATUS } = require('../../lib/finance/moneycode');
const { decideDuplicate, normalisePerson } = require('../../lib/finance/duplicates');
const { getTelegramFileDescriptor } = require('../../lib/telegram/fileDescriptor');
const { getFinanceSettings, isFinanceChat } = require('../../database/financeSettings');
const financeMessages = require('../../database/financeMessages');
const financeDocuments = require('../../database/financeDocuments');
const { wakeFinanceDocumentReader } = require('./documentReader');

/** Telegram sends seconds; the column is timestamptz. */
function toDate(unixSeconds) {
  const n = Number(unixSeconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
}

function senderName(from) {
  if (!from) return null;
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || null;
}

/**
 * Flatten a Telegram message into the columns, and nothing more.
 *
 * Exported for the handler's tests: the shaping is where a field quietly goes
 * missing, and it is worth pinning without standing up a bot.
 */
function shapeMessage(msg) {
  return {
    chatId: msg?.chat?.id,
    messageId: msg?.message_id,
    senderUserId: msg?.from?.id ?? null,
    senderUsername: msg?.from?.username ?? null,
    senderName: senderName(msg?.from),
    text: msg?.text ?? msg?.caption ?? null,
    hasDocument: Boolean(msg?.document),
    hasPhoto: Array.isArray(msg?.photo) && msg.photo.length > 0,
    mediaGroupId: msg?.media_group_id ?? null,
    messageDate: toDate(msg?.date),
    editDate: toDate(msg?.edit_date),
  };
}

/**
 * Read a parsed message's code against what is already stored, and write it.
 *
 * Only a `parsed` message produces a money-code row. `ambiguous` and `unparsed`
 * stay as captured text for a person to look at — inventing a row from a
 * message the parser could not read is exactly the guess this feature refuses.
 */
async function recordCodeIfParsed(messageRefId, shaped, parsed, settings) {
  if (parsed.status !== STATUS.PARSED || !parsed.codeNormalized) return null;

  const issuedAt = shaped.messageDate || new Date();
  const since = new Date(issuedAt.getTime() - settings.duplicateWindowHours * 3600 * 1000);
  const candidates = await financeMessages.findDuplicateCandidates({
    codeNormalized: parsed.codeNormalized,
    amount: parsed.amount,
    since,
  });

  const duplicate = decideDuplicate(
    {
      codeNormalized: parsed.codeNormalized,
      amount: parsed.amount,
      issuedToNormalized: normalisePerson(shaped.senderName),
      issuedAt,
    },
    candidates,
    { windowHours: settings.duplicateWindowHours },
  );

  const written = await financeMessages.recordMoneycode(messageRefId, {
    code: parsed.code,
    codeNormalized: parsed.codeNormalized,
    amount: parsed.amount,
    currency: parsed.currency,
    // Who POSTED it. Who it was for is not something the parser can read yet,
    // and a column filled with the sender's name under a "issued to" heading
    // would be worse than an empty one.
    issuedTo: null,
    issuedToNormalized: null,
    senderUserId: shaped.senderUserId,
    senderName: shaped.senderName,
    issuedAt,
    parserVersion: parsed.parserVersion,
    confidence: null,
    duplicateOfId: duplicate?.duplicateOfId ?? null,
    duplicateReason: duplicate?.reason ?? null,
  });
  if (written) return written;

  // The row was already there. That happens on an edit and on a re-read, and
  // in both cases THIS parse is the fresher reading of the same text — so the
  // amount beside it is brought into line rather than left to disagree with
  // the message it came from.
  return financeMessages.updateMoneycodeInterpretation(messageRefId, parsed.codeNormalized, {
    code: parsed.code,
    amount: parsed.amount,
    currency: parsed.currency,
    parserVersion: parsed.parserVersion,
    confidence: null,
    duplicateOfId: duplicate?.duplicateOfId ?? null,
    duplicateReason: duplicate?.reason ?? null,
  });
}

/**
 * Re-read one captured message with the CURRENT parser, AND persist what it
 * found.
 *
 * The database call updates the interpretation; this is where the money code
 * lands, through the same duplicate decision a live capture uses. Without this
 * step a re-read moved a message off the "unclear" pile, told the operator it
 * had succeeded, and left the Money codes tab and every weekly total still
 * missing the code it had just recognised.
 *
 * Recording is best-effort ON PURPOSE: the re-read itself succeeded, and
 * reporting it as a failure would invite a retry of something already done.
 * The outcome says whether the code landed, so the screen can be honest.
 */
async function reparseCapturedMessage(id) {
  const out = await financeMessages.reparseMessage(id);
  if (!out) return null;
  if (out.after !== STATUS.PARSED) return { id: out.id, before: out.before, after: out.after, codeRecorded: false };

  try {
    const settings = await getFinanceSettings();
    const codeId = await recordCodeIfParsed(out.id, {
      senderUserId: out.senderUserId,
      senderName: out.senderName,
      messageDate: out.messageDate,
    }, out.parsed, settings);
    return { id: out.id, before: out.before, after: out.after, codeRecorded: Boolean(codeId) };
  } catch (err) {
    console.error(`[FINANCE CAPTURE] re-read ${out.id} could not record its code:`, err.message);
    return { id: out.id, before: out.before, after: out.after, codeRecorded: false };
  }
}

/**
 * Queue the attachment, if there is one and if documents are being captured.
 *
 * THE QUEUE IS WHERE THE READING HAPPENS, NOT HERE. This runs inside Telegram's
 * message pipeline: downloading a file here would hold that pipeline open for
 * as long as the download took, on every finance message, and a slow file would
 * delay every driver's message behind it. A row and a poke is all this does.
 *
 * The poke is what makes delivery instant without a poll — see
 * services/jobQueueScheduler.js for why that trade matters.
 */
async function queueDocumentIfAny(messageRefId, msg, shaped, settings) {
  if (!settings.captureDocuments) return null;
  const file = getTelegramFileDescriptor(msg);
  if (!file) return null;

  const { created } = await financeDocuments.enqueueDocument({
    messageRefId,
    chatId: shaped.chatId,
    messageId: shaped.messageId,
    kind: file.kind,
    fileId: file.fileId,
    fileUniqueId: file.fileUniqueId,
    mimeType: file.mimeType,
    fileName: file.filename,
    fileSize: file.fileSize,
    // The caption IS the message text for an attachment-only post, and is
    // frequently the only place a recipient is named.
    caption: shaped.text,
    mediaGroupId: shaped.mediaGroupId,
  });

  if (created) wakeFinanceDocumentReader();
  return created;
}

/**
 * Handle one message from the bot.
 *
 * @returns `{ handled, reason }` — `handled: false` with a reason whenever the
 *   message was not this feature's business, so a test can tell "ignored
 *   because it is another chat" from "ignored because something broke".
 */
async function captureFinanceMessage(msg, { isEdit = false } = {}) {
  const chatId = msg?.chat?.id;
  if (chatId === undefined || chatId === null) return { handled: false, reason: 'no chat' };

  let onWatch = false;
  try {
    onWatch = await isFinanceChat(chatId);
  } catch (err) {
    // The settings read failed for a real reason. Say so rather than treating
    // it as "not the finance chat", which would silently stop capturing.
    console.warn('[FINANCE CAPTURE] could not read the settings:', err.message);
    return { handled: false, reason: 'settings unavailable' };
  }
  if (!onWatch) return { handled: false, reason: 'not the finance chat' };

  const shaped = shapeMessage(msg);
  const parsed = parseMoneycodeMessage(shaped.text);

  try {
    const settings = await getFinanceSettings();

    if (isEdit) {
      const id = await financeMessages.applyEdit(shaped.chatId, shaped.messageId, shaped.text, parsed);
      if (!id) return { handled: false, reason: 'edit of a message never captured' };
      await recordCodeIfParsed(id, shaped, parsed, settings);
      // An edit can ADD an attachment, and the unique key makes a re-queue of
      // the same file a no-op, so asking again costs nothing and misses less.
      await queueDocumentIfAny(id, msg, shaped, settings);
      return { handled: true, reason: 'edited', status: parsed.status, id };
    }

    const { id, created } = await financeMessages.captureMessage(shaped, parsed);
    if (!created) return { handled: true, reason: 'already captured', status: parsed.status, id };

    await recordCodeIfParsed(id, shaped, parsed, settings);
    await queueDocumentIfAny(id, msg, shaped, settings);
    return { handled: true, reason: 'captured', status: parsed.status, id };
  } catch (err) {
    // Ids and statuses only — never the text.
    console.error(
      `[FINANCE CAPTURE] chat ${shaped.chatId} message ${shaped.messageId} (${parsed.status}) failed:`,
      err.message,
    );
    return { handled: false, reason: 'capture failed' };
  }
}

module.exports = {
  captureFinanceMessage, shapeMessage, queueDocumentIfAny, reparseCapturedMessage,
};
