'use strict';

/**
 * What ONE Facebook lead event means: post it, file it in the CRM, record it,
 * and text the driver from the right number.
 *
 * Order is deliberate and each step is independent of the ones after it:
 *
 *   1. Telegram post          the recruiting team sees every lead, always. This
 *                             happens first and nothing below can prevent it.
 *   2. Bitrix24 record        best-effort; a CRM outage must never cost a lead.
 *   3. `leads` row            best-effort bookkeeping for the admin Leads tab.
 *   4. auto-SMS               from the recruiter Bitrix assigned the lead to
 *                             (services/facebookLeadSmsSender), or the shared
 *                             number when that cannot be resolved. That same
 *                             recruiter also picks the WORDS when they have
 *                             their own template, and signs `{rep_name}`.
 *   5. mirror + notice        so a reply typed in Telegram reaches the driver
 *                             FROM THE SAME NUMBER that first texted them.
 *
 * Telegram is passed in rather than held here: the queue worker
 * (services/facebookWebhookService) owns that client, and this module stays a
 * plain orchestration function that a test can drive with a fake.
 *
 * Split out of services/facebookWebhookService.js, which still owns the durable
 * queue that calls this.
 */
const db = require('../database/db');
const { decryptText } = require('../lib/security/facebookCrypto');
const { sendAutoMessageSentNotice } = require('./facebookLeadSmsMirrorService');
const { safeSend } = require('./telegramHtml');
const { fetchLeadById } = require('./facebookGraphService');
const { buildLeadFieldMap, formatLeadMessage } = require('./facebookLeadFormatter');
const { resolveLeadSmsRecruiter, sendResolvedLeadSms } = require('./facebookLeadSmsSender');
const {
  loadAutoMessageConfig,
  resolveAutoSmsForLead,
  LEGACY_HARDCODED_TEMPLATE,
} = require('./facebookLeadAutoMessageService');
const {
  buildTemplateContext,
  renderLeadSmsTemplate,
} = require('./facebookLeadSmsTemplate');
const { createCrmRecordFromLead } = require('./bitrix24Service');

/**
 * The line posted to the group when the auto-SMS did NOT go out. Returns null
 * on success — success is announced by the mirror notice instead, which is the
 * message a reply can be threaded onto.
 *
 * `ruleLabel` is accepted (every caller has it) but deliberately not rendered:
 * the wording here is what the recruiting team reads on every skipped lead, and
 * it is asserted verbatim by tests/facebookWebhookService.test.js.
 */
function buildAutoMessageNotification(fieldMap, smsResult, leadName, ruleLabel = null) {
  const name = leadName || 'lead';
  const phone = fieldMap.phone_number || fieldMap.phone || '';
  if (!phone) {
    return 'AutoMessage skipped: no phone on lead.';
  }
  if (smsResult.reason === 'disabled') {
    return `AutoMessage skipped for ${name}: auto-SMS is disabled in admin.`;
  }
  if (smsResult.ok) {
    return null;
  }
  if (smsResult.reason === 'not_configured') {
    return `AutoMessage skipped for ${phone} (RingCentral not configured).`;
  }
  if (smsResult.reason === 'already_sent') {
    // A re-driven event, not a failure: this lead had its text the first time
    // round. Saying "failed" here would send an operator looking for a problem
    // that is actually the duplicate guard doing its job.
    return `AutoMessage skipped for ${phone}: this lead was already texted.`;
  }
  const detail = smsResult.detail ? `: ${smsResult.detail}` : '';
  return `AutoMessage failed for ${phone}${detail}`;
}

/** Create the Bitrix record, swallowing every failure. Returns null if it blew up. */
async function createBitrixRecord({ fieldMap, leadData, connection, leadgenId, payload }) {
  try {
    const formId = String(payload.value?.form_id || payload.value?.formId || '');
    const result = await createCrmRecordFromLead({
      fieldMap,
      leadData,
      connection,
      leadgenId,
      formId,
    });
    if (!result.ok && result.reason !== 'not_configured') {
      console.error('[Bitrix24] Lead sync failed:', result.error || result.reason);
    }
    return result;
  } catch (bitrixErr) {
    console.error('[Bitrix24] Lead sync error:', bitrixErr.message);
    return null;
  }
}

