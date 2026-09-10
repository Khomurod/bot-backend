/**
 * Admin → Settings → AI → Terms watcher.
 *
 * The one route that matters most here is the settings PUT, because of what it
 * refuses. The Telegram destination is validated by
 * `services/telegramChatIdCheck.js` before it can be stored — the check Stage 0
 * shipped after a dropped minus sign turned `-5052301861` into `5052301861` and
 * silently discarded 101 home-time alerts for months. This feature exists to
 * tell people things; letting it be configured to tell nobody would be a
 * particularly bad joke.
 */
const express = require('express');

const policyStore = require('../../../database/aiPolicy');
const findingsStore = require('../../../database/aiPolicyFindings');
const { getGroupByTelegramId } = require('../../../database/groups');
const { checkChatIdColumns } = require('../../../services/telegramChatIdCheck');
const { runPolicyCheck } = require('../../../services/ai/policy/policyWatcher');
const { ensureCatalogSources } = require('../../../services/ai/policy/sourceDiscovery');
const { cleanTelegramError } = require('../../../lib/telegram/telegramErrors');
const { sendFailure } = require('../../middleware/failureResponse');

/** Plain words, and it says what will arrive here — so a person can tell the test from a real alert. */
const TEST_MESSAGE = '🔔 This is a test from Wenze\'s AI monitoring.\n\n'
  + 'Alerts about provider terms changes and model changes will arrive here. Nothing needs doing.';

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function createAiPolicyRouter({ authMiddleware, telegram = null }) {
  const router = express.Router();

  router.get('/ai/policy', authMiddleware, async (req, res) => {
    try {
      const [settings, sources, findings, exhausted] = await Promise.all([
        policyStore.getWatcherSettings(),
        policyStore.listSourcesForAdmin(),
        findingsStore.listFindings({ limit: 50 }),
        findingsStore.countExhaustedAlerts(),
      ]);
      res.json({ settings, sources, findings, alerts: { exhausted } });
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to load the policy watcher', logPrefix: '[POLICY]' });
    }
  });

  router.put('/ai/policy', authMiddleware, async (req, res) => {
    const patch = req.body || {};
    try {
      // Before anything is written. A destination that resolves to no known
      // group is rejected with the corrected id as a `suggestion`, and one we
      // cannot disprove still saves, marked unverified — blocking a legitimate
      // chat would be its own outage.
      // `allowPrivate`: AI monitoring may report to one administrator rather than
      // a room. The sign-flip check still runs first, so a dropped minus sign
      // cannot hide behind a resolvable user id.
      const check = await checkChatIdColumns(
        { notifyChatId: patch.notifyChatId },
        ['notifyChatId'],
        { getGroupByTelegramId, telegram, allowPrivate: true }
      );
      if (check.error) {
        return res.status(400).json({
          error: check.error,
          suggestion: check.result?.suggestion ?? null,
        });
      }
      const settings = await policyStore.updateWatcherSettings(patch, req.admin?.username || null);
      if (patch.enabled === true) {
        // Switching the watcher on should not leave it with nothing to watch.
        // Best effort: a seeding failure must not fail the save.
        await ensureCatalogSources().catch((err) => console.warn('[POLICY] seeding sources failed:', err.message));
      }
      return res.json({ settings });
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to save the watcher', logPrefix: '[POLICY]' });
    }
  });

  /**
   * Send a test message to the destination — the configured one, or a candidate
   * from the body so it can be proven before it is saved. 200 with ok:false on a
   * refusal: the request succeeded, and what failed is the thing being tested.
   */
  router.post('/ai/policy/test-notification', authMiddleware, async (req, res) => {
    try {
      if (!telegram || typeof telegram.sendMessage !== 'function') {
        return res.json({ ok: false, error: 'No Telegram client is available to send with.' });
      }
      const candidate = String(req.body?.chatId || '').trim();
      const chatId = candidate || (await policyStore.getWatcherSettings()).notifyChatId;
      if (!chatId) {
        return res.json({ ok: false, error: 'No destination is configured. Enter a chat id first.' });
      }
      try {
        await telegram.sendMessage(String(chatId), TEST_MESSAGE, { disable_web_page_preview: true });
        return res.json({ ok: true, chatId: String(chatId) });
      } catch (err) {
        // cleanTelegramError strips the bot token, which a raw Telegram error can echo.
        return res.json({ ok: false, chatId: String(chatId), error: cleanTelegramError(err) });
      }
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to send the test', logPrefix: '[POLICY]' });
    }
  });

  router.post('/ai/policy/sources', authMiddleware, async (req, res) => {
    const { providerKey, url, kind } = req.body || {};
    if (!providerKey || !url) {
      return res.status(400).json({ error: 'A provider and a URL are both required' });
    }
    if (!/^https:\/\//i.test(String(url))) {
      // Terms fetched over plain HTTP could be rewritten in transit, and this
      // feature can suspend a provider on what it reads.
      return res.status(400).json({ error: 'The URL must be https' });
    }
    try {
      const source = await policyStore.addSource({ providerKey, url: String(url).trim(), kind });
      return res.json({ source });
    } catch (err) {
      if (/violates foreign key/i.test(err.message || '')) {
        return res.status(400).json({ error: `No provider is configured with the key "${providerKey}".` });
      }
      if (/violates check constraint/i.test(err.message || '')) {
        return res.status(400).json({ error: `That is not a page kind this watcher knows: ${kind}` });
      }
      return sendFailure(res, err, { message: 'Failed to add the source', logPrefix: '[POLICY]' });
    }
  });

  router.put('/ai/policy/sources/:id', authMiddleware, async (req, res) => {
    const id = positiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid source id' });
    try {
      const source = await policyStore.setSourceEnabled(id, req.body?.enabled === true);
      return source ? res.json({ source }) : res.status(404).json({ error: 'No such source' });
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to update the source', logPrefix: '[POLICY]' });
    }
  });

  router.delete('/ai/policy/sources/:id', authMiddleware, async (req, res) => {
    const id = positiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid source id' });
    try {
      const removed = await policyStore.deleteSource(id);
      return removed ? res.json({ deleted: true }) : res.status(404).json({ error: 'No such source' });
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to delete the source', logPrefix: '[POLICY]' });
    }
  });

  router.post('/ai/policy/findings/:id/acknowledge', authMiddleware, async (req, res) => {
    const id = positiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid finding id' });
    try {
      const finding = await findingsStore.acknowledgeFinding(id, req.admin?.username);
      return finding
        ? res.json({ finding })
        : res.status(409).json({ error: 'That finding is already acknowledged.' });
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to acknowledge', logPrefix: '[POLICY]' });
    }
  });

  /**
   * Run the check now.
   *
   * It writes findings and may cool a provider, exactly as the timer does — so
   * it sits on the same gate as the rest of Settings rather than a narrower
   * one. It exists because waiting until Thursday to find out whether a newly
   * added source parses is a poor way to configure anything.
   */
  router.post('/ai/policy/run', authMiddleware, async (req, res) => {
    try {
      const summary = await runPolicyCheck();
      return res.json({ summary });
    } catch (err) {
      return sendFailure(res, err, { message: 'The policy check failed', logPrefix: '[POLICY]' });
    }
  });

  return router;
}

module.exports = { createAiPolicyRouter };
