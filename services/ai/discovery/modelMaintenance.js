/**
 * Keep every provider's model chain current without anyone asking.
 *
 * A provider retires a model with a blog post, not a webhook. Until this job,
 * the only way Wenze learned about it was a 404 at call time — every call, on
 * every feature, until an administrator noticed, opened the settings and typed
 * a replacement. This job does that noticing:
 *
 *   ONCE A DAY it re-reads every enabled provider's listing through
 *   `refreshProviderModels`, which retires what is no longer listed, keeps the
 *   operator's order for what still exists and fills from Wenze's picks.
 *
 *   WHEN THE ROUTER IS REFUSED A MODEL ("decommissioned", "model_not_found") it
 *   asks for a verification of that provider, debounced, so a burst of 404s is
 *   one look at the listing rather than a hundred. The router itself changes
 *   nothing; a 404 is a claim, the listing is the evidence.
 *
 *   A RETIREMENT IS TOLD TO A PERSON, in words: "Groq retired one of Wenze's
 *   models (X). Wenze automatically switched to Y. No Wenze features were
 *   interrupted." It is filed as a policy finding (category `discontinuation`)
 *   so it lives beside the terms findings, is acknowledged the same way, and
 *   rides the same durable Telegram outbox to the destination configured in
 *   Settings. A provider left with no usable model is `serious`.
 *
 * What it will not do: retire on a failed or empty listing (`reconcileChain`
 * refuses), disable a provider (only a person does that), or touch a chain the
 * listing still supports.
 */
const { createDueTimeWakeTimer } = require('../../dueTimeWakeTimer');
const { getCatalogEntry } = require('../../../lib/ai/providerCatalog');
const { buildAlertBody } = require('../policy/alertMessage');

/** 06:00 UTC — after most providers' overnight changes, before a working day. */
const MAINTENANCE_HOUR_UTC = 6;
const FIRST_TICK_DELAY_MS = 3 * 60 * 1000;
const VERIFY_DEBOUNCE_MS = 5 * 60 * 1000;

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    aiProviders: require('../../../database/aiProviders'),
    aiPolicy: require('../../../database/aiPolicy'),
    findingsStore: require('../../../database/aiPolicyFindings'),
    modelEvents: require('../../../database/aiModelEvents'),
    refreshProviderModels: require('./refreshModels').refreshProviderModels,
  };
  /* eslint-enable global-require */
}

function nextMaintenanceDueAt(now = new Date()) {
  const due = new Date(now);
  due.setUTCHours(MAINTENANCE_HOUR_UTC, 0, 0, 0);
  if (due <= now) due.setUTCDate(due.getUTCDate() + 1);
  return due.getTime();
}

