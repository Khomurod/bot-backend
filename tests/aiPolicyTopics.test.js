/**
 * The watched topics decide what is MATERIAL: one sentence under a watched
 * topic outranks a page of reworded boilerplate. The brief names changes the
 * watcher must notice; each one needs a topic that catches its wording.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { topicsIn, WATCHED_TOPICS } = require('../lib/ai/policyText');

test('authentication changes are a watched topic', () => {
  assert.ok(topicsIn('From 1 March, API keys will be replaced by OAuth 2.0 tokens.').includes('authentication'));
  assert.ok(topicsIn('All requests must include a signed authentication header.').includes('authentication'));
});

test('pricing changes are a watched topic', () => {
  assert.ok(topicsIn('Usage beyond the allowance is billed per token at the rates below.').includes('pricing'));
  assert.ok(topicsIn('The API will become a paid service on 1 October.').includes('pricing'));
});

test('API behaviour changes are a watched topic', () => {
  assert.ok(topicsIn('This is a breaking change to the chat completions endpoint.').includes('api_change'));
  assert.ok(topicsIn('API version v1 will be removed; migrate to v2.').includes('api_change'));
});

test('a free tier being removed is caught by the free-tier topic', () => {
  assert.ok(topicsIn('The free tier is discontinued for new accounts.').includes('free_tier'));
});

test('every topic has a key, a label and at least two patterns', () => {
  for (const t of WATCHED_TOPICS) {
    assert.match(t.key, /^[a-z_]+$/);
    assert.ok(t.label.length > 5);
    assert.ok(t.patterns.length >= 2, t.key);
  }
});
