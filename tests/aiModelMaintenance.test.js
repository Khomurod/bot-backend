/**
 * The maintenance job: models are kept current, and a retirement is TOLD, in
 * words, to a person — the "Groq retired Model A; Wenze switched to Model B; no
 * features were interrupted" line from the brief.
 *
 * Everything is injected. The assertions are about what was written and what
 * was said, because a chain that changed overnight with no record and no
 * message would be the exact "nothing told a human" failure this project is
 * about.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runModelMaintenance, verifyProvider, describeModelChange, nextMaintenanceDueAt, createVerificationRequester,
} = require('../services/ai/discovery/modelMaintenance');

/**
 * The notification is driven by `ai_model_events` rows that have not been
 * notified yet, so this stub keeps a little event store: a refresh that retires
 * models records them, and the maintenance job later reads what is pending.
 */
function deps({
  providers, refreshResults = {}, settings = {}, pendingEvents = null, insertFails = false,
} = {}) {
  const saw = { refreshed: [], findings: [], alerts: [], events: [], notified: [] };
  const store = pendingEvents ? [...pendingEvents] : [];
  return {
    saw, store,
    aiProviders: {
      async listProvidersForAdmin() {
        return providers || [
          { providerKey: 'groq', label: 'Groq', enabled: true, apiKeySet: true, baseUrl: 'https://api.groq.com/openai/v1', catalogKey: 'groq', discoveredModels: [] },
          { providerKey: 'gemini', label: 'Google Gemini', enabled: true, apiKeySet: true, baseUrl: null, catalogKey: 'gemini', discoveredModels: [] },
          { providerKey: 'off', label: 'Off', enabled: false, apiKeySet: true },
          { providerKey: 'nokey', label: 'No key', enabled: true, apiKeySet: false },
        ];
      },
    },
    modelEvents: {
      async recordModelEvent(e) {
        const row = { id: saw.events.length + 1, notifiedAt: null, ...e };
        saw.events.push(row);
        if (e.event === 'retired') store.push(row);
        return row;
      },
      async listUnnotifiedRetirements(providerKey) {
        return store.filter((e) => e.providerKey === providerKey && e.event === 'retired' && !e.notifiedAt);
      },
      async markEventsNotified(ids) {
        saw.notified.push(...ids);
        for (const e of store) if (ids.includes(e.id)) e.notifiedAt = new Date();
      },
    },
    async refreshProviderModels(key, opts) {
      saw.refreshed.push({ key, ...opts });
      const r = refreshResults[key] || { ok: true, providerKey: key, changed: false, retired: [], added: [], kept: ['x'], chain: ['x'], modelsFound: 3, listed: ['x'] };
      // The real refresh writes a `retired` event per retired model.
      for (const m of r.retired || []) {
        store.push({ id: store.length + 1000, providerKey: key, model: m, event: 'retired', notifiedAt: null,
          detail: { replacement: (r.added || [])[(r.retired || []).indexOf(m)] || null } });
      }
      return r;
    },
    aiPolicy: {
      async getWatcherSettings() {
        return { enabled: true, notifyEnabled: true, notifyChatId: '-1001', notifyMinSeverity: 'info', ...settings };
      },
    },
    findingsStore: {
      async insertFinding(f) {
        if (insertFails) throw new Error('database went away');
        saw.findings.push(f); return { id: saw.findings.length, ...f };
      },
      async enqueueAlert(a) { saw.alerts.push(a); return a; },
      meetsSeverityThreshold: (severity, min) => (
        ({ info: 0, warning: 1, serious: 2 })[severity] >= ({ info: 0, warning: 1, serious: 2 })[min]
      ),
    },
  };
}

test('only enabled providers with a key are refreshed', async () => {
  const d = deps();
  const summary = await runModelMaintenance({}, d);
  assert.deepEqual(d.saw.refreshed.map((r) => r.key), ['groq', 'gemini']);
  assert.equal(d.saw.refreshed[0].initiator, 'refresh');
  assert.equal(summary.checked, 2);
  assert.equal(d.saw.findings.length, 0, 'nothing changed, so nobody is told anything');
});

