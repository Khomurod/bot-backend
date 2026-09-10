/**
 * The watcher end to end, with no network and no model.
 *
 * The pure gate is tested in `aiPolicyDiff.test.js`. What is tested HERE is that
 * the service actually honours it — that the stages really do short-circuit in
 * order, and that the expensive one is reached only last. A gate nothing routes
 * through is not a gate.
 *
 * Both injectable seams are used: `fetchImpl` so nothing leaves the machine,
 * and `readImpl` so a model is never called — and, in the first two tests, so
 * that calling one would be a visible failure.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const WATCHER = path.resolve(__dirname, '../services/ai/policy/policyWatcher.js');
const POLICY_STORE = path.resolve(__dirname, '../database/aiPolicy.js');
const FINDINGS_STORE = path.resolve(__dirname, '../database/aiPolicyFindings.js');
const PROVIDERS = path.resolve(__dirname, '../database/aiProviders.js');
const AI_SETTINGS = path.resolve(__dirname, '../database/aiSettings.js');

const PAGE = (body, { year = 2026, updated = '4 March 2026', build = 'a1b2c3d4e5f60718' } = {}) => `
  <html><head><script>t()</script></head><body>
    <nav><a href="/">Home</a></nav>
    <main>${body}</main>
    <footer>© ${year} Example. Last updated: ${updated}</footer>
    <script src="/a.js?v=${build}"></script>
  </body></html>`;

const BASE_BODY = '<p>You may use the API for commercial purposes.</p>'
  + '<p>Free tier: 1,000 requests per day.</p>';

function load({
  sources, settings = {}, freeOnlyMode = true, aiEnabled = true, rediscover = null,
} = {}) {
  delete require.cache[require.resolve(WATCHER)];

  const saw = {
    findings: [], alerts: [], snapshots: [], cooled: [], runs: [], reads: 0,
  };

  require.cache[POLICY_STORE] = {
    exports: {
      async getWatcherSettings() {
        return {
          enabled: true, notifyEnabled: true, notifyChatId: '-1001234567890',
          notifyMinSeverity: 'warning', autoSuspendEnabled: false, ...settings,
        };
      },
      async listSourcesToCheck() { return sources; },
      async saveSnapshot(id, patch) { saw.snapshots.push({ id, ...patch }); },
      async recordRun(summary) { saw.runs.push(summary); },
    },
  };
  require.cache[FINDINGS_STORE] = {
    exports: {
      async insertFinding(f) { saw.findings.push(f); return { id: saw.findings.length, ...f }; },
      async enqueueAlert(a) { saw.alerts.push(a); return a; },
      meetsSeverityThreshold: (severity, min) => (
        ({ info: 0, warning: 1, serious: 2 })[severity] >= ({ info: 0, warning: 1, serious: 2 })[min]
      ),
    },
  };
  require.cache[PROVIDERS] = {
    exports: {
      async recordFailure(key, args) { saw.cooled.push({ key, ...args }); },
      async listProvidersForAdmin() { return [{ providerKey: 'groq', enabled: true, catalogKey: 'groq' }]; },
    },
  };
  // Discovery is a collaborator with its own tests; here only WHAT the watcher
  // asks of it is under test.
  saw.discovery = { seeded: 0, redirects: [], rediscovered: [], lost: [], cleared: [], reconciled: 0 };
  require.cache[path.resolve(__dirname, '../services/ai/policy/sourceDiscovery.js')] = {
    exports: {
      LOST_AFTER_FAILURES: 3,
      async ensureCatalogSources() { saw.discovery.seeded += 1; return { seeded: 0 }; },
      async handleRedirect(src, to) { saw.discovery.redirects.push({ id: src.id, to }); return { moved: true, url: to }; },
      async rediscoverSource(src) {
        saw.discovery.rediscovered.push(src.id);
        return rediscover ? rediscover(src) : { found: false };
      },
      async reportLostSource(src, info) { saw.discovery.lost.push({ id: src.id, ...info }); return { reported: true }; },
      async clearLostSource(src) { saw.discovery.cleared.push(src.id); return true; },
      async reconcileLostFindings() { saw.discovery.reconciled += 1; return 0; },
    },
  };
  require.cache[AI_SETTINGS] = {
    exports: { async getAiSettings() { return { enabled: aiEnabled, freeOnlyMode }; } },
  };

  const { runPolicyCheck } = require(WATCHER);
  return { runPolicyCheck, saw };
}

/** A fetch that answers from a script, recording what was asked for. */
function scriptedFetch(script) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, headers: options?.headers || {} });
    const entry = typeof script === 'function' ? script(url, options) : script;
    return {
      status: entry.status ?? 200,
      ok: (entry.status ?? 200) < 400,
      url: entry.url ?? String(url),
      headers: { get: (h) => entry.headers?.[h.toLowerCase()] ?? null },
      text: async () => entry.body ?? '',
    };
  };
  impl.calls = calls;
  return impl;
}

