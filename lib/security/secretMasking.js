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

module.exports = { maskKey, createSafeDecrypt };