test('a retired model with a replacement is an INFO finding, told in plain words', async () => {
  const d = deps({
    refreshResults: {
      groq: {
        ok: true, providerKey: 'groq', changed: true, modelsFound: 9,
        retired: ['mixtral-8x7b-32768'], added: ['openai/gpt-oss-20b'],
        kept: ['llama-3.3-70b-versatile'], chain: ['llama-3.3-70b-versatile', 'openai/gpt-oss-20b'],
      },
    },
  });
  const summary = await runModelMaintenance({}, d);
  assert.equal(summary.retired, 1);

  const [finding] = d.saw.findings;
  assert.equal(finding.providerKey, 'groq');
  assert.equal(finding.category, 'discontinuation');
  assert.equal(finding.severity, 'info');
  assert.equal(finding.aiAssisted, false);
  assert.match(finding.summary, /Groq retired one of Wenze's models \(mixtral-8x7b-32768\)\./);
  assert.match(finding.summary, /Wenze automatically switched to openai\/gpt-oss-20b\./);
  assert.match(finding.summary, /No Wenze features were interrupted\./);
  assert.match(finding.sourceUrl, /^https:\/\//, 'the official page to check');

  assert.equal(d.saw.alerts.length, 1);
  assert.equal(d.saw.alerts[0].chatId, '-1001');
  assert.match(d.saw.alerts[0].body, /retired one of Wenze's models/);
  assert.doesNotMatch(d.saw.alerts[0].body, /No AI provider was available/,
    'a rule did this; saying a model could not summarise it would be untrue');
});

test('a provider left with NO usable model is SERIOUS and says other providers continue', async () => {
  const d = deps({
    refreshResults: {
      gemini: {
        ok: true, providerKey: 'gemini', changed: true, modelsFound: 2,
        retired: ['gemini-1.5-flash', 'gemini-1.5-pro'], added: [], kept: [], chain: [],
      },
    },
  });
  await runModelMaintenance({}, d);
  const [finding] = d.saw.findings;
  assert.equal(finding.severity, 'serious');
  assert.match(finding.summary, /retired every model Wenze was using/);
  assert.match(finding.summary, /other providers continue/i);
});

test('notifications respect the configured destination and threshold', async () => {
  const retired = {
    groq: { ok: true, providerKey: 'groq', changed: true, retired: ['a'], added: ['b'], kept: [], chain: ['b'], modelsFound: 1 },
  };
  const off = deps({ refreshResults: retired, settings: { notifyEnabled: false } });
  await runModelMaintenance({}, off);
  assert.equal(off.saw.findings.length, 1, 'the record is kept regardless');
  assert.equal(off.saw.alerts.length, 0);

  const strict = deps({ refreshResults: retired, settings: { notifyMinSeverity: 'warning' } });
  await runModelMaintenance({}, strict);
  assert.equal(strict.saw.alerts.length, 0, 'an info-level change is below a warning threshold');
});

test('a refresh that failed is counted and never becomes a finding', async () => {
  const d = deps({ refreshResults: { groq: { ok: false, providerKey: 'groq', error: '503 Service Unavailable' } } });
  const summary = await runModelMaintenance({}, d);
  assert.equal(summary.errors, 1);
  assert.equal(d.saw.findings.length, 0, 'a failed listing is not evidence of a retirement');
});

test('describeModelChange names retired models, the replacement and the new order', () => {
  const text = describeModelChange('Cerebras', {
    retired: ['llama3.1-8b'], added: ['llama-3.3-70b'], chain: ['qwen-3-32b', 'llama-3.3-70b'],
  });
  assert.match(text.summary, /Cerebras retired one of Wenze's models \(llama3\.1-8b\)/);
  assert.match(text.whatChanged, /Retired: llama3\.1-8b/);
  assert.match(text.whatChanged, /Now using: qwen-3-32b → llama-3\.3-70b/);
  assert.ok(text.whyItMatters.length > 20);
});

test('the daily run is due at 06:00 UTC, tomorrow if today\'s has passed', () => {
  const before = new Date('2026-09-10T05:59:00Z');
  const after = new Date('2026-09-10T06:01:00Z');
  assert.equal(new Date(nextMaintenanceDueAt(before)).toISOString(), '2026-09-10T06:00:00.000Z');
  assert.equal(new Date(nextMaintenanceDueAt(after)).toISOString(), '2026-09-11T06:00:00.000Z');
});

test('a router refusal asks for ONE verification per provider, debounced', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const verified = [];
  const request = createVerificationRequester({
    verify: async (key) => { verified.push(key); }, debounceMs: 1000,
  });
  request('groq'); request('groq'); request('groq'); request('gemini');
  assert.deepEqual(verified, [], 'nothing runs immediately — a burst of 404s is one event');
  t.mock.timers.tick(1000);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(verified.sort(), ['gemini', 'groq']);
});


// ─── the three review findings ───────────────────────────────────────────────

test('a caller\'s preferred model the provider no longer lists is retired and reported', async () => {
  // preferModels live in the caller, not the chain; a chain refresh cannot see
  // them. The router's refusal names the model; the listing proves it is gone.
  const d = deps({
    providers: [{ providerKey: 'groq', label: 'Groq', enabled: true, apiKeySet: true, catalogKey: 'groq',
      discoveredModels: [{ id: 'llama-3.1-70b-versatile' }, { id: 'llama-3.3-70b-versatile' }] }],
    refreshResults: { groq: { ok: true, providerKey: 'groq', changed: false, retired: [], added: [], kept: ['llama-3.3-70b-versatile'],
      chain: ['llama-3.3-70b-versatile'], modelsFound: 1, listed: ['llama-3.3-70b-versatile'] } },
  });
  const [provider] = await d.aiProviders.listProvidersForAdmin();
  await verifyProvider(provider, { initiator: 'router', models: ['llama-3.1-70b-versatile'] }, d);

  const ev = d.saw.events.find((e) => e.event === 'retired' && e.model === 'llama-3.1-70b-versatile');
  assert.ok(ev, 'the vanished preference is recorded as retired');
  assert.equal(ev.initiator, 'router');
  assert.equal(ev.detail.source, 'capability_preference');
  assert.equal(d.saw.findings.length, 1);
  assert.match(d.saw.findings[0].summary, /llama-3\.1-70b-versatile/);
});

test('a preference the listing never had is not reported twice', async () => {
  const d = deps({
    providers: [{ providerKey: 'groq', label: 'Groq', enabled: true, apiKeySet: true, catalogKey: 'groq',
      discoveredModels: [{ id: 'a' }] }],
    refreshResults: { groq: { ok: true, providerKey: 'groq', changed: false, retired: [], added: [], kept: ['a'], chain: ['a'], modelsFound: 1, listed: ['a'] } },
  });
  const [provider] = await d.aiProviders.listProvidersForAdmin();
  await verifyProvider(provider, { initiator: 'router', models: ['never-listed'] }, d);
  assert.equal(d.saw.events.filter((e) => e.event === 'retired').length, 0,
    'the previous listing did not have it either — it was already known to be absent');
});

test('the notice is driven by unnotified events, so a failed write is retried next pass', async () => {
  const failing = deps({
    refreshResults: { groq: { ok: true, providerKey: 'groq', changed: true, retired: ['old'], added: ['new'], kept: [], chain: ['new'], modelsFound: 2, listed: ['new'] } },
    insertFails: true,
  });
  await runModelMaintenance({}, failing);
  assert.equal(failing.saw.notified.length, 0, 'nothing may be marked notified when the finding was never written');
  assert.equal(failing.store.filter((e) => !e.notifiedAt).length, 1, 'the retirement is still pending');

  // Next pass: the chain is already updated (nothing retired THIS time), yet the
  // pending event is still there — and now the write succeeds.
  const later = deps({ pendingEvents: failing.store });
  await runModelMaintenance({}, later);
  assert.equal(later.saw.findings.length, 1, 'told on the retry');
  assert.match(later.saw.findings[0].summary, /retired one of Wenze's models \(old\)/);
  assert.deepEqual(later.saw.notified, [failing.store[0].id]);
});

test('describeModelChange claims only replacements that are actually in the chain', () => {
  const text = describeModelChange('Groq', {
    retired: ['gone'], added: ['in-chain', 'truncated-out'], chain: ['k1', 'k2', 'k3', 'k4', 'in-chain'],
  });
  assert.match(text.summary, /switched to in-chain\./);
  assert.doesNotMatch(text.summary, /truncated-out/);
});

test('a router refusal carries the model, and a burst collapses into one verification per provider', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const verified = [];
  const request = createVerificationRequester({
    verify: async (key, models) => { verified.push([key, [...models].sort()]); }, debounceMs: 1000,
  });
  request('groq', 'm1'); request('groq', 'm2'); request('groq', 'm1');
  t.mock.timers.tick(1000);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(verified, [['groq', ['m1', 'm2']]]);
});
