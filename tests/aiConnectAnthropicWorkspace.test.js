'use strict';

/**
 * Connecting Claude with an ORGANIZATION-level key (October 2026): Anthropic
 * answers "400 This API key is not scoped to a workspace, so this request must
 * include the anthropic-workspace-id header". Connect says what to do in words,
 * and with the Workspace ID typed in it connects and remembers it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { connectProvider } = require('../services/ai/discovery/connectProvider');
const { normaliseModel } = require('../lib/ai/modelSelection');

const NOT_SCOPED = '400 This API key is not scoped to a workspace, so this request must include the '
  + 'anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace.';

function deps({ listImpl }) {
  const saw = { upserts: [], lists: [], calls: [] };
  return {
    saw,
    listModels: async (args) => { saw.lists.push(args); return listImpl(args); },
    callOpenAiChat: async () => ({ text: 'ok' }),
    callGeminiGenerate: async () => ({ text: 'ok' }),
    callAnthropicMessages: async (args) => { saw.calls.push(args); return { text: 'ok' }; },
    aiProviders: {
      async getProviderSecretsByKey() { return null; },
      async nextPriority() { return 40; },
      async upsertProvider(key, patch) { saw.upserts.push({ key, ...patch }); return { providerKey: key }; },
      async saveDiscoveredModels() {},
    },
    aiSettings: { async getAiSettings() { return { freeOnlyMode: false }; } },
    aiPolicy: { async addSource(s) { return s; } },
    modelEvents: { async recordModelEvent(e) { return e; } },
    invalidateRegistry() {},
  };
}

const claudeModels = ['claude-haiku-5-5', 'claude-sonnet-5-5']
  .map((id) => normaliseModel({ id }, 'anthropic', 'anthropic'));

test('without the Workspace ID, Connect says exactly what to paste and where to find it', async () => {
  const d = deps({ listImpl: async () => { throw Object.assign(new Error(NOT_SCOPED), { status: 400 }); } });
  const r = await connectProvider({ catalogKey: 'anthropic', apiKey: 'sk-ant-org' }, d);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'needs_workspace');
  assert.match(r.message, /Workspace ID/);
  assert.match(r.message, /wrkspc_/);
  assert.equal(d.saw.upserts.length, 0);
});

test('WITH THE WORKSPACE ID IT CONNECTS: listing, the test call and the saved row all carry it', async () => {
  const d = deps({ listImpl: async () => claudeModels });
  const r = await connectProvider({ catalogKey: 'anthropic', apiKey: 'sk-ant-org', workspaceId: ' wrkspc_01ABC ' }, d);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(d.saw.lists[0].workspaceId, 'wrkspc_01ABC');
  assert.equal(d.saw.calls[0].workspaceId, 'wrkspc_01ABC');
  assert.equal(d.saw.upserts[0].workspaceId, 'wrkspc_01ABC');
});

test('something that is not a workspace id is refused before any request', async () => {
  const d = deps({ listImpl: async () => claudeModels });
  const r = await connectProvider({ catalogKey: 'anthropic', apiKey: 'k', workspaceId: 'my workspace' }, d);
  assert.equal(r.reason, 'bad_workspace');
  assert.equal(d.saw.lists.length, 0);
});

test('a workspace id typed for another provider is ignored', async () => {
  const d = deps({ listImpl: async () => [normaliseModel({ id: 'llama-3.3-70b-versatile' }, 'openai_chat', 'groq')] });
  await connectProvider({ catalogKey: 'groq', apiKey: 'gsk_x', workspaceId: 'wrkspc_01ABC' }, d);
  assert.equal(d.saw.lists[0].workspaceId, null);
  assert.equal('workspaceId' in d.saw.upserts[0], false);
});
