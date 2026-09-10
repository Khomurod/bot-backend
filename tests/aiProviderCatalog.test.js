/**
 * The provider catalog and model selection — PURE, and the reason an operator
 * never types a Base URL or a model name for a provider Wenze already knows.
 *
 * Two properties are load-bearing:
 *
 *   EVERY KNOWN PROVIDER IS COMPLETE. A catalog entry missing its models path
 *   or its adapter would send Connect down the manual path for exactly the
 *   provider it was meant to automate — and it would pass every other test,
 *   because nothing else reads the entry until an operator clicks.
 *
 *   SELECTION REFUSES WHAT CANNOT CHAT. A `/models` listing carries embeddings,
 *   speech, moderation and image models beside the chat ones. Putting one of
 *   those at the head of a chain means every call fails with a request error
 *   before the first real model is tried.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CATALOG, listCatalog, getCatalogEntry, envKeyNameFor, keyLooksLike,
} = require('../lib/ai/providerCatalog');
const {
  normaliseModel, isChatCapable, freeStatusOf, selectModelChain, reconcileChain,
  MAX_CHAIN,
} = require('../lib/ai/modelSelection');

test('every catalogued provider carries what Connect needs', () => {
  for (const entry of Object.values(CATALOG)) {
    assert.match(entry.baseUrl, /^https:\/\//, `${entry.key}: base URL`);
    assert.ok(['openai_chat', 'gemini'].includes(entry.adapter), `${entry.key}: adapter`);
    assert.equal(entry.modelsPath, '/models', `${entry.key}: models path`);
    assert.match(entry.envKey, /^[A-Z_]+_API_KEY$/, `${entry.key}: env key`);
    assert.ok(entry.policySources.terms && entry.policySources.privacy,
      `${entry.key}: the terms watcher needs at least terms + privacy to seed`);
    for (const url of Object.values(entry.policySources)) assert.match(url, /^https:\/\//);
  }
});

test('custom is the one entry with no Base URL, and it is listed last', () => {
  const list = listCatalog();
  assert.equal(list[list.length - 1].key, 'custom');
  assert.equal(getCatalogEntry('custom').baseUrl, null);
  assert.equal(getCatalogEntry('CUSTOM').key, 'custom', 'case must not matter to a click');
  assert.equal(getCatalogEntry('nope'), null);
});

test('the env fallback is catalog-driven, so OpenRouter can inherit a variable too', () => {
  assert.equal(envKeyNameFor('groq'), 'GROQ_API_KEY');
  assert.equal(envKeyNameFor('openrouter'), 'OPENROUTER_API_KEY');
  assert.equal(envKeyNameFor('custom'), null);
});

test('a key pasted for the wrong provider is noticed, advisory only', () => {
  assert.equal(keyLooksLike(CATALOG.groq, 'gsk_abc'), true);
  assert.equal(keyLooksLike(CATALOG.groq, 'sk-or-abc'), false);
  assert.equal(keyLooksLike(CATALOG.mistral, 'anything'), true, 'no prefix known → never refuse');
});

// ─── selection ───────────────────────────────────────────────────────────────

const openai = (id, extra = {}) => ({ id, object: 'model', owned_by: 'x', ...extra });

test('non-chat models never reach a chain', () => {
  const rejected = [
    'whisper-large-v3', 'text-embedding-3-small', 'playai-tts', 'llama-guard-4-12b',
    'meta-llama/llama-prompt-guard-2-86m', 'omni-moderation-latest', 'dall-e-3',
    'stable-diffusion-xl', 'rerank-v3', 'nomic-embed-text',
  ];
  for (const id of rejected) {
    assert.equal(isChatCapable(normaliseModel(openai(id), 'openai_chat')), false, id);
  }
  assert.equal(isChatCapable(normaliseModel(openai('llama-3.3-70b-versatile'), 'openai_chat')), true);
});

test('Gemini selection honours supportedGenerationMethods, not the name', () => {
  const gen = (name, methods) => ({ name: `models/${name}`, displayName: name, supportedGenerationMethods: methods });
  const chat = normaliseModel(gen('gemini-2.5-flash', ['generateContent', 'countTokens']), 'gemini');
  const embed = normaliseModel(gen('gemini-embedding-001', ['embedContent']), 'gemini');
  const image = normaliseModel(gen('imagen-4.0-generate-001', ['predict']), 'gemini');
  assert.equal(chat.id, 'gemini-2.5-flash', 'the models/ prefix is stripped — the adapter adds it back');
  assert.equal(isChatCapable(chat), true);
  assert.equal(isChatCapable(embed), false);
  assert.equal(isChatCapable(image), false);
});

test('OpenRouter free status is read from pricing and the :free suffix', () => {
  const free = normaliseModel(openai('meta-llama/llama-3.3-70b-instruct:free', {
    pricing: { prompt: '0', completion: '0' }, context_length: 131072,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  }), 'openai_chat', 'openrouter');
  const paid = normaliseModel(openai('openai/gpt-4o', {
    pricing: { prompt: '0.0000025', completion: '0.00001' }, context_length: 128000,
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
  }), 'openai_chat', 'openrouter');
  assert.equal(freeStatusOf(free, 'openrouter'), 'free');
  assert.equal(freeStatusOf(paid, 'openrouter'), 'paid');
  assert.equal(freeStatusOf(normaliseModel(openai('llama-3.1-8b-instant'), 'openai_chat', 'groq'), 'groq'), 'free',
    'Groq publishes a free tier on every model');
  assert.equal(freeStatusOf(normaliseModel(openai('mistral-large-latest'), 'openai_chat', 'mistral'), 'mistral'), 'unknown',
    'when it is not reliably determinable, say so rather than guess');
});

test('selectModelChain prefers known-good chat families, caps the chain, and can be free-only', () => {
  const models = [
    'whisper-large-v3', 'llama-3.1-8b-instant', 'llama-3.3-70b-versatile',
    'openai/gpt-oss-120b', 'meta-llama/llama-4-scout-17b-16e-instruct', 'qwen/qwen3-32b',
    'moonshotai/kimi-k2-instruct', 'llama-guard-4-12b', 'allam-2-7b', 'compound-beta',
  ].map((id) => normaliseModel(openai(id), 'openai_chat', 'groq'));
  const chain = selectModelChain(models, { providerKey: 'groq' });
  assert.ok(chain.length <= MAX_CHAIN);
  assert.equal(chain[0], 'llama-3.3-70b-versatile', 'the strongest general model leads');
  assert.ok(chain.includes('llama-3.1-8b-instant'), 'a fast small model is kept for fallback');
  assert.equal(chain.includes('whisper-large-v3'), false);
  assert.equal(chain.includes('llama-guard-4-12b'), false);

  const orModels = [
    openai('openai/gpt-4o', { pricing: { prompt: '1', completion: '1' }, architecture: { output_modalities: ['text'] } }),
    openai('meta-llama/llama-3.3-70b-instruct:free', { pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } }),
    openai('google/gemma-3-27b-it:free', { pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } }),
  ].map((m) => normaliseModel(m, 'openai_chat', 'openrouter'));
  const freeOnly = selectModelChain(orModels, { providerKey: 'openrouter', freeOnly: true });
  assert.deepEqual(freeOnly.sort(), ['google/gemma-3-27b-it:free', 'meta-llama/llama-3.3-70b-instruct:free']);
});

test('reconcileChain says which configured models are gone, and offers replacements', () => {
  const discovered = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-20b']
    .map((id) => normaliseModel(openai(id), 'openai_chat', 'groq'));
  const r = reconcileChain(['llama-3.3-70b-versatile', 'mixtral-8x7b-32768', 'llama-3.1-8b-instant'], discovered, { providerKey: 'groq' });
  assert.deepEqual(r.retired, ['mixtral-8x7b-32768']);
  assert.deepEqual(r.kept, ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']);
  assert.ok(r.added.includes('openai/gpt-oss-20b'), 'a new usable model is proposed, not silently ignored');
  assert.equal(r.chain.includes('mixtral-8x7b-32768'), false, 'a retired model leaves the active chain');
  assert.equal(r.chain[0], 'llama-3.3-70b-versatile', 'the operator\'s order survives for what still exists');
});

test('an empty listing retires nothing — a failed discovery must not strip a working chain', () => {
  const r = reconcileChain(['a', 'b'], [], { providerKey: 'groq' });
  assert.deepEqual(r.retired, []);
  assert.deepEqual(r.chain, ['a', 'b']);
  assert.equal(r.unverified, true);
});

test('reconcileChain reports as added ONLY what made it into the chain', () => {
  // Four survivors leave one slot. Three usable newcomers exist; one is added.
  // Claiming all three were "added" would tell an operator Wenze switched to
  // models it never configured.
  const kept = ['k1', 'k2', 'k3', 'k4'];
  const discovered = [...kept, 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant']
    .map((id) => normaliseModel(openai(id), 'openai_chat', 'groq'));
  const r = reconcileChain([...kept, 'gone'], discovered, { providerKey: 'groq' });
  assert.deepEqual(r.retired, ['gone']);
  assert.equal(r.chain.length, MAX_CHAIN);
  assert.equal(r.added.length, 1, 'one slot, one addition');
  assert.ok(r.chain.includes(r.added[0]));
});
