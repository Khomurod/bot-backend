'use strict';

/**
 * Settings → AI → "Providers for one task" — which providers may do one AI
 * task, and in what order (owner, 14 November 2026; migration 0107;
 * lib/ai/providerChoice.js). The CDL reading is the first task that needs it.
 *
 *   GET /ai/capability-providers        the tasks that offer a choice, each
 *       with its list (null: the global order), and the providers to choose
 *       from — label, on/off, free or paid, and whether any of its models can
 *       read a picture (lib/ai/vision.js). Never a key.
 *   PUT /ai/capabilities/:key/providers  `{ order: [...] }` saves the list
 *       (`[]` for a task that needs a choice means "nobody"); `{ order: null }`
 *       hands the task back to the global order — refused for a task that
 *       requires a choice, where "no list" already means nobody.
 *
 * The provider keys are checked against the providers that exist; a deleted
 * provider is later skipped by the router (it is not on the roster).
 */

const express = require('express');

const aiSettings = require('../../../database/aiSettings');
const aiProviders = require('../../../database/aiProviders');
const { CAPABILITIES, getCapabilityMeta } = require('../../../lib/ai/capabilityCatalog');
const { effectiveProviderOrder, normaliseProviderOrder } = require('../../../lib/ai/providerChoice');
const { isVisionModel } = require('../../../lib/ai/vision');
const { invalidateCapabilityCache } = require('../../../services/ai/capabilityGate');
const { sendFailure } = require('../../middleware/failureResponse');

const LOG = { logPrefix: '[AI SETTINGS]' };

function providerView(p) {
  return {
    providerKey: p.providerKey,
    label: p.label || p.providerKey,
    enabled: p.enabled === true,
    isFree: p.isFree === true,
    hasKey: p.apiKeySet === true,
    canSee: (p.modelChain || []).some((m) => isVisionModel(p.adapter, m)),
  };
}

function createAiCapabilityProvidersRouter({ authMiddleware }) {
  const router = express.Router();

  router.get('/ai/capability-providers', authMiddleware, async (req, res) => {
    try {
      const [rows, providers, settings] = await Promise.all([
        aiSettings.listCapabilities(),
        aiProviders.listProvidersForAdmin(),
        aiSettings.getAiSettings(),
      ]);
      const byKey = new Map((rows || []).map((r) => [r.capabilityKey, r]));
      const capabilities = CAPABILITIES.filter((c) => c.providerChoice).map((c) => {
        const stored = byKey.get(c.key) || null;
        return {
          key: c.key,
          label: c.label,
          group: c.group,
          providerChoice: c.providerChoice,
          needsVision: c.needsVision === true,
          aiEnabled: stored ? stored.aiEnabled !== false : true,
          order: effectiveProviderOrder(c, stored?.providerOrder),
        };
      });
      return res.json({
        capabilities, providers: providers.map(providerView), freeOnlyMode: settings.freeOnlyMode === true,
      });
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to load the providers for each task', ...LOG });
    }
  });

  router.put('/ai/capabilities/:key/providers', authMiddleware, async (req, res) => {
    const key = String(req.params.key || '');
    const meta = getCapabilityMeta(key);
    if (!meta) return res.status(404).json({ error: 'No such AI task' });
    const input = req.body?.order;
    try {
      let order = null;
      if (input === null) {
        if (meta.providerChoice === 'required') {
          return res.status(400).json({ error: 'This task is asked only of the providers chosen for it.' });
        }
      } else {
        const known = (await aiProviders.listProvidersForAdmin()).map((p) => p.providerKey);
        const checked = normaliseProviderOrder(input, known);
        if (!checked.ok) return res.status(400).json({ error: checked.error });
        order = checked.order;
      }
      const capability = await aiSettings.setCapabilityProviderOrder(key, order, {
        label: meta.label, updatedBy: req.admin?.username || null,
      });
      // AFTER the write: see the switch's route in aiRoutes.js for why.
      invalidateCapabilityCache();
      return res.json({ key, order: effectiveProviderOrder(meta, capability?.providerOrder) });
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to save the providers for this task', ...LOG });
    }
  });

  return router;
}

module.exports = { createAiCapabilityProvidersRouter };
