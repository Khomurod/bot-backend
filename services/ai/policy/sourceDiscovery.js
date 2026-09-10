/**
 * Where a provider's official pages are — found by Wenze, not typed by a person.
 *
 * Three jobs, in the order they happen to a source over its life:
 *
 *   SEEDING. A catalogued provider that is enabled gets every page the
 *   catalogue knows (terms, privacy, pricing, model policy) as `catalog`
 *   sources, without anyone pasting a URL. A page a person added by hand for
 *   the same kind is left alone — they chose it.
 *
 *   FOLLOWING A MOVE. A fetch that lands somewhere else is a redirect. On the
 *   provider's own site that is the page's new home and the source is moved;
 *   off the site (a CDN error page, a generic landing) it is recorded and left
 *   where it was, because a redirect to nowhere is not a new address.
 *
 *   FINDING IT AGAIN. When a page stops answering, Wenze looks — deterministic
 *   steps first, a model only to choose between candidates it already found:
 *     1. the catalogue's URL for that kind, if it differs and answers;
 *     2. the provider's documentation root and site root, scanned for links on
 *        the provider's OWN domain that look like the kind of page wanted, each
 *        verified by fetching it and checking it reads like that kind of page;
 *     3. if more than one candidate verifies, the router is asked to pick —
 *        with `excludeProvider` set to the provider under investigation, which
 *        must never be a dependency for investigating itself. A model answer
 *        naming a URL that is not among the candidates is ignored.
 *   Only when all three fail is a person told, and told once: an operational
 *   finding (Needs Attention), a policy finding, and a Telegram line.
 *
 * Every collaborator is injectable; production passes nothing.
 */
const { getCatalogEntry } = require('../../../lib/ai/providerCatalog');
const { extractLinks, rankCandidates, looksLikeKind, sameSite } = require('../../../lib/ai/policyLinks');
const { normalisePolicyText } = require('../../../lib/ai/policyText');
const { buildAlertBody } = require('./alertMessage');

const LOST_AFTER_FAILURES = 3;
const VERIFY_TIMEOUT_MS = 15_000;
const MAX_VERIFY = 3;
const CHECK_KEY_LOST = 'ai.policy_source_lost';

const KIND_LABEL = {
  terms: 'terms', privacy: 'privacy policy', acceptable_use: 'acceptable-use policy',
  pricing: 'pricing', model_policy: 'model policy', other: 'policy',
};

function defaultDeps() {
  /* eslint-disable global-require */
  const aiPolicy = require('../../../database/aiPolicy');
  return {
    aiPolicy,
    aiProviders: require('../../../database/aiProviders'),
    operationalFindings: require('../../../database/operationalFindings'),
    findingsStore: require('../../../database/aiPolicyFindings'),
    aiPolicySettings: () => aiPolicy.getWatcherSettings(),
    runCapability: (args) => require('../router').runCapability(args),
    fetchImpl: globalThis.fetch,
  };
  /* eslint-enable global-require */
}

const trim = (url) => String(url || '').trim().replace(/\/+$/, '');
const labelFor = (providerKey, providers = []) => providers.find((p) => p.providerKey === providerKey)?.label
  || getCatalogEntry(providerKey)?.label || providerKey;

// ─── seeding ─────────────────────────────────────────────────────────────────

async function ensureCatalogSources(deps = defaultDeps()) {
  const [providers, existing] = await Promise.all([
    deps.aiProviders.listProvidersForAdmin(),
    deps.aiPolicy.listSourcesForAdmin(),
  ]);
  let seeded = 0;
  for (const provider of providers.filter((p) => p.enabled === true)) {
    const entry = getCatalogEntry(provider.catalogKey || provider.providerKey);
    if (!entry || entry.key === 'custom') continue;
    const haveKinds = new Set(existing.filter((s) => s.providerKey === provider.providerKey).map((s) => s.kind));
    for (const [kind, url] of Object.entries(entry.policySources || {})) {
      if (haveKinds.has(kind)) continue;
      await deps.aiPolicy.addSource({ providerKey: provider.providerKey, url, kind, sourceOrigin: 'catalog' });
      seeded += 1;
    }
  }
  return { seeded };
}

