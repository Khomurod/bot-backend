'use strict';

/**
 * Truck Photos settings — single-row store (id = 1), Settings → Truck Photos.
 *
 * OFF BY DEFAULT, and it cannot be switched on until a recipient is saved AND a
 * test message has reached them (`recipient_verified_at`) — refused here in
 * words and again by the table's CHECK. Changing the recipient clears that
 * proof and switches the feature off: a new person has not pressed Start yet.
 *
 * No environment variable can switch any of this on.
 *
 * Only 42P01 (the table does not exist yet — a deploy before migration 0096)
 * reads as "switched off"; any other failure is thrown, so an outage is never
 * mistaken for a person having switched the feature off.
 */

const { query } = require('../pool');

/**
 * TEN MINUTES. The capture asks on every photo in every driver group. The only
 * writers are below, and each clears the cache, so a change made in the admin
 * takes effect on the next message.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;
const UNDEFINED_TABLE = '42P01';
const DEFAULT_LOOKBACK_HOURS = 3;
const DEFAULT_MAX_PHOTOS = 60;

let cache = null;
let cacheExpiresAt = 0;
let generation = 0;

/** A user-input validation failure; the route maps this to HTTP 400. */
class TruckPhotoSettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TruckPhotoSettingsError';
    this.statusCode = 400;
  }
}

function invalidateCache() {
  cache = null;
  cacheExpiresAt = 0;
  generation += 1;
}

async function getRow() {
  try {
    const { rows } = await query('SELECT * FROM truck_photo_settings WHERE id = 1');
    return rows[0] || null;
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) return null;
    throw err;
  }
}

/** A Telegram USER id as a string (a bigint does not survive JSON), or null. */
function normaliseRecipient(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (!/^\d{1,19}$/.test(text) || /^0+$/.test(text)) {
    throw new TruckPhotoSettingsError(
      'The recipient must be a Telegram user id: digits only — a person, not a group (a group id starts with "-").',
    );
  }
  return text.replace(/^0+/, '');
}

function normaliseLookback(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 24) {
    throw new TruckPhotoSettingsError('How far back to look must be a whole number of hours from 1 to 24.');
  }
  return n;
}

function shape(row) {
  const recipient = row?.recipient_telegram_id;
  return {
    enabled: Boolean(row?.enabled),
    recipientTelegramId: recipient === null || recipient === undefined ? null : String(recipient),
    recipientVerifiedAt: row?.recipient_verified_at || null,
    lookbackHours: Number(row?.lookback_hours) || DEFAULT_LOOKBACK_HOURS,
    maxPhotosPerPdf: Number(row?.max_photos_per_pdf) || DEFAULT_MAX_PHOTOS,
    updatedAt: row?.updated_at || null,
  };
}

/** Cached read. Throws on a real database failure; see the header. */
async function getTruckPhotoSettings() {
  const now = Date.now();
  if (cache && now < cacheExpiresAt) return cache;
  const startedIn = generation;
  const fresh = shape(await getRow());
  if (startedIn === generation) {
    cache = fresh;
    cacheExpiresAt = now + CACHE_TTL_MS;
  }
  return fresh;
}

/**
 * Save. Omitted fields keep their stored value.
 *
 * @param {{enabled?: boolean, recipientTelegramId?: string|number|null, lookbackHours?: number}} patch
 * @param {number|null} adminId
 */
async function updateTruckPhotoSettings(patch = {}, adminId = null) {
  const current = shape(await getRow());
  const recipient = patch.recipientTelegramId === undefined
    ? current.recipientTelegramId
    : normaliseRecipient(patch.recipientTelegramId);
  const recipientChanged = recipient !== current.recipientTelegramId;
  const verifiedAt = recipientChanged ? null : current.recipientVerifiedAt;
  // A new recipient has not been reached yet, so the switch goes off with the change.
  const enabled = patch.enabled === undefined ? current.enabled && !recipientChanged : Boolean(patch.enabled);
  if (enabled && (!recipient || !verifiedAt)) {
    throw new TruckPhotoSettingsError(
      'Before switching Truck Photos on: save the recipient and send them a test message. '
      + 'They must open the bot in Telegram and press Start first.',
    );
  }
  const lookback = patch.lookbackHours === undefined ? current.lookbackHours : normaliseLookback(patch.lookbackHours);

  const { rows } = await query(
    `INSERT INTO truck_photo_settings (id, enabled, recipient_telegram_id, recipient_verified_at,
                                       lookback_hours, updated_at, updated_by)
     VALUES (1, $1, $2::bigint, $3, $4, NOW(), $5)
     ON CONFLICT (id) DO UPDATE
        SET enabled = EXCLUDED.enabled,
            recipient_telegram_id = EXCLUDED.recipient_telegram_id,
            recipient_verified_at = EXCLUDED.recipient_verified_at,
            lookback_hours = EXCLUDED.lookback_hours,
            updated_at = NOW(),
            updated_by = EXCLUDED.updated_by
     RETURNING *`,
    [enabled, recipient, verifiedAt, lookback, adminId],
  );
  invalidateCache();
  return shape(rows[0] || null);
}

/**
 * A test message reached this recipient. Recorded only while they are still
 * the saved recipient — a proof for one person is no proof for another.
 *
 * @returns {Promise<object|null>} the settings, or null when the recipient changed meanwhile
 */
async function markRecipientVerified(recipientTelegramId) {
  const id = normaliseRecipient(recipientTelegramId);
  if (!id) return null;
  const { rows } = await query(
    `UPDATE truck_photo_settings
        SET recipient_verified_at = NOW(), updated_at = NOW()
      WHERE id = 1 AND recipient_telegram_id = $1::bigint
      RETURNING *`,
    [id],
  );
  invalidateCache();
  return rows[0] ? shape(rows[0]) : null;
}

module.exports = {
  TruckPhotoSettingsError,
  getTruckPhotoSettings,
  updateTruckPhotoSettings,
  markRecipientVerified,
  normaliseRecipient,
  invalidateCache,
  CACHE_TTL_MS,
  DEFAULT_LOOKBACK_HOURS,
  DEFAULT_MAX_PHOTOS,
};
