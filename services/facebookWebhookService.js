const db = require('../database/db');
const { decryptText } = require('./facebookCrypto');
const { safeSend } = require('./telegramHtml');
const {
  fetchLeadById,
  fetchSenderProfile,
} = require('./facebookGraphService');
const {
  buildLeadFieldMap,
  formatLeadMessage,
  formatMessengerMessage,
} = require('./facebookLeadFormatter');
const { sendSms } = require('./ringCentralSmsService');
const {
  resolveAutoSmsForLead,
  LEGACY_HARDCODED_TEMPLATE,
} = require('./facebookLeadAutoMessageService');
const {
  buildTemplateContext,
  renderLeadSmsTemplate,
} = require('./facebookLeadSmsTemplate');

let telegramClient = null;
let workerInterval = null;
let drainInProgress = false;
let drainQueued = false;

function configureFacebookLeadTelegram(telegram) {
  telegramClient = telegram;
}

function ensureTelegramConfigured() {
  if (!telegramClient) {
    throw new Error('Facebook webhook worker has no Telegram client configured');
  }
}

function extractFacebookWebhookEvents(payload) {
  const out = [];
  if (!payload || payload.object !== 'page') return out;

  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change?.field !== 'leadgen') continue;
      const value = change?.value || {};
      if (!value.leadgen_id) continue;
      const pageId = String(value.page_id || entry.id || '');
      if (!pageId) continue;
      out.push({
        eventKey: `leadgen:${pageId}:${value.leadgen_id}`,
        pageId,
        eventType: 'leadgen',
        payload: {
          pageId,
          leadgenId: String(value.leadgen_id),
          value,
          entryId: entry.id || null,
        },
      });
    }

    for (const event of entry.messaging || []) {
      const pageId = String(entry.id || event?.recipient?.id || '');
      if (!pageId) continue;
      const senderId = String(event?.sender?.id || 'unknown');
      const mid = event?.message?.mid || event?.delivery?.mids?.[0] || event?.read?.watermark || '';
      const timestamp = event?.timestamp || Date.now();
      out.push({
        eventKey: `messaging:${pageId}:${mid || `${senderId}:${timestamp}`}`,
        pageId,
        eventType: 'messaging',
        payload: {
          pageId,
          event,
        },
      });
    }
  }

  return out;
}

function getRetryDelayMs(attemptCount) {
  const cappedAttempt = Math.max(1, Math.min(8, Number(attemptCount) || 1));
  return Math.min(30_000 * (2 ** (cappedAttempt - 1)), 15 * 60 * 1000);
}

async function sendTelegramMessage(chatId, text) {
  ensureTelegramConfigured();
  return safeSend(() => telegramClient.sendMessage(chatId, text));
}

function buildAutoMessageNotification(fieldMap, smsResult, leadName, ruleLabel = null) {
  const name = leadName || 'lead';
  const phone = fieldMap.phone_number || fieldMap.phone || '';
  const ruleSuffix = ruleLabel ? ` (${ruleLabel})` : '';
  if (!phone) {
    return 'AutoMessage skipped: no phone on lead.';
  }
  if (smsResult.reason === 'disabled') {
    return `AutoMessage skipped for ${name}: auto-SMS is disabled in admin.`;
  }
  if (smsResult.ok) {
    return `AutoMessage sent via SMS to ${phone} for lead ${name}${ruleSuffix}.`;
  }
  if (smsResult.reason === 'not_configured') {
    return `AutoMessage skipped for ${phone} (RingCentral not configured).`;
  }
  const detail = smsResult.detail ? `: ${smsResult.detail}` : '';
  return `AutoMessage failed for ${phone}${detail}`;
}

async function processLeadEvent(eventRow) {
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

  let smsResult = { ok: false, reason: phone ? 'skipped' : 'no_phone' };
  let ruleLabel = null;
  if (phone) {
    const resolved = await resolveAutoSmsForLead({
      fieldMap,
      pageName: connection.page_name,
    });
    ruleLabel = resolved.ruleLabel;
    if (!resolved.isEnabled) {
      smsResult = { ok: false, reason: 'disabled' };
    } else {
      const template = resolved.template || LEGACY_HARDCODED_TEMPLATE;
      const context = buildTemplateContext({
        fieldMap,
        settings: resolved.settings,
        pageName: connection.page_name,
      });
      const body = renderLeadSmsTemplate(template, context);
      smsResult = await sendSms(phone, body);
    }
  }

  const autoMessageNotice = buildAutoMessageNotification(fieldMap, smsResult, fullName, ruleLabel);
  await sendTelegramMessage(connection.telegram_group_id, autoMessageNotice);
}

