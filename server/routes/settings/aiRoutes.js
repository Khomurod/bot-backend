/**
 * Admin → Settings → AI. Everything about AI is managed from here.
 *
 * The invariant every settings sub-router in this directory keeps, and this one
 * keeps too: A STORED SECRET IS NEVER RETURNED IN FULL. Reads mask to
 * `••••abcd`; only `/test` exercises a key, and it exercises the CANDIDATE from
 * the request body rather than the stored one — so an operator proves a key
 * works BEFORE saving it, and a typo never becomes a silently dead provider.
 * That is the `samsaraRoutes` pattern, and it exists because the alternative is
 * finding out at the next real call.
 *
 * Deleting a provider is allowed; disabling one is preferred and is what the UI
 * offers first. A delete loses the health history and the cooldown reason with
 * it, which is exactly what an operator debugging a flaky provider needs.
 */
const express = require('express');

const aiSettings = require('../../../database/aiSettings');
const operationalCheckSettings = require('../../../database/operationalCheckSettings');
const { groupedCapabilities } = require('../../../lib/ai/capabilityCatalog');
const aiProviders = require('../../../database/aiProviders');
const aiCallLog = require('../../../database/aiCallLog');
const { invalidateRegistry } = require('../../../services/ai/registry');
const { invalidateCapabilityCache } = require('../../../services/ai/capabilityGate');
const { callOpenAiChat } = require('../../../services/ai/adapters/openaiChat');
const { callGeminiGenerate } = require('../../../services/ai/adapters/gemini');
const { classifyFailure } = require('../../../lib/ai/classify');
const { listCatalog } = require('../../../lib/ai/providerCatalog');
const { connectProvider } = require('../../../services/ai/discovery/connectProvider');
const { refreshProviderModels } = require('../../../services/ai/discovery/refreshModels');
const aiModelEvents = require('../../../database/aiModelEvents');
const { sendFailure } = require('../../middleware/failureResponse');

/** Short, cheap and content-free — this proves the credential, not the model. */
const TEST_PROMPT = 'Reply with the single word: ok';
const TEST_TIMEOUT_MS = 20_000;

