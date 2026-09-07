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
       from_number
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (telegram_chat_id, telegram_message_id) DO UPDATE
       SET driver_phone = EXCLUDED.driver_phone,
           sms_body = EXCLUDED.sms_body,
           lead_name = EXCLUDED.lead_name,
           page_id = EXCLUDED.page_id,
           rule_label = EXCLUDED.rule_label,
           ringcentral_message_id = EXCLUDED.ringcentral_message_id,
           source_type = EXCLUDED.source_type,
           recruiter_id = EXCLUDED.recruiter_id,
           from_number = EXCLUDED.from_number
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

module.exports = {
  insertFacebookLeadSmsMirror,
  getFacebookLeadSmsMirror,
};
