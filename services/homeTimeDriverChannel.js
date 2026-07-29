/**
 * Home-Time driver-group channel — the SINGLE choke point for everything the
 * bot says to a DRIVER group.
 *
 * The Home-Time feature can run in "silent mode": it keeps reading, classifying
 * and recording driver-group messages exactly as before, but says nothing to the
 * driver. Staff are alerted internally instead (services/homeTimeInternalAlert).
 *
 * The switch is home_time_settings.driver_clarification_enabled (default TRUE,
 * so existing behaviour is preserved). It is deliberately SEPARATE from the
 * overall `enabled` switch, which still gates the whole feature.
 *
 * Every driver-group send in the Home-Time workflow — clarification questions,
 * follow-up asks, reminders, policy acknowledgments, policy warnings and 👍
 * reactions — routes through this module. Because there is exactly one choke
 * point, no send site can leak while silent mode is on, and adding a new send
 * site later cannot accidentally bypass the switch.
 *
 * NOT gated by this module, on purpose:
 *   - the completed approval card, which goes to completed_notify_group_id (a
 *     staff chat that was never the driver's group);
 *   - the internal clarification alert itself.
 */
const { safeSend } = require('./telegramHtml');

/**
 * May the bot message driver groups right now?
 *
 * Defaults to TRUE when the column or the whole settings row is missing, so a
 * pre-migration database or a failed settings read never silently mutes the bot.
 *
 * @param {object|null} settings home_time_settings row
 */
function isDriverMessagingEnabled(settings) {
  if (!settings) return true;
  const value = settings.driver_clarification_enabled;
  if (value === undefined || value === null) return true;
  return Boolean(value);
}

/**
 * Which channel a request's clarification is being handled through, for the
 * `clarification_channel` column and the admin panel's status label.
 *
 * @returns {'driver'|'internal'}
 */
function clarificationChannelFor(settings) {
  return isDriverMessagingEnabled(settings) ? 'driver' : 'internal';
}

/**
 * Send a message to a driver group, replying to `replyToMessageId` when given.
 * Uses Telegram's "allow sending without reply" so a deleted root message never
 * drops the reply.
 *
 * Returns null WITHOUT calling Telegram when driver messaging is off.
 *
 * @returns {Promise<object|null>} the sent message, or null when suppressed
 */
async function sendToDriverGroup(telegram, chatId, text, {
  replyToMessageId = null, extra = {}, settings = null, reason = 'message',
} = {}) {
  if (!isDriverMessagingEnabled(settings)) {
    console.log(`[HOME-TIME-CHANNEL] Suppressed driver-group ${reason} to ${chatId} `
      + '(driver clarification messaging is disabled).');
    return null;
  }
  if (!telegram || !chatId || !text) return null;
  const options = { disable_web_page_preview: true, ...extra };
  if (replyToMessageId) {
    options.reply_to_message_id = Number(replyToMessageId);
    options.allow_sending_without_reply = true;
  }
  return safeSend(() => telegram.sendMessage(chatId, text, options));
}

/**
 * React 👍 to a driver's message. Non-fatal (older API / bot is not an admin),
 * and fully suppressed when driver messaging is off — a reaction is still a
 * visible reply to the driver.
 */
async function reactToDriverMessage(telegram, chatId, messageId, {
  settings = null, emoji = '👍',
} = {}) {
  if (!isDriverMessagingEnabled(settings)) {
    console.log(`[HOME-TIME-CHANNEL] Suppressed driver-group reaction in ${chatId} `
      + '(driver clarification messaging is disabled).');
    return null;
  }
  if (!telegram || !chatId || !messageId) return null;
  try {
    const reaction = [{ type: 'emoji', emoji }];
    if (typeof telegram.setMessageReaction === 'function') {
      return await telegram.setMessageReaction(chatId, messageId, reaction);
    }
    if (typeof telegram.callApi === 'function') {
      return await telegram.callApi('setMessageReaction', {
        chat_id: chatId, message_id: messageId, reaction,
      });
    }
  } catch (err) {
    console.warn('[HOME-TIME-CHANNEL] Could not set reaction (non-fatal):', err.message);
  }
  return null;
}

/**
 * When may a clarification schedule a reminder? Only when the bot is allowed to
 * message the driver — a reminder scheduled during silent mode would be a
 * message with nowhere legitimate to go, and would fire the moment the setting
 * flipped back on. Callers pass the result straight into `nextReminderAt`.
 *
 * @returns {string|null} the ISO timestamp, or null to schedule nothing
 */
function reminderTimeIfAllowed(settings, isoTimestamp) {
  return isDriverMessagingEnabled(settings) ? isoTimestamp : null;
}

module.exports = {
  isDriverMessagingEnabled,
  clarificationChannelFor,
  sendToDriverGroup,
  reactToDriverMessage,
  reminderTimeIfAllowed,
};