/** The words. PURE. Only a replacement that is actually IN the chain is claimed. */
function describeModelChange(label, { retired = [], added = [], chain = [] }) {
  const one = retired.length === 1;
  const replacements = (added || []).filter((m) => chain.includes(m));
  const summary = [];
  if (!chain.length) {
    summary.push(`${label} retired every model Wenze was using (${retired.join(', ')}).`);
    summary.push(`No usable model is listed, so ${label} is out of rotation until one appears; `
      + 'other providers continue, and AI features fall back to their deterministic logic where needed.');
  } else {
    summary.push(`${label} retired ${one ? 'one of Wenze\'s models' : `${retired.length} of Wenze's models`} (${retired.join(', ')}).`);
    if (replacements.length) summary.push(`Wenze automatically switched to ${replacements.join(', ')}.`);
    else summary.push(`Wenze continues with ${chain[0]}.`);
    summary.push('No Wenze features were interrupted.');
  }
  return {
    summary: summary.join(' '),
    whatChanged: `Retired: ${retired.join(', ')}. Now using: ${chain.length ? chain.join(' → ') : 'nothing — the chain is empty'}.`,
    whyItMatters: 'A retired model fails every call made to it; removing it keeps AI responses fast and stops '
      + 'wasted attempts. The provider itself is unchanged and still enabled.',
  };
}

function sourceUrlFor(provider) {
  const entry = getCatalogEntry(provider.catalogKey);
  return entry?.policySources?.model_policy
    || (provider.baseUrl ? `${String(provider.baseUrl).replace(/\/+$/, '')}/models` : entry?.docsUrl)
    || 'https://wenze.invalid/ai/models';
}

/**
 * Tell a person about every retirement nobody has been told about — driven by
 * `ai_model_events` rows with `notified_at IS NULL`, not by this pass's refresh
 * result. The refresh has already saved the new chain by the time this runs;
 * if the finding or the alert failed to write, the next pass would otherwise
 * see nothing retired and never try again. The stamp is written LAST.
 */
async function notifyPendingRetirements(provider, chain, deps) {
  const pending = await deps.modelEvents.listUnnotifiedRetirements(provider.providerKey);
  if (!pending.length) return 0;
  const retired = [...new Set(pending.map((e) => e.model).filter(Boolean))];
  const added = [...new Set(pending.map((e) => e.detail?.replacement).filter(Boolean))];
  await recordRetirement(provider, { retired, added, chain }, deps);
  await deps.modelEvents.markEventsNotified(pending.map((e) => e.id));
  return pending.length;
}

async function recordRetirement(provider, result, deps) {
  const text = describeModelChange(provider.label || provider.providerKey, result);
  const finding = await deps.findingsStore.insertFinding({
    providerKey: provider.providerKey,
    sourceUrl: sourceUrlFor(provider),
    category: 'discontinuation',
    severity: result.chain.length ? 'info' : 'serious',
    summary: text.summary,
    whatChanged: text.whatChanged,
    whyItMatters: text.whyItMatters,
    detectedTopics: ['model_retired'],
    aiAssisted: false,
  });
  const settings = await deps.aiPolicy.getWatcherSettings();
  if (settings.notifyEnabled && settings.notifyChatId
      && deps.findingsStore.meetsSeverityThreshold(finding.severity, settings.notifyMinSeverity)) {
    await deps.findingsStore.enqueueAlert({
      findingId: finding.id,
      chatId: settings.notifyChatId,
      body: buildAlertBody(finding, { deterministic: true }),
    });
  }
  return finding;
}

/**
 * Refresh one provider, retire any caller-preferred models the listing no
 * longer has, and tell someone about everything retired and not yet told.
 *
 * `models` are the ones the router was refused. They are callers' own
 * preferences (`preferModels`), which live in the caller and not in the chain —
 * so a chain refresh cannot retire them, but the provider's listing can prove
 * they are gone. A model the previous listing did not have either was already
 * known to be absent and is not reported again.
 */
async function verifyProvider(provider, { initiator = 'refresh', models = [] } = {}, deps = defaultDeps()) {
  const result = await deps.refreshProviderModels(provider.providerKey, { initiator });
  if (!result.ok) return result;

  const listed = new Set(result.listed || []);
  const before = new Set((provider.discoveredModels || []).map((m) => m?.id).filter(Boolean));
  for (const model of [...new Set(models)].filter(Boolean)) {
    if (listed.has(model)) continue; // still exists — the refusal was something else
    if (before.size && !before.has(model)) continue; // already known to be absent
    if (result.chain.includes(model)) continue; // handled by the chain reconcile
    await deps.modelEvents.recordModelEvent({
      providerKey: provider.providerKey, model, event: 'retired', initiator,
      detail: { source: 'capability_preference', reason: 'refused by the provider and absent from its listing' },
    });
  }

  result.notified = await notifyPendingRetirements(provider, result.chain, deps);
  return result;
}

/**
 * @returns {Promise<{checked: number, changed: number, retired: number, errors: number}>}
 */
async function runModelMaintenance({ initiator = 'refresh' } = {}, deps = defaultDeps()) {
  const providers = (await deps.aiProviders.listProvidersForAdmin())
    .filter((p) => p.enabled === true && p.apiKeySet === true);
  const summary = { checked: 0, changed: 0, retired: 0, errors: 0 };
  for (const provider of providers) {
    summary.checked += 1;
    try {
      const r = await verifyProvider(provider, { initiator }, deps);
      if (!r.ok) { summary.errors += 1; continue; }
      if (r.changed) summary.changed += 1;
      summary.retired += r.notified || 0;
    } catch (err) {
      summary.errors += 1;
      console.error(`[AI MODELS] refresh of ${provider.providerKey} failed:`, err.message);
    }
  }
  if (summary.changed || summary.errors) {
    console.log(`[AI MODELS] ${summary.checked} provider(s) checked, ${summary.changed} chain(s) changed, `
      + `${summary.retired} model(s) retired, ${summary.errors} error(s).`);
  }
  return summary;
}

/**
 * Debounced "look at this provider soon". One timer per provider; a burst of
 * refusals collapses into one verification. Restart-safe by construction — the
 * daily run catches anything a lost timer would have.
 */
function createVerificationRequester({ verify, debounceMs = VERIFY_DEBOUNCE_MS } = {}) {
  const pending = new Map(); // providerKey → { timer, models: Set }
  return function request(providerKey, model = null) {
    if (!providerKey) return;
    const entry = pending.get(providerKey);
    if (entry) {
      if (model) entry.models.add(model);
      return;
    }
    const models = new Set(model ? [model] : []);
    const timer = setTimeout(() => {
      pending.delete(providerKey);
      Promise.resolve(verify(providerKey, [...models])).catch((err) => {
        console.error(`[AI MODELS] verification of ${providerKey} failed:`, err.message);
      });
    }, debounceMs);
    timer.unref?.();
    pending.set(providerKey, { timer, models });
  };
}

let timer = null;
let requester = null;

async function verifyByKey(providerKey, models = [], deps = defaultDeps()) {
  const provider = (await deps.aiProviders.listProvidersForAdmin()).find((p) => p.providerKey === providerKey);
  if (!provider || provider.enabled !== true || provider.apiKeySet !== true) return null;
  return verifyProvider(provider, { initiator: 'router', models }, deps);
}

function startModelMaintenance({ setModelRefusalListener = null } = {}) {
  if (timer) return;
  timer = createDueTimeWakeTimer({
    label: 'AI MODELS',
    runTick: async () => {
      await runModelMaintenance({});
      return { dueAtMs: nextMaintenanceDueAt() };
    },
  });
  timer.start(FIRST_TICK_DELAY_MS);
  requester = createVerificationRequester({ verify: (key, models) => verifyByKey(key, models) });
  if (typeof setModelRefusalListener === 'function') {
    setModelRefusalListener(({ providerKey, model }) => requester(providerKey, model));
  }
  console.log('[AI MODELS] Model maintenance started — daily at 06:00 UTC, plus on refusal.');
}

function stopModelMaintenance() {
  if (timer) { timer.stop(); timer = null; }
  requester = null;
}

module.exports = {
  runModelMaintenance, verifyProvider, notifyPendingRetirements, describeModelChange, nextMaintenanceDueAt,
  createVerificationRequester, startModelMaintenance, stopModelMaintenance,
  MAINTENANCE_HOUR_UTC, VERIFY_DEBOUNCE_MS,
};