function createAiSettingsRouter({ authMiddleware }) {
  const router = express.Router();

  /** Everything the tab renders, in one round trip. */
  router.get('/ai', authMiddleware, async (req, res) => {
    try {
      const [settings, providers, capabilities, health, recentFailures, modelEvents] = await Promise.all([
        aiSettings.getAiSettings(),
        aiProviders.listProvidersForAdmin(),
        aiSettings.listCapabilities(),
        aiCallLog.summariseProviderHealth({ sinceHours: 24 }),
        aiCallLog.listRecentFailures({ limit: 20 }),
        aiModelEvents.listModelEvents({ limit: 30 }),
      ]);
      res.json({ settings, providers, capabilities, health, recentFailures, modelEvents });
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to load AI settings', logPrefix: '[AI SETTINGS]' });
    }
  });

  router.put('/ai', authMiddleware, async (req, res) => {
    try {
      const settings = await aiSettings.updateAiSettings(req.body || {}, req.admin?.username || null);
      invalidateRegistry();
      res.json({ settings });
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to save AI settings', logPrefix: '[AI SETTINGS]' });
    }
  });

  /**
   * The providers Wenze knows how to configure by itself. Public facts only —
   * an entry carries no key and no per-deployment state beyond "already added".
   */
  router.get('/ai/catalog', authMiddleware, async (req, res) => {
    try {
      const configured = new Set((await aiProviders.listProvidersForAdmin()).map((p) => p.providerKey));
      const catalog = listCatalog().map((entry) => ({
        key: entry.key, label: entry.label, adapter: entry.adapter, isFree: entry.isFree,
        freeTierNote: entry.freeTierNote, docsUrl: entry.docsUrl, keyPrefix: entry.keyPrefix,
        needsBaseUrl: entry.key === 'custom',
        configured: configured.has(entry.key),
      }));
      res.json({ catalog });
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to load the provider catalogue', logPrefix: '[AI SETTINGS]' });
    }
  });

  /**
   * Pick a provider, paste the key, Connect. The service discovers models,
   * proves the key with one call, saves the provider enabled and seeds the
   * terms watcher. A failure is a 200 with `ok: false` and a plain-language
   * reason — the REQUEST succeeded; what failed is the thing being connected.
   */
  router.post('/ai/providers/connect', authMiddleware, async (req, res) => {
    const { catalogKey, apiKey, label, baseUrl, adapter, providerKey } = req.body || {};
    if (!catalogKey) return res.status(400).json({ error: 'Choose a provider from the catalogue.' });
    try {
      const result = await connectProvider({
        catalogKey, apiKey, label, baseUrl, adapter, providerKey, updatedBy: req.admin?.username || null,
      });
      return res.json(result);
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to connect the provider', logPrefix: '[AI SETTINGS]' });
    }
  });

  /** Re-read the provider's listing now, rather than waiting for the maintenance job. */
  router.post('/ai/providers/:key/refresh-models', authMiddleware, async (req, res) => {
    try {
      const result = await refreshProviderModels(String(req.params.key), {
        initiator: 'manual', updatedBy: req.admin?.username || null,
      });
      return res.json(result);
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to refresh the models', logPrefix: '[AI SETTINGS]' });
    }
  });

  router.put('/ai/providers/:key', authMiddleware, async (req, res) => {
    const key = String(req.params.key || '').trim();
    if (!key) return res.status(400).json({ error: 'A provider key is required' });
    try {
      const provider = await aiProviders.upsertProvider(key, {
        ...(req.body || {}), updatedBy: req.admin?.username || null,
      });
      invalidateRegistry();
      return res.json({ provider });
    } catch (err) {
      // The schema's own CHECKs produce the clearest message here — an unknown
      // adapter or an out-of-range priority is a 400, not a server fault.
      if (/violates check constraint/i.test(err.message || '')) {
        return res.status(400).json({ error: `That provider is not valid: ${err.message}` });
      }
      return sendFailure(res, err, { message: 'Failed to save the provider', logPrefix: '[AI SETTINGS]' });
    }
  });

  router.delete('/ai/providers/:key', authMiddleware, async (req, res) => {
    try {
      const removed = await aiProviders.deleteProvider(String(req.params.key));
      invalidateRegistry();
      return removed
        ? res.json({ deleted: true })
        : res.status(404).json({ error: 'No such provider' });
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to delete the provider', logPrefix: '[AI SETTINGS]' });
    }
  });

  /** An operator putting a cooled provider back in rotation by hand. */
  router.post('/ai/providers/:key/clear-cooldown', authMiddleware, async (req, res) => {
    try {
      const provider = await aiProviders.clearCooldown(
        String(req.params.key), req.admin?.username || null
      );
      if (!provider) return res.status(404).json({ error: 'No such provider' });
      invalidateRegistry();
      return res.json({ provider });
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to clear the cooldown', logPrefix: '[AI SETTINGS]' });
    }
  });

  /**
   * Prove a key before it is saved.
   *
   * The candidate comes from the REQUEST BODY. Testing the stored key would
   * only tell an operator about the state they are already in; testing the one
   * they just typed is what stops a typo becoming a provider that fails
   * silently at the next real call.
   *
   * A failure is reported with its CLASS, so "the key is wrong" and "the free
   * tier is spent" — which look identical in a raw error string — read
   * differently on screen.
   */
  router.post('/ai/providers/:key/test', authMiddleware, async (req, res) => {
    const key = String(req.params.key || '').trim();
    const { apiKey, adapter, baseUrl, model } = req.body || {};
    if (!model) return res.status(400).json({ error: 'A model is required to test with' });

    let candidateKey = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!candidateKey) {
      // Fall back to what is stored, so "test the provider I saved earlier"
      // works too. Read through the router's view, never returned to the client.
      const stored = (await aiProviders.getProvidersForRouter())
        .find((p) => p.providerKey === key);
      candidateKey = stored?.apiKey || '';
    }
    if (!candidateKey) {
      return res.status(400).json({ error: 'No key to test — type one, or save one first.' });
    }

    const startedAt = Date.now();
    try {
      const result = adapter === 'gemini'
        ? await callGeminiGenerate({
          apiKey: candidateKey, model, timeoutMs: TEST_TIMEOUT_MS,
          contents: [{ role: 'user', parts: [{ text: TEST_PROMPT }] }],
        })
        : await callOpenAiChat({
          apiKey: candidateKey, model, baseUrl, timeoutMs: TEST_TIMEOUT_MS, maxTokens: 16,
          messages: [{ role: 'user', content: TEST_PROMPT }],
        });
      return res.json({
        ok: true, model: result.model, latencyMs: Date.now() - startedAt,
        sample: String(result.text || '').slice(0, 80),
      });
    } catch (err) {
      const verdict = classifyFailure({
        status: err.status ?? null, message: err.message, code: err.code,
      });
      // 200 with ok:false, not an HTTP error: the REQUEST succeeded, and what
      // failed is the thing being tested. A 500 here would make the admin's
      // fetch layer report a server fault for a mistyped key.
      return res.json({
        ok: false, failureKind: verdict.kind, error: err.message,
        latencyMs: Date.now() - startedAt,
      });
    }
  });

  /**
   * AI Responsibilities: every decision Wenze uses a model for, in words, with
   * whether it can change stored information and what governs the automatic
   * change where one exists.
   *
   * Two switches, deliberately: `aiEnabled` is "may a model be asked about
   * this", and `automation.enabled` is "may the answer be applied without a
   * person". Analysis on with automatic changes off is a sensible way to run.
   */
  router.get('/ai/responsibilities', authMiddleware, async (req, res) => {
    try {
      const [rows, checks] = await Promise.all([
        aiSettings.listCapabilities(),
        operationalCheckSettings.listCheckSettings().catch(() => []),
      ]);
      const byKey = new Map((rows || []).map((r) => [r.capabilityKey, r]));
      const byCheck = new Map((checks || []).map((c) => [c.checkKey, c]));
      const groups = groupedCapabilities().map((group) => ({
        group: group.group,
        capabilities: group.capabilities.map((cap) => {
          const stored = byKey.get(cap.key) || null;
          const check = cap.automationCheck ? byCheck.get(cap.automationCheck) || null : null;
          return {
            key: cap.key,
            label: cap.label,
            what: cap.what,
            changesState: cap.changesState === true,
            stateNote: cap.stateNote || null,
            mediumNote: cap.mediumNote || null,
            sendsRawText: cap.sendsRawText === true,
            fallback: cap.fallback || null,
            // A capability with no row yet is ENABLED — see capabilityGate.
            aiEnabled: stored ? stored.aiEnabled !== false : true,
            registered: Boolean(stored),
            automation: cap.automationCheck
              ? {
                checkKey: cap.automationCheck,
                enabled: check ? check.autoApplyEnabled === true : false,
                maxPerRun: check ? check.maxAutoPerRun : null,
              }
              : null,
          };
        }),
      }));
      return res.json({ groups });
    } catch (err) {
      return sendFailure(res, err, {
        message: 'Failed to load the AI responsibilities', logPrefix: '[AI SETTINGS]',
      });
    }
  });

  router.put('/ai/capabilities/:key', authMiddleware, async (req, res) => {
    try {
      // The gate caches for 30 seconds; an operator who just switched something
      // off should not watch it keep running while the cache expires.
      invalidateCapabilityCache();
      const capability = await aiSettings.updateCapability(String(req.params.key), {
        ...(req.body || {}), updatedBy: req.admin?.username || null,
      });
      if (!capability) return res.status(404).json({ error: 'No such capability' });
      return res.json({ capability });
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to save the capability', logPrefix: '[AI SETTINGS]' });
    }
  });

  return router;
}

module.exports = { createAiSettingsRouter, TEST_PROMPT, TEST_TIMEOUT_MS };
