/**
 * Finding official pages without a person typing URLs — and finding them again
 * when they move.
 *
 * Three refusals are the substance:
 *   a page is never invented: the model, when asked at all, chooses among
 *   candidates found on the provider's own site;
 *   the provider under investigation is never the one asked;
 *   a person is told only after Wenze has genuinely failed, and told once.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ensureCatalogSources, rediscoverSource, reportLostSource, handleRedirect, LOST_AFTER_FAILURES,
} = require('../services/ai/policy/sourceDiscovery');

const TERMS_PAGE = `<html><body>${'These Terms of Use govern your use of the Groq API. '.repeat(30)}</body></html>`;
const DOCS_ROOT = `<html><body><footer>
  <a href="https://groq.com/legal/terms-of-use">Terms of Use</a>
  <a href="https://groq.com/legal/privacy">Privacy</a>
  <a href="https://groq.com/pricing">Pricing</a>
  <a href="https://status.groq.com/">Status</a>
</footer></body></html>`;

function deps({ pages = {}, existing = [], aiChoice = null, providers = null } = {}) {
  const saw = { added: [], moved: [], redirects: [], lost: [], cleared: [], opFindings: [], findings: [], alerts: [], ai: [] };
  const fetchImpl = async (url) => {
    const key = String(url).replace(/\/+$/, '');
    const page = pages[key];
    if (!page) return { ok: false, status: 404, statusText: 'Not Found', url: key, headers: { get: () => null }, text: async () => '' };
    return { ok: true, status: 200, url: page.finalUrl || key, headers: { get: () => null }, text: async () => page.body };
  };
  return {
    saw, fetchImpl,
    aiPolicy: {
      async listSourcesForAdmin() { return existing; },
      async addSource(s) { saw.added.push(s); return { id: 100 + saw.added.length, ...s }; },
      async moveSource(id, newUrl, opts) { saw.moved.push({ id, newUrl, ...opts }); return { id, url: newUrl }; },
      async recordRedirect(id, to) { saw.redirects.push({ id, to }); },
      async markSourceLost(id) { saw.lost.push(id); },
      async clearSourceLost(id) { saw.cleared.push(id); },
    },
    aiProviders: {
      async listProvidersForAdmin() {
        return providers || [
          { providerKey: 'groq', label: 'Groq', enabled: true, catalogKey: 'groq' },
          { providerKey: 'llm-example-com', label: 'Office LLM', enabled: true, catalogKey: 'custom', baseUrl: 'https://llm.example.com/v1' },
          { providerKey: 'gemini', label: 'Gemini', enabled: false, catalogKey: 'gemini' },
        ];
      },
    },
    operationalFindings: { async upsertFinding(f) { saw.opFindings.push(f); return { id: 7, ...f }; } },
    findingsStore: {
      async insertFinding(f) { saw.findings.push(f); return { id: saw.findings.length, ...f }; },
      async enqueueAlert(a) { saw.alerts.push(a); return a; },
      meetsSeverityThreshold: () => true,
    },
    aiPolicySettings: async () => ({ notifyEnabled: true, notifyChatId: '-1001', notifyMinSeverity: 'info' }),
    runCapability: async (args) => {
      saw.ai.push(args);
      if (!aiChoice) throw Object.assign(new Error('AI is switched off'), { name: 'AiUnavailableError' });
      return { text: JSON.stringify(aiChoice), parsed: aiChoice, provider: 'cerebras', model: 'x' };
    },
  };
}

// ─── seeding ─────────────────────────────────────────────────────────────────

test('a catalogued, enabled provider with no pages gets every catalogue page, as catalog origin', async () => {
  const d = deps();
  const r = await ensureCatalogSources(d);
  const groq = d.saw.added.filter((s) => s.providerKey === 'groq');
  assert.ok(groq.length >= 4, 'terms, privacy, model_policy, pricing');
  assert.ok(groq.every((s) => s.sourceOrigin === 'catalog'));
  assert.ok(groq.every((s) => /^https:\/\//.test(s.url)));
  assert.equal(d.saw.added.some((s) => s.providerKey === 'llm-example-com'), false, 'nothing is known about a custom provider');
  assert.equal(d.saw.added.some((s) => s.providerKey === 'gemini'), false, 'a disabled provider is not watched');
  assert.equal(r.seeded, groq.length);
});

test('a kind a person already added by hand is not seeded over', async () => {
  const d = deps({ existing: [{ id: 1, providerKey: 'groq', kind: 'terms', url: 'https://groq.com/my-own-terms', enabled: true }] });
  await ensureCatalogSources(d);
  assert.equal(d.saw.added.some((s) => s.providerKey === 'groq' && s.kind === 'terms'), false);
  assert.ok(d.saw.added.some((s) => s.providerKey === 'groq' && s.kind === 'privacy'));
});

// ─── redirects ───────────────────────────────────────────────────────────────

test('a same-site redirect moves the source; a cross-site one is only recorded', async () => {
  const d = deps();
  const src = { id: 5, providerKey: 'groq', url: 'https://groq.com/terms-of-use', kind: 'terms', sourceOrigin: 'catalog' };
  await handleRedirect(src, 'https://groq.com/legal/terms-of-use/', d);
  assert.deepEqual(d.saw.moved[0], { id: 5, newUrl: 'https://groq.com/legal/terms-of-use', reason: 'redirect' });

  const d2 = deps();
  await handleRedirect(src, 'https://www.cloudflare.com/5xx-error-landing', d2);
  assert.equal(d2.saw.moved.length, 0, 'a redirect off the site is not the page\'s new home');
  assert.deepEqual(d2.saw.redirects[0], { id: 5, to: 'https://www.cloudflare.com/5xx-error-landing' });
});

// ─── rediscovery ─────────────────────────────────────────────────────────────

test('step 1: the catalogue knows a different URL for this kind, and it answers', async () => {
  const d = deps({ pages: { 'https://groq.com/terms-of-use': { body: TERMS_PAGE } } });
  const src = { id: 5, providerKey: 'groq', catalogKey: 'groq', url: 'https://groq.com/old-terms', kind: 'terms', sourceOrigin: 'manual' };
  const r = await rediscoverSource(src, d);
  assert.equal(r.found, true);
  assert.equal(r.url, 'https://groq.com/terms-of-use');
  assert.equal(r.how, 'catalog');
  assert.equal(d.saw.moved[0].reason, 'rediscovered');
  assert.equal(d.saw.ai.length, 0, 'no model needed');
});

test('step 2: the docs root links to the page, on the provider\'s own site, and it verifies', async () => {
  const d = deps({
    pages: {
      'https://console.groq.com/docs': { body: DOCS_ROOT },
      'https://groq.com/legal/terms-of-use': { body: TERMS_PAGE },
    },
  });
  // The catalogue URL for terms 404s too, so step 1 fails.
  const src = { id: 5, providerKey: 'groq', catalogKey: 'groq', url: 'https://groq.com/terms-of-use', kind: 'terms', sourceOrigin: 'catalog' };
  const r = await rediscoverSource(src, d);
  assert.equal(r.found, true);
  assert.equal(r.url, 'https://groq.com/legal/terms-of-use');
  assert.equal(r.how, 'site_scan');
  assert.equal(d.saw.ai.length, 0, 'one clear candidate needs no model');
});

test('step 3: with several plausible candidates a model ranks them — never asking the provider under investigation, never inventing', async () => {
  const twoTerms = `<html><body>
    <a href="https://groq.com/legal/terms-of-use">Terms of Use</a>
    <a href="https://groq.com/legal/api-terms">API Terms</a>
  </body></html>`;
  const d = deps({
    pages: {
      'https://console.groq.com/docs': { body: twoTerms },
      'https://groq.com/legal/terms-of-use': { body: TERMS_PAGE },
      'https://groq.com/legal/api-terms': { body: TERMS_PAGE.replace(/Terms of Use/g, 'API Terms') },
    },
    aiChoice: { url: 'https://groq.com/legal/api-terms' },
  });
  const src = { id: 5, providerKey: 'groq', catalogKey: 'groq', url: 'https://groq.com/terms-of-use', kind: 'terms', sourceOrigin: 'catalog' };
  const r = await rediscoverSource(src, d);
  assert.equal(r.found, true);
  assert.equal(r.url, 'https://groq.com/legal/api-terms');
  assert.equal(r.how, 'ai_ranked');
  assert.equal(d.saw.ai[0].excludeProvider, 'groq');
  assert.equal(d.saw.ai[0].expects, 'json');
  assert.ok(/api-terms/.test(d.saw.ai[0].userText), 'the model sees the candidates, and only the candidates');
});

test('a model that names a URL not among the candidates is ignored, and the best candidate is used', async () => {
  const twoTerms = `<html><body>
    <a href="https://groq.com/legal/terms-of-use">Terms of Use</a>
    <a href="https://groq.com/legal/api-terms">API Terms</a>
  </body></html>`;
  const d = deps({
    pages: {
      'https://console.groq.com/docs': { body: twoTerms },
      'https://groq.com/legal/terms-of-use': { body: TERMS_PAGE },
      'https://groq.com/legal/api-terms': { body: TERMS_PAGE },
    },
    aiChoice: { url: 'https://evil.example.com/terms' },
  });
  const src = { id: 5, providerKey: 'groq', catalogKey: 'groq', url: 'https://groq.com/terms-of-use', kind: 'terms', sourceOrigin: 'catalog' };
  const r = await rediscoverSource(src, d);
  assert.equal(r.found, true);
  assert.match(r.url, /^https:\/\/groq\.com\/legal\//);
  assert.equal(r.how, 'site_scan');
});

test('when nothing verifies, it says so and moves nothing', async () => {
  const d = deps({ pages: {} });
  const src = { id: 5, providerKey: 'groq', catalogKey: 'groq', url: 'https://groq.com/terms-of-use', kind: 'terms', sourceOrigin: 'catalog' };
  const r = await rediscoverSource(src, d);
  assert.equal(r.found, false);
  assert.equal(d.saw.moved.length, 0);
});

// ─── telling a person ────────────────────────────────────────────────────────

test('a lost page is reported ONCE: an operations finding, a policy finding and a Telegram line', async () => {
  const d = deps();
  const src = { id: 5, providerKey: 'groq', url: 'https://groq.com/terms-of-use', kind: 'terms', consecutiveFailures: LOST_AFTER_FAILURES, lostReportedAt: null };
  const r = await reportLostSource(src, { error: 'HTTP 404' }, d);
  assert.equal(r.reported, true);
  assert.equal(d.saw.opFindings[0].checkKey, 'ai.policy_source_lost');
  assert.equal(d.saw.opFindings[0].subjectId, 5);
  assert.equal(d.saw.opFindings[0].tier, 'warning');
  assert.match(d.saw.findings[0].summary, /can no longer find Groq's terms page/i);
  assert.match(d.saw.findings[0].summary, /no replacement was found/i);
  assert.equal(d.saw.alerts.length, 1);
  assert.deepEqual(d.saw.lost, [5]);

  const again = await reportLostSource({ ...src, lostReportedAt: new Date() }, { error: 'HTTP 404' }, d);
  assert.equal(again.reported, false, 'already told; telling again every check trains people to ignore it');
  assert.equal(d.saw.alerts.length, 1);
});
