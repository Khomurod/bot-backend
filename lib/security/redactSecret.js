'use strict';

/**
 * Take a known secret out of a piece of text before it is shown or logged.
 * PURE.
 *
 * An error from a provider usually carries only the provider's own words, but
 * "usually" is not a guarantee: a proxy, a library or a provider that echoes the
 * request can put the credential back into the message. Every error text that
 * leaves the Meta CRM settings path (services/metaCrm/*) on its way to a log or
 * the admin panel goes through here with the token it was made with.
 *
 * Also blanks any `access_token=…` pair, whatever its value, since that is the
 * shape a credential takes inside a quoted URL.
 */
const REPLACEMENT = '[token removed]';

function redactSecret(text, ...secrets) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    const value = String(secret ?? '');
    // Too short to be a credential, and replacing it would mangle ordinary words.
    if (value.length < 8) continue;
    out = out.split(value).join(REPLACEMENT);
  }
  return out.replace(/(access_token=)[^&\s"']+/gi, `$1${REPLACEMENT}`);
}

module.exports = { redactSecret, REPLACEMENT };