function buildMessengerText(event) {
  const message = event?.message || {};
  let messageText = message?.text || '';
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  if (attachments.length) {
    const types = attachments.map((attachment) => attachment?.type || 'unknown').join(', ');
    messageText = messageText
      ? `${messageText}\n[Attachments: ${types}]`
      : `[Attachments: ${types}]`;
  }
  return messageText || '(no text)';
}

async function processMessagingEvent(eventRow) {
  const pageId = String(eventRow.page_id);
  const event = eventRow.payload?.event || {};
  const message = event?.message || {};

  if (message?.is_echo) return;
  if (event?.delivery || event?.read) return;

  const senderId = String(event?.sender?.id || '');
  if (!senderId) return;

  const alreadySeen = await db.hasFacebookSenderBeenSeen(pageId, senderId);
  if (alreadySeen) return;

  const connection = await db.getFacebookPageConnectionByPageId(pageId);
  if (!connection) {
    throw new Error(`No active Facebook Page connection found for page ${pageId}`);
  }

  const pageAccessToken = decryptText(connection.access_token_encrypted);
  const senderProfile = await fetchSenderProfile({ senderId, pageAccessToken });
  const telegramMessage = formatMessengerMessage(
    senderProfile,
    buildMessengerText(event),
    senderId
  );

  await sendTelegramMessage(connection.telegram_group_id, telegramMessage);
  await db.recordFacebookSenderSeen(pageId, senderId, eventRow.event_key);
}

async function processFacebookWebhookEvent(eventRow) {
  if (eventRow.event_type === 'leadgen') {
    await processLeadEvent(eventRow);
    return;
  }
  if (eventRow.event_type === 'messaging') {
    await processMessagingEvent(eventRow);
    return;
  }
  throw new Error(`Unsupported Facebook webhook event type: ${eventRow.event_type}`);
}

async function drainFacebookWebhookQueue() {
  if (drainInProgress) {
    drainQueued = true;
    return;
  }

  drainInProgress = true;
  try {
    ensureTelegramConfigured();
    while (true) {
      const events = await db.claimPendingFacebookWebhookEvents(10);
      if (!events.length) break;

      for (const eventRow of events) {
        try {
          await processFacebookWebhookEvent(eventRow);
          await db.completeFacebookWebhookEvent(eventRow.id);
        } catch (err) {
          const retryAt = new Date(Date.now() + getRetryDelayMs(eventRow.attempt_count));
          await db.failFacebookWebhookEvent(eventRow.id, err.message, retryAt);
        }
      }
    }
  } finally {
    drainInProgress = false;
    if (drainQueued) {
      drainQueued = false;
      setImmediate(() => {
        void drainFacebookWebhookQueue();
      });
    }
  }
}

async function enqueueVerifiedFacebookPayload(payload) {
  const events = extractFacebookWebhookEvents(payload);
  if (!events.length) {
    return { received: 0, inserted: 0 };
  }

  const inserted = await db.insertFacebookWebhookEvents(events);
  if (inserted.length) {
    setImmediate(() => {
      void drainFacebookWebhookQueue();
    });
  }

  return { received: events.length, inserted: inserted.length };
}

async function retryFacebookWebhookEvent(identifier) {
  const event = await db.resetFacebookWebhookEventByIdentifier(identifier);
  if (event) {
    setImmediate(() => {
      void drainFacebookWebhookQueue();
    });
  }
  return event;
}

async function getFacebookWebhookLog(limit = 50) {
  return db.getRecentFacebookWebhookEvents(limit);
}

function startFacebookWebhookWorker() {
  if (workerInterval) return;
  workerInterval = setInterval(() => {
    void drainFacebookWebhookQueue();
  }, 5000);
  workerInterval.unref?.();
  setImmediate(() => {
    void drainFacebookWebhookQueue();
  });
}

function stopFacebookWebhookWorker() {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
}

module.exports = {
  configureFacebookLeadTelegram,
  startFacebookWebhookWorker,
  stopFacebookWebhookWorker,
  enqueueVerifiedFacebookPayload,
  retryFacebookWebhookEvent,
  getFacebookWebhookLog,
  extractFacebookWebhookEvents,
  buildAutoMessageNotification,
};
