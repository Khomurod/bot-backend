/**
 * Admin → Settings → AI & Operations notifications.
 *
 * One screen that answers "where do Wenze's alerts go?", which until now could
 * only be answered by reading the source: five features had five destinations
 * spread across three tables and the environment.
 *
 * Every chat id is validated by `services/telegramChatIdCheck.js` before it can
 * be stored. That check exists because a dropped minus sign once turned
 * `-5052301861` into `5052301861` and silently discarded 101 staff alerts over
 * several months. A screen whose entire job is to make notices reach people is
 * the last place that should be allowed to be configured to reach nobody.
 *
 * `allowPrivate` is on: a small operation may want these in one administrator's
 * direct messages rather than a room. The sign-flip check still runs FIRST, so
 * a dropped minus cannot hide behind a user id that happens to resolve.
 */
const express = require('express');

const store = require('../../../database/operationalNotificationSettings');
const notifications = require('../../../database/operationalNotifications');
const { getGroupByTelegramId } = require('../../../database/groups');
const { checkChatIdColumns } = require('../../../services/telegramChatIdCheck');
const { CATEGORIES } = require('../../../lib/notifications/categories');
const { notificationCandidates } = require('../../../lib/notifications/candidates');
const config = require('../../../config/config');
const { notify } = require('../../../services/notifications/send');
const { sendFailure } = require('../../middleware/failureResponse');

/** Says plainly what will arrive here, so a test is never mistaken for a real alert. */
const TEST_MESSAGE = '🔔 <b>Test from Wenze</b>\n'
  + 'Operational notices will arrive in this chat. Nothing needs doing.';

function createNotificationSettingsRouter({ authMiddleware, telegram = null }) {
  const router = express.Router();

  router.get('/notifications', authMiddleware, async (req, res) => {
    try {
      const [settings, queue] = await Promise.all([
        store.getNotificationSettings({ fresh: true }),
        notifications.summariseNotifications().catch(() => null),
      ]);
      // The catalogue travels with the settings so the screen can describe each
      // category in words rather than showing a row of bare keys.
      //
      // `candidates` are chats this deployment ALREADY sends operational
      // traffic to, offered so that setting a destination does not require
      // anybody to go and find a Telegram chat id. NOTHING IS APPLIED FROM
      // THIS — an administrator picks one and it goes through the same
      // validation as a typed id. Routing safety escalations into the chat
      // that receives survey results is an audience decision, and it is
      // theirs.
      res.json({
        settings,
        categories: CATEGORIES,
        queue,
        candidates: notificationCandidates(config),
        // What the silence has cost so far. "Not configured" is a sentence
        // people scroll past; a number is not.
        discarded: await notifications.summariseDiscards().catch(() => null),
      });
    } catch (err) {
      sendFailure(res, err, {
        message: 'Failed to load the notification settings', logPrefix: '[NOTIFY]',
      });
    }
  });

  router.put('/notifications', authMiddleware, async (req, res) => {
    const patch = req.body || {};
    try {
      // Validate every chat id in this save before writing any of them: a
      // partial save would leave the screen disagreeing with itself.
      // The key a field is checked under is the label an operator READS in the
      // error, because `checkChatIdColumns` builds its sentence as
      // "&lt;column&gt; &lt;reason&gt;". So the keys are the category labels, not the
      // JSON paths: "Fuel risks does not match any known chat" is a sentence;
      // "categoryChatIds.fuel does not match any known chat" is a stack trace.
      const toCheck = {};
      const fieldFor = new Map();
      if (patch.defaultChatId !== undefined) {
        toCheck['The default group'] = patch.defaultChatId;
        fieldFor.set('The default group', 'defaultChatId');
      }
      for (const [key, value] of Object.entries(patch.categoryChatIds || {})) {
        const label = CATEGORIES.find((c) => c.key === key)?.label || key;
        toCheck[label] = value;
        fieldFor.set(label, `categoryChatIds.${key}`);
      }
      const check = await checkChatIdColumns(toCheck, Object.keys(toCheck), {
        getGroupByTelegramId, telegram, allowPrivate: true,
      });
      if (check.error) {
        return res.status(400).json({
          error: check.error,
          field: fieldFor.get(check.column) || check.column,
          suggestion: check.result?.suggestion || null,
        });
      }

      const settings = await store.updateNotificationSettings({
        ...patch, updatedBy: req.admin?.username || null,
      });
      return res.json({ settings });
    } catch (err) {
      // An unknown category key is the operator's mistake, not a server fault.
      if (/Unknown notification category/.test(err.message || '')) {
        return res.status(400).json({ error: err.message });
      }
      return sendFailure(res, err, {
        message: 'Failed to save the notification settings', logPrefix: '[NOTIFY]',
      });
    }
  });

  /**
   * Prove a destination before trusting it with real alerts.
   *
   * Answers 200 with `{ok:false}` on a refusal rather than a 4xx: the REQUEST
   * succeeded, the thing being tested failed. The same shape the Samsara and
   * policy-watcher tests use.
   */
  router.post('/notifications/test', authMiddleware, async (req, res) => {
    const chatId = String(req.body?.chatId ?? '').trim();
    try {
      const target = chatId || (await store.getNotificationSettings({ fresh: true })).defaultChatId;
      if (!target) {
        return res.json({ ok: false, error: 'No chat id to test — set a default group first.' });
      }
      const client = telegram || require('../../../bot/bot').bot?.telegram; // eslint-disable-line global-require
      if (!client) return res.json({ ok: false, error: 'The bot is not connected right now.' });
      await client.sendMessage(target, TEST_MESSAGE, { parse_mode: 'HTML' });
      return res.json({ ok: true, chatId: target });
    } catch (err) {
      return res.json({ ok: false, error: err.message });
    }
  });

  /**
   * Send one real notice of a chosen category, so an operator can see where it
   * lands and what it looks like before a live incident does it for them.
   */
  router.post('/notifications/preview', authMiddleware, async (req, res) => {
    const category = String(req.body?.category ?? '').trim();
    try {
      const out = await notify({
        category,
        title: 'Example notice',
        lines: ['This is what a real one looks like.'],
        action: 'Nothing — this was sent from Settings.',
        subjectType: 'preview',
        subjectId: req.admin?.username || 'admin',
        // A fresh discriminator each time, or the dedup guarantee would let a
        // person preview a category exactly once, ever.
        discriminator: String(Date.now()),
      });
      return res.json(out);
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to send the preview', logPrefix: '[NOTIFY]' });
    }
  });

  return router;
}

module.exports = { createNotificationSettingsRouter, TEST_MESSAGE };
