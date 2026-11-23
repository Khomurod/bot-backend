'use strict';

/**
 * Which models may be shown a picture (lib/ai/vision.js), and what the models
 * listing keeps to say so (lib/ai/modelSelection.js `listingEntry`).
 *
 * 23 November 2026: from the 18th, truck photos went into the PDFs unchecked —
 * Claude's key was rejected, Gemini's credit spent — while OpenRouter's free
 * Gemma 4 and Nemotron omni, both in the chain, could read them. No name rule
 * knew them; OpenRouter's own listing said `input_modalities: ["image", …]`.
 * The provider's word is now evidence; a name nobody knows still is not.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isVisionModel, visionIdsOf, providerModelCanSee,
} = require('../lib/ai/vision');
const { normaliseModel, takesImages, listingEntry } = require('../lib/ai/modelSelection');

const openRouter = (id, inputModalities) => normaliseModel({
  id, architecture: { input_modalities: inputModalities, output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' },
}, 'openai_chat', 'openrouter');

test('the listing keeps `vision: true` only where the provider says the model takes a picture', () => {
  assert.equal(takesImages(openRouter('google/gemma-4-31b-it:free', ['image', 'text', 'video'])), true);
  assert.equal(takesImages(openRouter('nvidia/nemotron-3-ultra-550b-a55b:free', ['text'])), false);
  assert.equal(takesImages(normaliseModel({ id: 'claude-haiku-5-5' }, 'anthropic', 'anthropic')), null, 'not said is unknown');

  assert.deepEqual(listingEntry(openRouter('google/gemma-4-31b-it:free', ['image', 'text']), 'openrouter'), {
    id: 'google/gemma-4-31b-it:free', contextLength: null, chat: true, free: 'free', vision: true,
  });
  assert.equal('vision' in listingEntry(openRouter('x/text-only:free', ['text']), 'openrouter'), false);
});

test('a listed vision model can see; an unlisted unknown name still cannot', () => {
  assert.equal(isVisionModel('openai_chat', 'google/gemma-4-31b-it:free'), false, 'no name rule knows it');
  assert.equal(isVisionModel('openai_chat', 'google/gemma-4-31b-it:free', { listedVision: ['google/gemma-4-31b-it:free'] }), true);
  assert.equal(isVisionModel('openai_chat', 'google/gemma-4-31b-it:free', { listedVision: new Set(['google/gemma-4-31b-it:free']) }), true);
  assert.equal(isVisionModel('openai_chat', 'some/text-model', { listedVision: ['google/gemma-4-31b-it:free'] }), false);
  assert.equal(isVisionModel('openai_chat', 'meta-llama/llama-4-scout', { listedVision: [] }), true, 'the name rules still stand');
  assert.equal(isVisionModel('openai_chat', '', { listedVision: [''] }), false);
});

test('a provider row says what it can see: the router\'s ids, or the admin\'s stored listing', () => {
  assert.deepEqual(visionIdsOf([{ id: 'a', vision: true }, { id: 'b' }, { vision: true }, null, { id: 'c', vision: 'true' }]), ['a']);
  const roster = { adapter: 'openai_chat', discoveredVisionIds: ['g4'] };
  const admin = { adapter: 'openai_chat', discoveredModels: [{ id: 'g4', vision: true }, { id: 'n3' }] };
  assert.equal(providerModelCanSee(roster, 'g4'), true);
  assert.equal(providerModelCanSee(admin, 'g4'), true);
  assert.equal(providerModelCanSee(admin, 'n3'), false);
  assert.equal(providerModelCanSee({ adapter: 'anthropic' }, 'claude-haiku-5-5'), true);
  assert.equal(providerModelCanSee(null, 'g4'), false);
});