/** File the lead for the admin Leads tab. Returns its id, or null. */
async function recordLead({ leadgenId, fullName, fieldMap, phone, connection, pageId, bitrixResult }) {
  try {
    let bitrixStatus = 'skipped';
    if (bitrixResult?.ok) bitrixStatus = 'created';
    else if (bitrixResult?.reason === 'not_configured') bitrixStatus = 'disabled';
    else if (bitrixResult) bitrixStatus = 'failed';
    const recorded = await db.createLeadIfNew({
      source: 'facebook',
      externalId: leadgenId,
      fullName,
      email: fieldMap.email || null,
      phone: phone || null,
      jobTitle: fieldMap.job_title || null,
      message: fieldMap.message || null,
      raw: { page_name: connection.page_name, page_id: pageId },
    });
    if (recorded) {
      await db.updateLeadBitrixResult(recorded.id, {
        bitrixId: bitrixResult?.bitrixId || null,
        status: bitrixStatus,
      });
      return recorded.id;
    }
    // The insert conflicted, so this lead already has a row — a re-delivered or
    // replayed event. Its id still matters: `sms_from_number` is written
    // against it, and that column is what stops the lead being texted twice.
    // Returning null here meant a send on a REPLAY recorded nothing, so the
    // guard saw an unsent lead on the next pass and texted again, forever.
    const existing = await db.getLeadBySourceExternalId('facebook', leadgenId);
    return existing?.id ?? null;
  } catch (recordErr) {
    console.error('[Leads] Failed to record Facebook lead:', recordErr.message);
  }
  return null;
}

/**
 * Has this lead already been texted?
 *
 * `leads.sms_from_number` is written only after a send actually left
 * RingCentral, so a row that has one has had its text — and must never get a
 * second one. Every path that can re-run a finished event goes through here:
 *
 *   · the admin "retry" button and the internal / Python retry endpoints, none
 *     of which check whether the event already completed;
 *   · the at-least-once window at startup, where an event killed AFTER the send
 *     and BEFORE `completeFacebookWebhookEvent` is re-claimed;
 *   · any future throw between the send and the end of the event.
 *
 * That also makes every lead processed before this feature immune: they all
 * carry the shared company number here, so none of them can be re-texted from
 * a recruiter's line.
 *
 * A lookup failure means "cannot prove it was sent", and the guard opens: a
 * database hiccup must not cost a genuinely new lead its only text.
 */
async function alreadyTexted(leadgenId) {
  if (!leadgenId) return null;
  try {
    const existing = await db.getLeadBySourceExternalId('facebook', leadgenId);
    return existing?.sms_from_number ? existing : null;
  } catch (err) {
    console.warn('[Leads] Could not check whether this lead was already texted:', err.message);
    return null;
  }
}

/**
 * Render and send the lead's auto-SMS.
 * @returns {Promise<{smsResult:object, smsBody:string|null, ruleLabel:string|null,
 *   sender:object|null}>}
 */
async function sendAutoSms({ phone, fieldMap, connection, bitrixResult, leadgenId = null }) {
  if (!phone) {
    return { smsResult: { ok: false, reason: 'no_phone' }, smsBody: null, ruleLabel: null, sender: null };
  }

  const texted = await alreadyTexted(leadgenId);
  if (texted) {
    console.log(
      `[Leads] Lead ${leadgenId} was already texted from ${texted.sms_from_number} `
      + '— not sending again.'
    );
    return {
      smsResult: { ok: false, reason: 'already_sent' },
      smsBody: null,
      ruleLabel: null,
      sender: null,
    };
  }

  // THE MASTER SWITCH COMES FIRST, before anything expensive. Resolving the
  // Bitrix assignee can wait out the full BITRIX24_ASSIGNEE_WAIT_MS budget
  // (25s by default) on an unassigned lead, and the webhook queue drains
  // sequentially — so spending it on a deployment that sends no auto-SMS at
  // all would delay every later event behind it for nothing.
  const autoMessageConfig = await loadAutoMessageConfig();
  if (autoMessageConfig.settings && autoMessageConfig.settings.is_enabled === false) {
    return { smsResult: { ok: false, reason: 'disabled' }, smsBody: null, ruleLabel: null, sender: null };
  }

  // WHO NEXT, THEN WHAT. The assigned recruiter decides both the number the
  // text leaves from and — when they have written one — the words in it, so the
  // Bitrix assignee is resolved BEFORE the template is picked. Resolving here
  // rather than inside the send also keeps it to one bounded Bitrix poll.
  const resolvedSender = await resolveLeadSmsRecruiter({
    bitrixId: bitrixResult?.ok ? bitrixResult.bitrixId : null,
    entity: bitrixResult?.entity,
  });

  const resolved = await resolveAutoSmsForLead({
    fieldMap,
    pageName: connection.page_name,
    recruiter: resolvedSender.recruiter,
    config: autoMessageConfig,
  });
  if (!resolved.isEnabled) {
    return { smsResult: { ok: false, reason: 'disabled' }, smsBody: null, ruleLabel: resolved.ruleLabel, sender: null };
  }

  const template = resolved.template || LEGACY_HARDCODED_TEMPLATE;
  const context = buildTemplateContext({
    fieldMap,
    settings: resolved.settings,
    pageName: connection.page_name,
    // `{rep_name}` is the recruiter who will actually be texting; it falls back
    // to the settings rep name when the lead goes out on the shared number.
    repName: resolved.repName,
  });
  const smsBody = renderLeadSmsTemplate(template, context);
  const sender = await sendResolvedLeadSms({
    phone,
    message: smsBody,
    resolved: resolvedSender,
  });

  return { smsResult: sender.smsResult, smsBody, ruleLabel: resolved.ruleLabel, sender };
}