/** A reader that must not be called. */
const forbiddenReader = () => {
  throw new Error('a model was called for a change that never got past the gate');
};

const source = (over = {}) => ({
  id: 1, providerKey: 'groq', url: 'https://example.invalid/terms', kind: 'terms',
  enabled: true, etag: null, lastModified: null, contentHash: null,
  normalisedText: null, ...over,
});

// ─── the stages really do short-circuit ──────────────────────────────────────

test('a 304 ends the check before anything is parsed', async () => {
  const { runPolicyCheck, saw } = load({
    sources: [source({ etag: 'W/"v1"', contentHash: 'abc', normalisedText: 'old text' })],
  });
  const fetchImpl = scriptedFetch({ status: 304, headers: { etag: 'W/"v1"' } });

  const summary = await runPolicyCheck({ fetchImpl, readImpl: forbiddenReader });

  assert.equal(summary.notModified, 1);
  assert.equal(saw.findings.length, 0);
  assert.equal(fetchImpl.calls[0].headers['If-None-Match'], 'W/"v1"',
    'the conditional header is what makes this free');
});

test('a formatting-only re-render produces no finding and no model call', async () => {
  const { normalisePolicyText } = require('../lib/ai/policyText');
  const stored = normalisePolicyText(PAGE(BASE_BODY));
  const { runPolicyCheck, saw } = load({
    sources: [source({ normalisedText: stored, contentHash: 'stale-hash-so-we-diff' })],
  });
  // Same terms; new copyright year, new "last updated", new build hash, new nav.
  const fetchImpl = scriptedFetch({
    status: 200,
    body: PAGE(BASE_BODY, { year: 2027, updated: '11 September 2026', build: 'ffffffffffffffff' }),
  });

  const summary = await runPolicyCheck({ fetchImpl, readImpl: forbiddenReader });

  assert.equal(summary.unchanged, 1);
  assert.equal(saw.findings.length, 0, 'zero findings');
  assert.equal(saw.alerts.length, 0, 'zero alerts');
  // The forbidden reader not throwing IS the zero-AI-calls assertion.
});

test('an immaterial change is recorded but not alerted, and still no model', async () => {
  const { normalisePolicyText } = require('../lib/ai/policyText');
  const stored = normalisePolicyText('<p>Contact support at help@example.com.</p>');
  const { runPolicyCheck, saw } = load({
    sources: [source({ normalisedText: stored, contentHash: 'x' })],
  });
  const fetchImpl = scriptedFetch({
    status: 200, body: '<p>Contact our team at help@example.com.</p>',
  });

  const summary = await runPolicyCheck({ fetchImpl, readImpl: forbiddenReader });

  assert.equal(summary.immaterial, 1);
  assert.equal(saw.findings.length, 0);
  const [snapshot] = saw.snapshots;
  assert.ok(snapshot.normalisedText,
    'the new text is stored anyway, or this same change is re-judged every run forever');
});

// ─── and a real change gets all the way through ──────────────────────────────

test('a material change reaches the model, files a finding and queues an alert', async () => {
  const { normalisePolicyText } = require('../lib/ai/policyText');
  const stored = normalisePolicyText('<p>We process requests to return a response.</p>');
  const { runPolicyCheck, saw } = load({
    sources: [source({ normalisedText: stored, contentHash: 'x' })],
  });
  const fetchImpl = scriptedFetch({
    status: 200,
    body: '<p>We process requests to return a response.</p>'
      + '<p>We may use your submissions to train our models.</p>',
  });
  let sawPassages = null;
  const readImpl = async ({ userText }) => {
    sawPassages = userText;
    return {
      parsed: {
        category: 'trains_on_data', severity: 'serious',
        summary: 'They will now train on what we send.',
        whatChanged: 'A training clause was added.', whyItMatters: 'Driver text would be retained.',
      },
      model: 'test-model',
    };
  };

  const summary = await runPolicyCheck({ fetchImpl, readImpl });

  assert.equal(summary.findings, 1);
  const [finding] = saw.findings;
  assert.equal(finding.category, 'trains_on_data');
  assert.equal(finding.aiAssisted, true);
  assert.deepEqual(finding.detectedTopics, ['trains_on_data']);
  assert.match(finding.quotedPassage, /train our models/);
  assert.equal(saw.alerts.length, 1);

  assert.match(sawPassages, /train our models/);
  assert.equal(sawPassages.includes('process requests to return a response'), false,
    'the model sees the changed passages ALONE, never the document');
});

