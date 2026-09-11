/**
 * Two-way SMS MIRROR ledger — database helpers.
 *
 * Records each mirrored SMS so a reply is relayed into Telegram exactly once
 * (`facebook_lead_sms_mirrors`). Split out of database/facebookLeads.js, which
 * re-exports every symbol here.
 *
 * recruiter_id / from_number are the SENDER side of the mirror: which of our
 * numbers this conversation is on. Without them a reply typed in Telegram would
 * go back out from the shared company number and start a second thread on a
 * number the driver has never seen.
 */
const { query } = require('../pool');

async function insertFacebookLeadSmsMirror({
  telegramChatId,
  telegramMessageId,
  driverPhone,
  smsBody,
  leadName = null,
  pageId = null,
  ruleLabel = null,
  ringcentralMessageId = null,
  sourceType = 'outbound_auto',
  recruiterId = null,
  fromNumber = null,
  fallbackReason = null,
}) {
  const res = await query(
    `INSERT INTO facebook_lead_sms_mirrors (
       telegram_chat_id,
       telegram_message_id,
       driver_phone,
       sms_body,
       lead_name,
       page_id,
       rule_label,
       ringcentral_message_id,
       source_type,
       recruiter_id,
       from_number,
       fallback_reason
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (telegram_chat_id, telegram_message_id) DO UPDATE
       SET driver_phone = EXCLUDED.driver_phone,
           sms_body = EXCLUDED.sms_body,
           lead_name = EXCLUDED.lead_name,
           page_id = EXCLUDED.page_id,
           rule_label = EXCLUDED.rule_label,
           ringcentral_message_id = EXCLUDED.ringcentral_message_id,
           source_type = EXCLUDED.source_type,
           recruiter_id = EXCLUDED.recruiter_id,
           from_number = EXCLUDED.from_number,
           fallback_reason = EXCLUDED.fallback_reason
     RETURNING *`,
    [
      telegramChatId,
      telegramMessageId,
      driverPhone,
      smsBody,
      leadName,
      pageId,
      ruleLabel,
      ringcentralMessageId,
      sourceType,
      recruiterId,
      fromNumber,
      fallbackReason,
    ]
  );
  return res.rows[0];
}

async function getFacebookLeadSmsMirror(telegramChatId, telegramMessageId) {
  const chatId = Number(telegramChatId);
  const messageId = Number(telegramMessageId);
  if (!Number.isFinite(chatId) || !Number.isFinite(messageId)) return null;

  const res = await query(
    `SELECT *
       FROM facebook_lead_sms_mirrors
      WHERE telegram_chat_id = $1
        AND telegram_message_id = $2
      LIMIT 1`,
    [chatId, messageId]
  );
  return res.rows[0] || null;
}

/**
 * One candidate's whole conversation, newest first.
 *
 * The mirror ledger has been queried by (chat, message) since it was written —
 * the reply relay looking up the single message being answered. Nothing had
 * ever asked for the THREAD, because nothing had ever needed to read a
 * conversation as a conversation. The after-hours reply does.
 *
 * Rows are returned newest first so the LIMIT keeps the recent end; the caller
 * (lib/recruiting/thread.js) restores chronological order. Taking the oldest N
 * would hand a model the opening template and none of the answers.
 */
async function listSmsMirrorsByPhone(driverPhone, { limit = 30 } = {}) {
  const phone = String(driverPhone || '').trim();
  if (!phone) return [];
  const capped = Math.min(Math.max(Number(limit) || 30, 1), 200);
  const res = await query(
    `SELECT *
       FROM facebook_lead_sms_mirrors
      WHERE driver_phone = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [phone, capped]
  );
  return res.rows;
}

module.exports = {
  insertFacebookLeadSmsMirror,
  getFacebookLeadSmsMirror,
  listSmsMirrorsByPhone,
};