async function processLeadEvent(eventRow, { telegram }) {
  const sendTelegramMessage = (chatId, text) => safeSend(() => telegram.sendMessage(chatId, text));

  const pageId = String(eventRow.page_id);
  const payload = eventRow.payload || {};
  const leadgenId = String(payload.leadgenId || '');
  if (!leadgenId) {
    throw new Error('Leadgen payload is missing leadgenId');
  }

  const connection = await db.getFacebookPageConnectionByPageId(pageId);
  if (!connection) {
    throw new Error(`No active Facebook Page connection found for page ${pageId}`);
  }

  const pageAccessToken = decryptText(connection.access_token_encrypted);
  const leadData = await fetchLeadById({ leadgenId, pageAccessToken });
  const fieldMap = buildLeadFieldMap(leadData);
  const fullName = fieldMap.full_name || fieldMap.first_name || 'Driver';
  const phone = fieldMap.phone_number || fieldMap.phone || '';

  await sendTelegramMessage(connection.telegram_group_id, formatLeadMessage(leadData));

  const bitrixResult = await createBitrixRecord({ fieldMap, leadData, connection, leadgenId, payload });
  const leadId = await recordLead({
    leadgenId, fullName, fieldMap, phone, connection, pageId, bitrixResult,
  });

  const { smsResult, smsBody, ruleLabel, sender } = await sendAutoSms({
    phone, fieldMap, connection, bitrixResult, leadgenId,
  });

  // Who ended up texting the driver — visible in the admin Leads tab. Pure
  // bookkeeping: it is written after the send and never allowed to fail a lead.
  if (leadId && sender) {
    try {
      await db.updateLeadSmsSender(leadId, {
        assignedById: sender.assignedById,
        fromNumber: sender.fromNumber,
        recruiterId: sender.recruiterId,
      });
    } catch (err) {
      // NOT a warning. `sms_from_number` is the marker the duplicate guard
      // reads, so failing to write it means the next retry of this event will
      // text the driver a second time. Nothing here can undo the send that
      // already happened; the point is that it is loud enough to notice.
      console.error(
        `[Leads] Could not record the SMS sender for lead ${leadId} — `
        + `a retry of this event WILL text ${sender.fromNumber ? 'them' : 'the driver'} again: `
        + err.message
      );
    }
  }

  if (smsResult.ok && smsBody) {
    try {
      await sendAutoMessageSentNotice(telegram, connection.telegram_group_id, {
        phone,
        smsBody,
        leadName: fullName,
        pageId,
        ruleLabel,
        ringcentralMessageId: smsResult.messageId,
        recruiterId: sender?.recruiterId || null,
        recruiterName: sender?.recruiter?.name || null,
        fromNumber: sender?.fromNumber || null,
        senderNote: sender?.fallbackNote || null,
        fallbackReason: sender?.fallbackReason || null,
      });
    } catch (noticeErr) {
      console.error('[FacebookWebhook] Auto-message notice failed:', noticeErr.message);
    }
    return;
  }

  const autoMessageNotice = buildAutoMessageNotification(fieldMap, smsResult, fullName, ruleLabel);
  if (autoMessageNotice) {
    const withSender = sender?.fallbackNote
      ? `${autoMessageNotice}\n⚠️ ${sender.fallbackNote}`
      : autoMessageNotice;
    await sendTelegramMessage(connection.telegram_group_id, withSender);
  }
}

module.exports = {
  processLeadEvent,
  buildAutoMessageNotification,
};