test('with no model available the finding is still written, marked unassisted', async () => {
  const { normalisePolicyText } = require('../lib/ai/policyText');
  const { runPolicyCheck, saw } = load({
    sources: [source({ normalisedText: normalisePolicyText('<p>Old clause.</p>'), contentHash: 'x' })],
  });
  const fetchImpl = scriptedFetch({
    status: 200, body: '<p>The API is for non-commercial use only.</p>',
  });
  const readImpl = async () => { throw new Error('every provider is cooled'); };

  const summary = await runPolicyCheck({ fetchImpl, readImpl });

  assert.equal(summary.findings, 1);
  assert.equal(saw.findings[0].aiAssisted, false,
    'a watcher that goes silent when AI is unhealthy is worst exactly when it is needed');
  assert.match(saw.findings[0].quotedPassage, /non-commercial use only/);
});

// ─── suspension ──────────────────────────────────────────────────────────────

test('a matched rule suspends by cooling the provider, never by disabling it', async () => {
  const { normalisePolicyText } = require('../lib/ai/policyText');
  const { runPolicyCheck, saw } = load({
    settings: { autoSuspendEnabled: true },
    sources: [source({
      normalisedText: normalisePolicyText('<p>You may use the API for commercial purposes.</p>'),
      contentHash: 'x',
    })],
  });
  const fetchImpl = scriptedFetch({
    status: 200, body: '<p>The API is for non-commercial use only.</p>',
  });
  const readImpl = async () => ({
    parsed: { category: 'commercial_use', severity: 'info', summary: 'Changed.' },
    model: 'm',
  });

  await runPolicyCheck({ fetchImpl, readImpl });

  assert.equal(saw.findings[0].suspendedProvider, true);
  assert.equal(saw.findings[0].suspensionRule, 'commercial_use_withdrawn');
  assert.equal(saw.findings[0].severity, 'serious',
    'a matched rule is serious by rule — the model said "info" and does not get to lower it');
  assert.equal(saw.cooled.length, 1);
  assert.equal(saw.cooled[0].cooldown.until, 'indefinite');
  assert.match(saw.cooled[0].cooldown.reason, /non-commercial use only/,
    'the cooldown reason quotes the provider back to itself');
});

test('with auto-suspend off, a matched rule alerts and changes nothing', async () => {
  const { normalisePolicyText } = require('../lib/ai/policyText');
  const { runPolicyCheck, saw } = load({
    settings: { autoSuspendEnabled: false },
    sources: [source({
      normalisedText: normalisePolicyText('<p>You may use the API for commercial purposes.</p>'),
      contentHash: 'x',
    })],
  });
  const fetchImpl = scriptedFetch({
    status: 200, body: '<p>The API is for non-commercial use only.</p>',
  });
  const readImpl = async () => ({ parsed: { summary: 'Changed.' }, model: 'm' });

  await runPolicyCheck({ fetchImpl, readImpl });

  assert.equal(saw.findings[0].suspendedProvider, false);
  assert.deepEqual(saw.cooled, [], 'the operator said do not act');
  assert.equal(saw.alerts.length, 1, 'but they are still told');
});

// ─── robustness ──────────────────────────────────────────────────────────────

test('an unreachable page is not a finding', async () => {
  const { runPolicyCheck, saw } = load({ sources: [source({ contentHash: 'x' })] });
  const fetchImpl = scriptedFetch({ status: 503, body: '' });

  const summary = await runPolicyCheck({ fetchImpl, readImpl: forbiddenReader });

  assert.equal(summary.errors, 1);
  assert.equal(saw.findings.length, 0,
    'a page briefly unreachable says nothing about the terms');
  assert.match(saw.snapshots[0].error, /503/);
});

test('one bad source does not cost the rest of the run', async () => {
  const { runPolicyCheck, saw } = load({
    sources: [
      source({ id: 1, url: 'https://a.invalid/t' }),
      source({ id: 2, url: 'https://b.invalid/t' }),
    ],
  });
  const fetchImpl = scriptedFetch((url) => (
    url.includes('a.invalid') ? { status: 500 } : { status: 200, body: '<p>Fine.</p>' }
  ));

  const summary = await runPolicyCheck({ fetchImpl, readImpl: forbiddenReader });

  assert.equal(summary.sources, 2);
  assert.equal(summary.errors, 1);
  assert.equal(summary.baseline, 1, 'the second source was still checked');
  assert.equal(saw.runs.length, 1, 'and the run was recorded');
});

