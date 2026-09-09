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
const { sendFailure } = require('../../middleware/failureResponse');

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
      const check = await checkChatIdColumns(
        { notifyChatId: patch.notifyChatId },
        ['notifyChatId'],
        { getGroupByTelegramId, telegram }
      );
      if (check.error) {
        return res.status(400).json({
          error: check.error,
          suggestion: check.result?.suggestion ?? null,
        });
      }
      const settings = await policyStore.updateWatcherSettings(patch, req.admin?.username || null);
      return res.json({ settings });
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to save the watcher', logPrefix: '[POLICY]' });
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
