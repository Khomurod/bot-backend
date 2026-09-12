'use strict';

/**
 * The Dispatcher Board authenticates by query string, so every error message
 * that quotes the request is a credential in a log file. This is the boundary
 * that stops it, and the test that proves nothing gets past.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { stripUrls } = require('../lib/security/redactUrls');

const TOKEN = 'Sh4red-T0ken-ThatMustNeverAppear';

test('a URL carrying a token comes back with neither', () => {
  const out = stripUrls(
    `request to https://script.google.com/macros/s/AKfycbX/exec?token=${TOKEN} failed`
  );
  assert.ok(!out.includes(TOKEN), out);
  assert.ok(!out.includes('script.google.com'), out);
  assert.equal(out, 'request to <url> failed');
});

test('the host alone is removed too, not just the query string', () => {
  // A redacted host is still a hint about where the fleet's data lives, and
  // nothing downstream needs one — the settings row says which endpoint is set.
  const out = stripUrls('GET https://internal.example.com/board returned 500');
  assert.ok(!out.includes('internal.example.com'));
  assert.equal(out, 'GET <url> returned 500');
});

test('a credential pair that escaped without a URL is still caught', () => {
  for (const name of ['token', 'key', 'secret', 'password', 'api_key', 'access_token']) {
    const out = stripUrls(`refused (${name}=${TOKEN})`);
    assert.ok(!out.includes(TOKEN), `${name}: ${out}`);
    assert.match(out, new RegExp(`${name}=<redacted>`));
  }
});

test('protocol-relative and repeated URLs are all removed', () => {
  const out = stripUrls(`//a.example/x?token=${TOKEN} then https://b.example/y?token=${TOKEN}`);
  assert.ok(!out.includes(TOKEN), out);
  assert.equal(out, '<url> then <url>');
});

test('an Error is read for its message, and a nullish input is an empty string', () => {
  assert.equal(stripUrls(new Error('fetch failed')), 'fetch failed');
  assert.equal(stripUrls(null), '');
  assert.equal(stripUrls(undefined), '');
});

test('ordinary prose is left exactly as it was', () => {
  const sentence = 'the board answered 429 for the third time in a minute';
  assert.equal(stripUrls(sentence), sentence);
});
