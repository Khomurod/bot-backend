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
const { getFinanceSettings, isFinanceChat } = require('../../database/financeSettings');
const financeMessages = require('../../database/financeMessages');

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

  return financeMessages.recordMoneycode(messageRefId, {
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
      return { handled: true, reason: 'edited', status: parsed.status, id };
    }

    const { id, created } = await financeMessages.captureMessage(shaped, parsed);
    if (!created) return { handled: true, reason: 'already captured', status: parsed.status, id };

    await recordCodeIfParsed(id, shaped, parsed, settings);
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

module.exports = { captureFinanceMessage, shapeMessage };
