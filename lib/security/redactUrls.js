'use strict';

/**
 * Take the URLs out of a sentence before anybody stores or shows it.
 *
 * The Dispatcher Board authenticates by query string — `?token=…` — which makes
 * every error message that quotes the request a credential leak waiting for a
 * log aggregator. `fetch` failures do quote it: Node's `TypeError: fetch failed`
 * carries a cause, redirects are reported with their target, and an HTTP client
 * that prints the request line prints the token with it.
 *
 * So no URL survives the boundary. Not the token, not the host, not the path:
 * a redacted host is still an exfiltration hint, and nothing downstream needs
 * one — the settings row already says which endpoint is configured.
 *
 * Pure, and deliberately blunt. It is cheaper to lose a useful hostname from a
 * log line than to explain a leaked token.
 */

/**
 * `http://`, `https://` and protocol-relative `//host/…`, to end of token.
 *
 * No `\b` in front: `/` is not a word character, so a boundary there refuses a
 * URL at the very start of the message — which is where a fetch error puts it.
 * The lookbehind keeps an ordinary `a/b//c` path fragment out of it instead.
 */
const URL_PATTERN = /(?:https?:\/\/|(?<![:\w])\/\/)[^\s<>"'`)\]}]+/gi;
/** A bare `token=…`, `key=…`, `secret=…` pair that survived without a URL. */
const CREDENTIAL_PAIR = /\b(token|key|secret|password|auth|apikey|api_key|access_token)=[^\s&<>"'`)\]}]+/gi;

/**
 * @param {*} text  anything; non-strings come back as an empty string
 * @returns {string} the same sentence with every URL replaced by `<url>` and
 *   every stray credential pair by `<name>=<redacted>`
 */
function stripUrls(text) {
  if (text == null) return '';
  const raw = typeof text === 'string' ? text : String(text?.message || text);
  return raw
    .replace(URL_PATTERN, '<url>')
    .replace(CREDENTIAL_PAIR, (_m, name) => `${name}=<redacted>`);
}

/** Query parameters that are credentials, whatever the integration calls them. */
const CREDENTIAL_PARAMS = Object.freeze([
  'token', 'key', 'apikey', 'api_key', 'secret', 'password', 'auth', 'access_token',
]);

/**
 * Take the credential out of a pasted URL.
 *
 * The Dispatcher Board's own link carries `?token=…`, so "paste the link" means
 * "paste the credential". Stored as typed it sits in PLAINTEXT in a column the
 * admin read returns verbatim — beside the encrypted, masked field built to
 * hold exactly that value, and readable by anyone who can open Settings.
 *
 * So the URL is always stripped, and a `token` found in it is RETURNED for the
 * caller to adopt rather than discarded: the administrator plainly meant it as
 * the credential, and losing it only sends them back to paste it again. Any
 * other credential-shaped parameter is stripped and NOT returned — we do not
 * know what it was for, and guessing is how a secret lands in the wrong slot.
 * Embedded `user:password` goes the same way.
 *
 * Pure, and beside `stripUrls` on purpose: both exist because this integration
 * authenticates in a place URLs get written down.
 *
 * @param {*} raw
 * @returns {{url: string|null, token: string|null}}
 */
function splitCredentialsFromUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { url: null, token: null };
  let parsed;
  try {
    parsed = new URL(text);
  } catch (_) {
    // Not a URL at all. The caller decides what to do with it; there is
    // nothing here to strip.
    return { url: text, token: null };
  }
  let token = null;
  for (const name of CREDENTIAL_PARAMS) {
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase() !== name) continue;
      if (name === 'token' && !token) token = parsed.searchParams.get(key);
      parsed.searchParams.delete(key);
    }
  }
  parsed.username = '';
  parsed.password = '';
  return { url: parsed.toString(), token };
}

module.exports = { stripUrls, splitCredentialsFromUrl, CREDENTIAL_PARAMS };
