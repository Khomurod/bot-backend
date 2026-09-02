/**
 * The Telegram bonus CARD: sending it, resending it, and taking it back.
 *
 * `mileage_bonus_notifications` is UNIQUE on (driver_normalized_name,
 * threshold_miles), so a milestone is announced at most once however many times
 * a run repeats — and a successful send is never turned back into a retry
 * (APP_BRIEF §7). Accounting acts on these cards, so a duplicate is a duplicate
 * payment conversation.
 *
 * Split out of services/mileageBonusService.js, which re-exports the actions.
 */
const mb = require('../../database/mileageBonus');
const { bot } = require('../../bot/bot');
const { safeSend } = require('../telegramHtml');
const { buildBonusCardText } = require('../mileageBonusMessages');
const messageGroups = require('../../database/messageRoutingSettings');
const { serviceError, retryDelayMinutes } = require('./runHelpers');
const { BONUS_STATUS, isAccountingUser, isAccountingUsername } = require('../mileageBonusConstants');

function buildKeyboard(notificationId) {
  return {
    inline_keyboard: [[
      { text: '✅ Paid', callback_data: `mbonus:paid:${notificationId}` },
      { text: '❌ Rejected in Pay', callback_data: `mbonus:rej:${notificationId}` },
    ]],
  };
}

/**
 * Send one milestone bonus card. Claims the (driver, tier) row first (the
 * unique constraint guarantees a single business record). Failed delivery is
 * retained and made retryable without deleting the audit record.
 */
async function sendBonusNotification(driver, tier, { trigger, periodEndDate, chatId }) {
  if (!(await mb.isDriverActive(driver.normalizedName))) {
    return { skipped: true, reason: 'driver_inactive' };
  }
  const claimed = await mb.claimBonusNotification({
    driver_external_id: driver.externalId,
    driver_normalized_name: driver.normalizedName,
    driver_name: driver.name,
    threshold_miles: tier.miles,
    bonus_amount: tier.amount,
    miles_at_notification: driver.totalMiles,
    period_start: driver.periodStartIso,
    period_end: periodEndDate,
    trigger,
  });
  if (!claimed) return { skipped: true };

  const text = buildBonusCardText({
    driver_name: driver.name,
    threshold_miles: tier.miles,
    bonus_amount: tier.amount,
    miles_at_notification: driver.totalMiles,
    period_start: driver.periodStartIso,
    period_end: periodEndDate,
  });

  try {
    const sent = await safeSend(() => bot.telegram.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      reply_markup: buildKeyboard(claimed.id),
    }));
    await mb.setBonusNotificationMessage(claimed.id, chatId, sent?.message_id || null);
    return { sent: true, id: claimed.id };
  } catch (err) {
    // Preserve the business-key claim. A later run can reclaim a known failed
    // delivery without creating a second notification row.
    await mb.markBonusNotificationDeliveryFailed(claimed.id, err.message).catch(() => {});
    throw err;
  }
}

async function removeTelegramCard(record) {
  if (record?.telegram_deleted_at) {
    return { deleted: true, missing: true, buttonsRemoved: false, error: null };
  }
  if (!record?.telegram_chat_id
      || (!record?.telegram_message_id && !record?.telegram_followup_message_id)) {
    return { deleted: true, missing: true, buttonsRemoved: false, error: null };
  }
  const messageIds = [record.telegram_message_id, record.telegram_followup_message_id].filter(Boolean);
  const errors = [];
  let buttonsRemoved = false;
  let deletedCount = 0;
  for (const messageId of messageIds) {
    try {
      await bot.telegram.deleteMessage(record.telegram_chat_id, messageId);
      deletedCount += 1;
    } catch (deleteErr) {
      if (String(messageId) === String(record.telegram_message_id)) {
        try {
          await bot.telegram.editMessageReplyMarkup(
            record.telegram_chat_id,
            messageId,
            undefined,
            { inline_keyboard: [] }
          );
          buttonsRemoved = true;
          errors.push(`Telegram could not delete message ${messageId}: ${deleteErr.message}`);
          continue;
        } catch (editErr) {
          errors.push(
            `Telegram delete failed for ${messageId}: ${deleteErr.message}; `
            + `button removal failed: ${editErr.message}`
          );
          continue;
        }
      }
      errors.push(`Telegram could not delete follow-up ${messageId}: ${deleteErr.message}`);
    }
  }
  return {
    deleted: deletedCount === messageIds.length,
    missing: false,
    buttonsRemoved,
    error: errors.length ? errors.join(' | ') : null,
  };
}

async function resendBonusNotification(notificationId, { username } = {}) {
  const existing = await mb.getBonusNotificationById(notificationId);
  if (!existing) throw serviceError('NOT_FOUND', 'Bonus notification not found.', 404);
  if (existing.status === 'paid') {
    throw serviceError('ALREADY_PAID', 'Paid bonuses cannot be resent.', 409);
  }
  if (!(await mb.isDriverActive(existing.driver_normalized_name))) {
    throw serviceError('DRIVER_INACTIVE', 'Activate this driver before resending a bonus.', 409);
  }

  const chatId = await messageGroups.getGroupId('mileageBonus');
  if (!chatId) {
    throw serviceError('NO_GROUP', messageGroups.missingGroupMessage('mileageBonus'), 409);
  }

  const claimed = await mb.claimNotificationAction(notificationId, 'resending');
  if (!claimed) throw serviceError('ACTION_BUSY', 'This notification is already being updated.', 409);

  let sent = null;
  try {
    const text = buildBonusCardText(claimed);
    sent = await safeSend(() => bot.telegram.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      reply_markup: buildKeyboard(claimed.id),
    }));
    const updated = await mb.finalizeNotificationResend(claimed.id, {
      chatId,
      messageId: sent.message_id,
      username,
    });
    if (!updated) throw new Error('Could not finalize the resent notification.');

    const cleanup = await removeTelegramCard(claimed);
    if (cleanup.error) {
      await mb.releaseNotificationAction(claimed.id, cleanup.error).catch(() => {});
    }
    return { notification: updated, cleanup };
  } catch (err) {
    if (sent?.message_id) {
      await bot.telegram.deleteMessage(chatId, sent.message_id).catch(() => {});
    }
    await mb.releaseNotificationAction(claimed.id, err.message).catch(() => {});
    throw err;
  }
}

async function disregardBonusNotification(notificationId, { username } = {}) {
  const existing = await mb.getBonusNotificationById(notificationId);
  if (!existing) throw serviceError('NOT_FOUND', 'Bonus notification not found.', 404);
  if (existing.status === 'paid') {
    throw serviceError('ALREADY_PAID', 'Paid bonuses cannot be disregarded.', 409);
  }
  if (existing.status === 'disregarded') {
    return { notification: existing, cleanup: { deleted: Boolean(existing.telegram_deleted_at) } };
  }

  const claimed = await mb.claimNotificationAction(notificationId, 'disregarding');
  if (!claimed) throw serviceError('ACTION_BUSY', 'This notification is already being updated.', 409);
  const disregarded = await mb.markNotificationDisregarded(notificationId, username);
  if (!disregarded) {
    await mb.releaseNotificationAction(notificationId, 'Could not mark notification disregarded.');
    throw new Error('Could not mark notification disregarded.');
  }

  const cleanup = await removeTelegramCard(disregarded);
  const updated = await mb.completeNotificationCleanup(notificationId, cleanup);
  return { notification: updated || disregarded, cleanup };
}

module.exports = {
  sendBonusNotification,
  removeTelegramCard,
  resendBonusNotification,
  disregardBonusNotification,
};
