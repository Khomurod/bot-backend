/**
 * Re-read a provider's model listing and reconcile the chain against it.
 *
 * This is the piece that keeps a chain from going stale the week a model is
 * retired. It is called by the admin's "Refresh models" button now and by the
 * maintenance job (Phase 3-C) on a schedule; both go through this one function
 * so a scheduled change and a clicked one leave identical records.
 *
 * WHAT IT WILL AND WILL NOT DO ON ITS OWN. It removes a configured model the
 * provider no longer lists, because a model that does not exist cannot answer
 * and every call to it is a wasted attempt. It adds Wenze's picks from what is
 * new only to fill the chain back up. It keeps the operator's order for what
 * still exists — that order was a decision. And a listing that failed or came
 * back empty changes NOTHING: `reconcileChain` marks it unverified, because one
 * bad fetch must never strip a working chain.
 *
 * Every change is an `ai_model_events` row. The plain-language Telegram line
 * ("Groq retired Model A; Wenze switched to Model B") is built from those rows
 * by the maintenance job, not here.
 */
const { reconcileChain, isChatCapable, freeStatusOf } = require('../../../lib/ai/modelSelection');
const { getCatalogEntry } = require('../../../lib/ai/providerCatalog');

/**
 * Where to list a provider's models. A row connected through the catalogue
 * carries it; a LEGACY row (Groq and Gemini, configured from environment keys
 * before the catalogue existed) has no `catalog_key` and, for Gemini, no
 * `base_url` — the call adapter carried its own default, so nothing needed one.
 * The catalogue entry for the provider's own key fills the gap, so discovery
 * works for the providers a fleet has had all along, not only new ones.
 */
function discoveryTargetFor(provider, providerKey) {
  const entry = getCatalogEntry(provider.catalogKey || providerKey);
  const fromCatalog = entry && entry.key !== 'custom' ? entry : null;
  return {
    adapter: provider.adapter || fromCatalog?.adapter || 'openai_chat',
    baseUrl: provider.baseUrl || fromCatalog?.baseUrl || null,
    catalogKey: provider.catalogKey || fromCatalog?.key || null,
  };
}

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    listModels: require('./modelDiscovery').listModels,
    aiProviders: require('../../../database/aiProviders'),
    aiSettings: require('../../../database/aiSettings'),
    modelEvents: require('../../../database/aiModelEvents'),
    invalidateRegistry: require('../registry').invalidateRegistry,
  };
  /* eslint-enable global-require */
}

/**
 * @param {string} providerKey
 * @param {object} [options]
 * @param {'refresh'|'manual'} [options.initiator='refresh']
 * @returns {Promise<{ok: boolean, providerKey, modelsFound?, kept?, retired?, added?, chain?, changed?, unverified?, error?}>}
 */
async function refreshProviderModels(providerKey, { initiator = 'refresh', updatedBy = null } = {}, deps = defaultDeps()) {
  const provider = await deps.aiProviders.getProviderSecretsByKey(providerKey);
  if (!provider) return { ok: false, providerKey, error: 'No such provider' };
  if (!provider.apiKey) return { ok: false, providerKey, error: 'No key configured — nothing to ask the provider with' };

  const target = discoveryTargetFor(provider, providerKey);
  let models;
  try {
    models = await deps.listModels({
      adapter: target.adapter, baseUrl: target.baseUrl, apiKey: provider.apiKey, providerKey,
    });
  } catch (err) {
    await deps.aiProviders.saveDiscoveredModels(providerKey, { error: err.message });
    return { ok: false, providerKey, error: err.message, status: err.status ?? null };
  }

  const freeOnly = (await deps.aiSettings.getAiSettings()).freeOnlyMode === true;
  const r = reconcileChain(provider.modelChain, models, { providerKey, freeOnly });

  await deps.aiProviders.saveDiscoveredModels(providerKey, {
    models: models.map((m) => ({
      id: m.id, contextLength: m.contextLength, chat: isChatCapable(m), free: freeStatusOf(m, providerKey),
    })),
  });

  const changed = !r.unverified
    && (r.retired.length > 0 || r.chain.join('|') !== provider.modelChain.join('|'));
  if (changed) {
    await deps.aiProviders.upsertProvider(providerKey, { modelChain: r.chain, updatedBy });
    for (const model of r.retired) {
      const replacement = r.added[r.retired.indexOf(model)] || null;
      await deps.modelEvents.recordModelEvent({
        providerKey, model, event: 'retired', initiator,
        detail: { reason: 'no longer listed by the provider', replacement },
      });
    }
    for (const model of r.added) {
      await deps.modelEvents.recordModelEvent({ providerKey, model, event: 'added', initiator, detail: {} });
    }
    await deps.modelEvents.recordModelEvent({
      providerKey, event: 'selected', initiator, detail: { chain: r.chain, was: provider.modelChain },
    });
    deps.invalidateRegistry();
  }

  return {
    ok: true, providerKey, modelsFound: models.length, listed: models.map((m) => m.id),
    kept: r.kept, retired: r.retired, added: r.added, chain: r.chain,
    changed, unverified: r.unverified,
  };
}

module.exports = { refreshProviderModels, discoveryTargetFor };
