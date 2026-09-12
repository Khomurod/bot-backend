'use strict';

/**
 * The Dispatcher Board authenticates by query string, so every error message
 * that quotes the request is a credential in a log file. This is the boundary
 * that stops it, and the test that proves nothing gets past.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { stripUrls, splitCredentialsFromUrl } = require('../lib/security/redactUrls');

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

// ── a credential pasted inside a URL ────────────────────────────────────────
//
// The Board's own link carries `?token=…`, so "paste the link" means "paste the
// credential". Stored as typed it sits in plaintext in a column the settings
// read returns verbatim, beside the encrypted field built to hold it.

test('a token in the query is separated from the URL, not left in it', () => {
  const { url, token } = splitCredentialsFromUrl(`https://script.example.com/exec?token=${TOKEN}`);
  assert.equal(token, TOKEN, 'it is handed back so the caller can store it properly');
  assert.ok(!url.includes(TOKEN), url);
  assert.ok(!url.includes('token='), url);
});

test('ordinary parameters survive the strip', () => {
  const { url } = splitCredentialsFromUrl(`https://script.example.com/exec?sheet=today&token=${TOKEN}`);
  assert.match(url, /sheet=today/);
  assert.ok(!url.includes(TOKEN));
});

test('other credential-shaped parameters are removed but never adopted', () => {
  // We do not know what a `secret` or an `apikey` was for, and guessing is how
  // a credential ends up in the wrong slot.
  for (const name of ['key', 'apikey', 'api_key', 'secret', 'password', 'auth', 'access_token']) {
    const { url, token } = splitCredentialsFromUrl(`https://x.example/exec?${name}=${TOKEN}`);
    assert.ok(!url.includes(TOKEN), `${name}: ${url}`);
    assert.equal(token, null, name);
  }
});

test('the parameter name is matched however it is capitalised', () => {
  const { url, token } = splitCredentialsFromUrl(`https://x.example/exec?TOKEN=${TOKEN}`);
  assert.equal(token, TOKEN);
  assert.ok(!url.includes(TOKEN));
});

test('embedded user:password is removed too', () => {
  const { url } = splitCredentialsFromUrl('https://someone:hunter2@x.example/exec');
  assert.ok(!url.includes('hunter2'), url);
  assert.ok(!url.includes('someone'), url);
});

test('something that is not a URL is handed back untouched, not swallowed', () => {
  assert.deepEqual(splitCredentialsFromUrl('paste the link here'), {
    url: 'paste the link here', token: null,
  });
  assert.deepEqual(splitCredentialsFromUrl(''), { url: null, token: null });
  assert.deepEqual(splitCredentialsFromUrl(null), { url: null, token: null });
});
