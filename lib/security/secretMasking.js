/**
 * Showing that a secret is set without showing the secret. PURE.
 *
 * Two helpers that every settings table storing an encrypted credential needs,
 * and that three of them had independently grown a copy of:
 *
 *   `maskKey` — `••••abcd`, the only form a stored key is ever returned in. The
 *   invariant `server/routes/settingsRoutes.js` states for every settings
 *   sub-router is that a stored secret is NEVER returned in full; this is how
 *   that is kept, and a mask that leaked more than four characters would break
 *   it everywhere at once.
 *
 *   `createSafeDecrypt` — decrypt or give up quietly. A stored value that no
 *   longer decrypts (the key rotated, the row was written by another
 *   deployment) must degrade to "no key is configured", which every caller
 *   already handles, rather than throw out of a settings read and take a whole
 *   admin page down with it.
 *
 * WHY THIS FILE EXISTS. `database/ringcentral/secrets.js` and
 * `database/gmapsSettings.js` each held a byte-identical `maskKey` and a
 * `safeDecrypt` differing only in its log prefix. The AI provider table would
 * have been the third copy, and CLAUDE.md is explicit that shared logic is
 * extracted rather than copied. The log prefix is the only thing that ever
 * legitimately varied, so it is the only thing parameterised.
 *
 * `lib/` and not `database/`: no I/O, no state, and the layer below the data
 * layer is where `database/**` is allowed to depend.
 */
const { decryptText } = require('./facebookCrypto');

/**
 * `••••abcd` — enough for an operator to recognise which key is stored, never
 * enough to use it. Returns null (not an empty mask) when nothing is set, so
 * "no key" and "a very short key" stay distinguishable in the admin.
 */
function maskKey(value) {
  const str = String(value || '');
  if (!str) return null;
  if (str.length <= 4) return '••••';
  return `••••${str.slice(-4)}`;
}

/**
 * A decrypt that answers '' instead of throwing.
 *
 * @param {string} logPrefix  e.g. '[RC]' — kept per-caller so an undecryptable
 *   value still says which subsystem it belongs to.
 * @param {string} [noun='a stored credential']
 */
function createSafeDecrypt(logPrefix, noun = 'a stored credential') {
  return function safeDecrypt(payload) {
    if (!payload) return '';
    try {
      return decryptText(payload);
    } catch (err) {
      console.warn(`${logPrefix} Failed to decrypt ${noun}:`, err.message);
      return '';
    }
  };
}

/**
 * Prefixes the AI providers (and a few neighbours) put on their API keys.
 * Each is followed by a long random tail, so a prefix plus 8 more characters
 * is a key and never a name anybody would type.
 */
const KEY_PREFIXES = [
  'sk-', 'sk_', 'gsk_', 'AIza', 'xai-', 'hf_', 'pplx-', 'nvapi-', 'csk-', 'r8_', 'ghp_', 'github_pat_',
];

/**
 * Does this NAME look like a pasted credential? PURE.
 *
 * October 2026: production held a disabled AI provider whose operator-typed
 * name was an OpenRouter API key, pasted into the wrong field. A name is shown
 * in the admin, written to logs and carried into reports; a key is encrypted
 * and never shown. So a value that looks like a key is refused as a name.
 *
 * A known key prefix with a tail, or one unbroken 32+ character run of the key
 * alphabet — the same length the notice composer treats as a credential
 * (`lib/notifications/compose.js`). Names like "groq", "office-box" or
 * "OpenRouter (backup)" never match.
 */
function looksLikeSecret(value) {
  const text = String(value ?? '').trim();
  if (!text) return false;
  if (KEY_PREFIXES.some((prefix) => text.startsWith(prefix) && text.length >= prefix.length + 8)) return true;
  return /^[A-Za-z0-9_-]{32,}$/.test(text);
}

module.exports = { maskKey, createSafeDecrypt, looksLikeSecret };