test('the watcher being off means no fetch at all', async () => {
  const { runPolicyCheck } = load({ settings: { enabled: false }, sources: [source()] });
  const fetchImpl = scriptedFetch({ status: 200, body: '<p>x</p>' });

  const result = await runPolicyCheck({ fetchImpl, readImpl: forbiddenReader });

  assert.equal(result.skipped, true);
  assert.deepEqual(fetchImpl.calls, []);
});

test('the first sight of a page is a baseline, not an alert', async () => {
  const { runPolicyCheck, saw } = load({ sources: [source({ normalisedText: null })] });
  const fetchImpl = scriptedFetch({ status: 200, body: PAGE(BASE_BODY) });

  const summary = await runPolicyCheck({ fetchImpl, readImpl: forbiddenReader });

  assert.equal(summary.baseline, 1);
  assert.equal(saw.findings.length, 0,
    'otherwise switching this on fires once per provider on day one');
  assert.ok(saw.snapshots[0].normalisedText, 'and the baseline is stored');
});


// ─── pages that move, and pages that vanish ──────────────────────────────────

test('every run seeds the catalogue pages first, so a newly enabled provider is watched without a person', async () => {
  const { runPolicyCheck, saw } = load({ sources: [] });
  const summary = await runPolicyCheck({ fetchImpl: scriptedFetch({ status: 304 }), readImpl: forbiddenReader });
  assert.equal(saw.discovery.seeded, 1);
  assert.equal(summary.sources, 0);
  assert.equal(saw.discovery.reconciled, 1, 'the Needs Attention list is kept honest every run');
});

test('a fetch that landed on another address is a move, handed to discovery', async () => {
  const { runPolicyCheck, saw } = load({ sources: [source({ url: 'https://example.invalid/terms' })] });
  const fetchImpl = scriptedFetch({ status: 200, body: PAGE(BASE_BODY), url: 'https://example.invalid/legal/terms' });
  await runPolicyCheck({ fetchImpl, readImpl: forbiddenReader });
  assert.deepEqual(saw.discovery.redirects, [{ id: 1, to: 'https://example.invalid/legal/terms' }]);
});

test('a page that answers where it always did is not a redirect', async () => {
  const { runPolicyCheck, saw } = load({ sources: [source()] });
  await runPolicyCheck({ fetchImpl: scriptedFetch({ status: 200, body: PAGE(BASE_BODY) }), readImpl: forbiddenReader });
  assert.equal(saw.discovery.redirects.length, 0);
});

test('a 404 asks discovery to find the page again, and a found page counts as moved', async () => {
  const { runPolicyCheck, saw } = load({
    sources: [source({ consecutiveFailures: 0 })],
    rediscover: () => ({ found: true, url: 'https://example.invalid/new-terms', how: 'site_scan' }),
  });
  const summary = await runPolicyCheck({ fetchImpl: scriptedFetch({ status: 404 }), readImpl: forbiddenReader });
  assert.deepEqual(saw.discovery.rediscovered, [1]);
  assert.equal(summary.moved, 1);
  assert.equal(saw.discovery.lost.length, 0, 'found, so nobody needs telling');
});

test('a page that keeps failing and cannot be found is reported lost — after the threshold, not before', async () => {
  const early = load({ sources: [source({ consecutiveFailures: 0 })] });
  let summary = await early.runPolicyCheck({ fetchImpl: scriptedFetch({ status: 404 }), readImpl: forbiddenReader });
  assert.equal(summary.errors, 1);
  assert.equal(early.saw.discovery.lost.length, 0, 'one bad fetch is not a lost page');

  const late = load({ sources: [source({ consecutiveFailures: 2 })] });
  summary = await late.runPolicyCheck({ fetchImpl: scriptedFetch({ status: 404 }), readImpl: forbiddenReader });
  assert.equal(summary.lost, 1);
  assert.equal(late.saw.discovery.lost[0].id, 1);
  assert.match(late.saw.discovery.lost[0].error, /404/);
});

test('a transient failure below the threshold does not go looking for a new page', async () => {
  const { runPolicyCheck, saw } = load({ sources: [source({ consecutiveFailures: 0 })] });
  await runPolicyCheck({ fetchImpl: scriptedFetch({ status: 503 }), readImpl: forbiddenReader });
  assert.equal(saw.discovery.rediscovered.length, 0, 'a 503 says the page is busy, not gone');
});

test('a page reported lost that answers again is cleared', async () => {
  const { runPolicyCheck, saw } = load({ sources: [source({ lostReportedAt: new Date(), contentHash: 'x', normalisedText: 'old' })] });
  await runPolicyCheck({ fetchImpl: scriptedFetch({ status: 304 }), readImpl: forbiddenReader });
  assert.deepEqual(saw.discovery.cleared, [1]);
});