// ─── redirects ───────────────────────────────────────────────────────────────

async function handleRedirect(source, finalUrl, deps = defaultDeps()) {
  const to = trim(finalUrl);
  if (!to || to === trim(source.url)) return { moved: false };
  if (sameSite(source.url, to)) {
    await deps.aiPolicy.moveSource(source.id, to, { reason: 'redirect' });
    return { moved: true, url: to };
  }
  await deps.aiPolicy.recordRedirect(source.id, to);
  return { moved: false, redirectedTo: to };
}

// ─── rediscovery ─────────────────────────────────────────────────────────────

async function fetchText(url, deps) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const res = await deps.fetchImpl(url, {
      headers: { 'User-Agent': 'Wenze-PolicyWatcher/1.0 (+operational terms monitoring)', Accept: 'text/html,text/plain;q=0.9' },
      signal: controller.signal, redirect: 'follow',
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function verifyCandidate(url, kind, deps) {
  const body = await fetchText(url, deps);
  if (body == null) return false;
  return looksLikeKind(normalisePolicyText(body), kind);
}

async function scanSiteForCandidates(source, entry, deps) {
  const roots = new Set();
  if (entry?.docsUrl) roots.add(trim(entry.docsUrl));
  try { roots.add(new URL(source.url).origin); } catch { /* unusable url */ }
  const seen = new Map();
  for (const root of roots) {
    const html = await fetchText(root, deps);
    if (!html) continue;
    for (const c of rankCandidates(extractLinks(html, root), { kind: source.kind, siteUrl: source.url, exclude: source.url })) {
      if (!seen.has(c.url) || seen.get(c.url).score < c.score) seen.set(c.url, c);
    }
  }
  return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, MAX_VERIFY);
}

async function askModelToChoose(source, verified, deps) {
  const label = labelFor(source.providerKey);
  const list = verified.map((c, i) => `${i + 1}. ${c.url} — "${c.text || ''}"`).join('\n');
  try {
    const result = await deps.runCapability({
      capability: 'policy_source_discovery',
      excludeProvider: source.providerKey,
      expects: 'json',
      systemText: 'You identify which of several given URLs is a provider\'s official policy page. '
        + 'Answer with JSON {"url": "<one of the given URLs>"} and nothing else. Never invent a URL.',
      userText: `Provider: ${label}. Wanted: the official ${KIND_LABEL[source.kind] || source.kind} page.\n`
        + `The previous address was ${source.url} and no longer answers.\nCandidates:\n${list}`,
    });
    const chosen = trim(result?.parsed?.url);
    return verified.find((c) => c.url === chosen) || null;
  } catch {
    return null; // AI unavailable is a normal state; the deterministic answer stands
  }
}

/**
 * @returns {Promise<{found: boolean, url?: string, how?: 'catalog'|'site_scan'|'ai_ranked'}>}
 */
async function rediscoverSource(source, deps = defaultDeps()) {
  const entry = getCatalogEntry(source.catalogKey || source.providerKey);

  const fromCatalog = entry?.policySources?.[source.kind] ? trim(entry.policySources[source.kind]) : null;
  if (fromCatalog && fromCatalog !== trim(source.url) && await verifyCandidate(fromCatalog, source.kind, deps)) {
    await deps.aiPolicy.moveSource(source.id, fromCatalog, { reason: 'rediscovered', origin: 'rediscovered' });
    return { found: true, url: fromCatalog, how: 'catalog' };
  }

  const candidates = await scanSiteForCandidates(source, entry, deps);
  const verified = [];
  for (const c of candidates) {
    if (await verifyCandidate(c.url, source.kind, deps)) verified.push(c);
  }
  if (!verified.length) return { found: false };

  let pick = verified[0];
  let how = 'site_scan';
  if (verified.length > 1) {
    const chosen = await askModelToChoose(source, verified, deps);
    if (chosen) { pick = chosen; how = 'ai_ranked'; }
  }
  await deps.aiPolicy.moveSource(source.id, pick.url, { reason: 'rediscovered', origin: 'rediscovered' });
  return { found: true, url: pick.url, how };
}

// ─── telling a person ────────────────────────────────────────────────────────

async function reportLostSource(source, { error = null } = {}, deps = defaultDeps()) {
  if (source.lostReportedAt) return { reported: false, reason: 'already reported' };
  const label = labelFor(source.providerKey);
  const kind = KIND_LABEL[source.kind] || source.kind;
  const summary = `Wenze can no longer find ${label}'s ${kind} page. The last known address `
    + `(${source.url}) returns ${error || 'an error'} and no replacement was found on the provider's site. `
    + 'Please check it in Settings → AI → Provider terms watcher.';

  await deps.operationalFindings.upsertFinding({
    checkKey: CHECK_KEY_LOST,
    subjectType: 'policy_source',
    subjectId: source.id,
    title: `${label}: ${kind} page can no longer be found`,
    severity: 'warning',
    tier: 'warning',
    evidence: {
      providerKey: source.providerKey, kind: source.kind, url: source.url,
      error, consecutiveFailures: source.consecutiveFailures ?? null,
    },
  });
  const finding = await deps.findingsStore.insertFinding({
    providerKey: source.providerKey,
    sourceUrl: source.url,
    category: 'other',
    severity: 'warning',
    summary,
    whatChanged: `The page at ${source.url} stopped answering (${error || 'error'}).`,
    whyItMatters: `Until it is found again, changes to ${label}'s ${kind} will not be noticed.`,
    detectedTopics: ['source_lost'],
    aiAssisted: false,
  });
  const settings = await deps.aiPolicySettings();
  if (settings.notifyEnabled && settings.notifyChatId
      && deps.findingsStore.meetsSeverityThreshold(finding.severity, settings.notifyMinSeverity)) {
    await deps.findingsStore.enqueueAlert({
      findingId: finding.id, chatId: settings.notifyChatId,
      body: buildAlertBody(finding, { deterministic: true }),
    });
  }
  await deps.aiPolicy.markSourceLost(source.id);
  return { reported: true };
}

/** A page that was lost answers again: clear the flag and resolve the Needs Attention item. */
async function clearLostSource(source, deps = defaultDeps()) {
  if (!source.lostReportedAt) return false;
  await deps.aiPolicy.clearSourceLost(source.id);
  return true;
}

/**
 * Keep the Needs Attention list honest: refresh the finding for every source
 * still lost, resolve the ones that were found again. Same semantics as the
 * consistency sweep — a finding not re-filed this run is a condition that cleared.
 */
async function reconcileLostFindings(sources, deps = defaultDeps()) {
  const keep = [];
  for (const source of sources.filter((s) => s.lostReportedAt)) {
    const label = labelFor(source.providerKey);
    const row = await deps.operationalFindings.upsertFinding({
      checkKey: CHECK_KEY_LOST, subjectType: 'policy_source', subjectId: source.id,
      title: `${label}: ${KIND_LABEL[source.kind] || source.kind} page can no longer be found`,
      severity: 'warning', tier: 'warning',
      evidence: { providerKey: source.providerKey, kind: source.kind, url: source.url, lastError: source.lastError },
    });
    if (row?.id) keep.push(row.id);
  }
  return deps.operationalFindings.resolveClearedFindings([CHECK_KEY_LOST], keep);
}

module.exports = {
  ensureCatalogSources, handleRedirect, rediscoverSource, reportLostSource, clearLostSource,
  reconcileLostFindings, LOST_AFTER_FAILURES, CHECK_KEY_LOST, KIND_LABEL,
};
