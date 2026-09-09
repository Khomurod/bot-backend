/**
 * Encrypted-credential helpers shared by the settings row and per-recruiter
 * credentials — decrypt without throwing, and mask for display.
 *
 * Extracted so ./settings.js and ./recruiters.js can both use them without
 * either importing the other (and without the copy CLAUDE.md forbids). The
 * cipher itself is lib/security/facebookCrypto.js.
 *
 * The two helpers now come from lib/security/secretMasking.js, which is where
 * they moved once the AI provider table would have become a THIRD copy of the
 * same eight lines. This file keeps its own names and its '[RC]' log prefix, so
 * nothing that imports it changed.
 *
 * Split out of database/ringcentral.js.
 */
const { maskKey, createSafeDecrypt } = require('../../lib/security/secretMasking');

const safeDecrypt = createSafeDecrypt('[RC]');

module.exports = {
  safeDecrypt,
  maskKey,
};
