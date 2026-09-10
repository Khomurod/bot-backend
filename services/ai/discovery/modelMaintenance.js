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

/** The words. PURE. */
function describeModelChange(label, { retired = [], added = [], chain = [] }) {
  const one = retired.length === 1;
  const summary = [];
  if (!chain.length) {
    summary.push(`${label} retired every model Wenze was using (${retired.join(', ')}).`);
    summary.push(`No usable model is listed, so ${label} is out of rotation until one appears; `
      + 'other providers continue, and AI features fall back to their deterministic logic where needed.');
  } else {
    summary.push(`${label} retired ${one ? 'one of Wenze\'s models' : `${retired.length} of Wenze's models`} (${retired.join(', ')}).`);
    if (added.length) summary.push(`Wenze automatically switched to ${added.join(', ')}.`);
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

/** Refresh one provider and tell someone if a model went away. */
async function verifyProvider(provider, { initiator = 'refresh' } = {}, deps = defaultDeps()) {
  const result = await deps.refreshProviderModels(provider.providerKey, { initiator });
  if (result.ok && result.retired?.length) await recordRetirement(provider, result, deps);
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
      summary.retired += r.retired?.length || 0;
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
  const pending = new Map();
  return function request(providerKey) {
    if (!providerKey || pending.has(providerKey)) return;
    const timer = setTimeout(() => {
      pending.delete(providerKey);
      Promise.resolve(verify(providerKey)).catch((err) => {
        console.error(`[AI MODELS] verification of ${providerKey} failed:`, err.message);
      });
    }, debounceMs);
    timer.unref?.();
    pending.set(providerKey, timer);
  };
}

let timer = null;
let requester = null;

async function verifyByKey(providerKey, deps = defaultDeps()) {
  const provider = (await deps.aiProviders.listProvidersForAdmin()).find((p) => p.providerKey === providerKey);
  if (!provider || provider.enabled !== true || provider.apiKeySet !== true) return null;
  return verifyProvider(provider, { initiator: 'router' }, deps);
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
  requester = createVerificationRequester({ verify: (key) => verifyByKey(key) });
  if (typeof setModelRefusalListener === 'function') {
    setModelRefusalListener(({ providerKey }) => requester(providerKey));
  }
  console.log('[AI MODELS] Model maintenance started — daily at 06:00 UTC, plus on refusal.');
}

function stopModelMaintenance() {
  if (timer) { timer.stop(); timer = null; }
  requester = null;
}

module.exports = {
  runModelMaintenance, verifyProvider, describeModelChange, nextMaintenanceDueAt,
  createVerificationRequester, startModelMaintenance, stopModelMaintenance,
  MAINTENANCE_HOUR_UTC, VERIFY_DEBOUNCE_MS,
};
