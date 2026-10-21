'use strict';

/**
 * The shared secret the Bitrix robots send to the home-time violation webhook.
 *
 * SET FROM THE APP. The owner asked (21 October 2026) not to have to visit the
 * hosting panel: the Home Time page's "Create webhook link" asks
 * `generateWebhookSecret`, which makes a random secret, stores it ENCRYPTED on
 * `home_time_settings` (migration 0080, the same AES-256-GCM key as the Bitrix
 * webhook URL) and returns it ONCE, so the page can show the full link to paste
 * into the three robots. It is never read back to the browser after that:
 * `publicViolationSettings` strips the column from every settings response and
 * says only whether a secret is set. Creating a new one replaces the old — the
 * robots must then get the new link.
 *
 * The environment variable is the fallback for a row never set.
 */

const crypto = require('node:crypto');
const { encryptText, decryptText } = require('../../lib/security/facebookCrypto');
const defaultStore = require('../../database/homeTime/violationNotices');

const SECRET_ENV = 'HOME_TIME_VIOLATION_WEBHOOK_SECRET';
const ENCRYPTED_COLUMN = 'violation_webhook_secret_encrypted';
const CACHE_MS = 60 * 1000;

let cache = { value: null, at: 0 };

function decryptOrNull(payload) {
  if (!payload) return null;
  try {
    return decryptText(payload) || null;
  } catch {
    // A key that changed since the secret was stored: treat as not set, so a
    // new link can be created; never as a match.
    return null;
  }
}

/** The secret the webhook must be called with, or null. Read at most once a minute. */
async function resolveWebhookSecret({ store = defaultStore, env = process.env, now = Date.now() } = {}) {
  if (now - cache.at < CACHE_MS) return cache.value;
  const stored = decryptOrNull(await store.getWebhookSecretEncrypted().catch(() => null));
  const value = stored || String(env[SECRET_ENV] || '').trim() || null;
  cache = { value, at: now };
  return value;
}

/** A fresh secret, stored encrypted, returned this once. Replaces any earlier one. */
async function generateWebhookSecret({ store = defaultStore } = {}) {
  const secret = crypto.randomBytes(24).toString('base64url');
  await store.setWebhookSecretEncrypted(encryptText(secret));
  cache = { value: null, at: 0 };
  return secret;
}

/** A settings row as the browser may see it: no secret, only whether one is set. */
function publicViolationSettings(row, env = process.env) {
  if (!row) return row;
  const { [ENCRYPTED_COLUMN]: encrypted, ...rest } = row;
  return {
    ...rest,
    violation_webhook_secret_set: Boolean(encrypted) || Boolean(String(env[SECRET_ENV] || '').trim()),
  };
}

module.exports = {
  SECRET_ENV,
  resolveWebhookSecret,
  generateWebhookSecret,
  publicViolationSettings,
  __resetCacheForTests: () => { cache = { value: null, at: 0 }; },
};
