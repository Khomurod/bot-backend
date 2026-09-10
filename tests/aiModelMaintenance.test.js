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
  runModelMaintenance, describeModelChange, nextMaintenanceDueAt, createVerificationRequester,
} = require('../services/ai/discovery/modelMaintenance');

function deps({ providers, refreshResults = {}, settings = {} } = {}) {
  const saw = { refreshed: [], findings: [], alerts: [] };
  return {
    saw,
    aiProviders: {
      async listProvidersForAdmin() {
        return providers || [
          { providerKey: 'groq', label: 'Groq', enabled: true, apiKeySet: true, baseUrl: 'https://api.groq.com/openai/v1', catalogKey: 'groq' },
          { providerKey: 'gemini', label: 'Google Gemini', enabled: true, apiKeySet: true, baseUrl: null, catalogKey: 'gemini' },
          { providerKey: 'off', label: 'Off', enabled: false, apiKeySet: true },
          { providerKey: 'nokey', label: 'No key', enabled: true, apiKeySet: false },
        ];
      },
    },
    async refreshProviderModels(key, opts) {
      saw.refreshed.push({ key, ...opts });
      return refreshResults[key] || { ok: true, providerKey: key, changed: false, retired: [], added: [], kept: ['x'], chain: ['x'], modelsFound: 3 };
    },
    aiPolicy: {
      async getWatcherSettings() {
        return { enabled: true, notifyEnabled: true, notifyChatId: '-1001', notifyMinSeverity: 'info', ...settings };
      },
    },
    findingsStore: {
      async insertFinding(f) { saw.findings.push(f); return { id: saw.findings.length, ...f }; },
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
