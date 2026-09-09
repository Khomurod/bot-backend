/**
 * Draining the alert outbox to Telegram.
 *
 * The same durable shape as `database/homeTimeInternalAlertOutbox.js`, and it
 * exists in that shape because of what happened to that one: a chat id saved
 * with its minus sign dropped, 101 alerts failed against it, every one spent
 * its full attempt budget, and nothing ever told a human. Two lessons are
 * built in here — the destination is validated before it can be saved (see the
 * routes), and exhaustion is COUNTED and surfaced rather than merely recorded.
 */
const findingsStore = require('../../../database/aiPolicyFindings');
const { cleanTelegramError } = require('../../../lib/telegram/telegramErrors');

const BATCH = 5;

/**
 * @param {object} args
 * @param {object} args.telegram  a Telegraf-style client, or null
 * @returns {Promise<{sent: number, failed: number, skipped?: string}>}
 */
async function drainPolicyAlerts({ telegram } = {}) {
  if (!telegram || typeof telegram.sendMessage !== 'function') {
    return { sent: 0, failed: 0, skipped: 'no Telegram client' };
  }
  const due = await findingsStore.claimDueAlerts(BATCH);
  let sent = 0;
  let failed = 0;

  for (const alert of due) {
    try {
      await telegram.sendMessage(alert.chat_id, alert.body, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      await findingsStore.markAlertSent(alert.id);
      sent += 1;
    } catch (err) {
      // cleanTelegramError strips the bot token out of the message — a raw
      // Telegram error can echo the request URL, and that URL contains the
      // token. It must never reach a database column or a log line.
      const message = cleanTelegramError(err);
      await findingsStore.markAlertFailed(alert.id, message);
      failed += 1;
      console.warn(`[POLICY-ALERT] Delivery failed for finding ${alert.finding_id}: ${message}`);
    }
  }
  return { sent, failed };
}

module.exports = { drainPolicyAlerts, BATCH };
