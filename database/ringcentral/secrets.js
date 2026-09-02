/**
 * Encrypted-credential helpers shared by the settings row and per-recruiter
 * credentials — decrypt without throwing, and mask for display.
 *
 * Extracted so ./settings.js and ./recruiters.js can both use them without
 * either importing the other (and without the copy CLAUDE.md forbids). The
 * cipher itself is services/facebookCrypto.js.
 *
 * Split out of database/ringcentral.js.
 */
const { decryptText } = require('../../services/facebookCrypto');

function safeDecrypt(payload) {
  if (!payload) return '';
  try {
    return decryptText(payload);
  } catch (err) {
    console.warn('[RC] Failed to decrypt a stored credential:', err.message);
    return '';
  }
}

function maskKey(value) {
  const str = String(value || '');
  if (!str) return null;
  if (str.length <= 4) return '••••';
  return `••••${str.slice(-4)}`;
}

module.exports = {
  safeDecrypt,
  maskKey,
};
