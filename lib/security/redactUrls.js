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

module.exports = { stripUrls };
