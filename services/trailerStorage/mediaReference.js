/**
 * Short-lived, signed references to stored Trailer Department media.
 *
 * Telegram accepts an HTTPS URL anywhere it accepts an InputFile. Using a URL
 * keeps receipt/photo sends as small JSON requests and lets Telegram fetch the
 * bytes from this service — the same reason Route Control does it, where the
 * multipart upload path repeatedly stalled between Render and api.telegram.org.
 *
 * Security properties (all required — a database-backed file must NEVER be
 * reachable through a permanent or unsigned public URL):
 *   - short expiry (10 min default, 15 min hard cap)
 *   - HMAC-SHA256 over context|mediaId|version|expiresAt, keyed by jwtSecret
 *   - version = content hash, so REPLACING media invalidates old links
 *   - timing-safe comparison
 *   - 410 for expired vs 403 for invalid, so an expired link is diagnosable
 *     without telling an attacker anything about the signature
 *
 * Never log a signed URL or its query string.
 *
 * Adapted from services/routeControl/screenshotMediaReference.js — the proven
 * implementation. Kept separate rather than shared: the signature context and
 * the id space differ, and one media type must never be able to mint a
 * reference to another.
 */
'use strict';

const crypto = require('node:crypto');

const DEFAULT_TTL_SECONDS = 10 * 60;
const MAX_TTL_SECONDS = 15 * 60;
const SIGNATURE_CONTEXT = 'trailer-media:v1';

function referenceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeSecret(secret) {
  const value = String(secret || '').trim();
  if (!value) {
    throw referenceError('TRAILER_MEDIA_SIGNING_NOT_CONFIGURED', 'The media signing secret is not configured.');
  }
  return value;
}

function normalizeBaseUrl(baseUrl) {
  const value = String(baseUrl || '').trim().replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_error) {
    throw referenceError('TRAILER_MEDIA_URL_NOT_CONFIGURED', 'The public application URL is not configured.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw referenceError('TRAILER_MEDIA_URL_NOT_CONFIGURED', 'The public application URL is invalid.');
  }
  return value;
}

/**
 * Content-derived version. Binding the URL to the BYTES means replacing a
 * photo instantly invalidates every link to the previous one — even if the
 * replacement happens to be the same size.
 *
 * @param {{checksum_sha256?: string, file_data?: Buffer}} media
 */
function mediaVersion(media) {
  if (media?.checksum_sha256) {
    return crypto.createHash('sha256').update(String(media.checksum_sha256)).digest('base64url').slice(0, 24);
  }
  if (Buffer.isBuffer(media?.file_data) && media.file_data.length) {
    return crypto.createHash('sha256').update(media.file_data).digest('base64url').slice(0, 24);
  }
  throw referenceError('TRAILER_MEDIA_NOT_AVAILABLE', 'The stored file is empty.');
}

/** Which rendition a reference grants: the original upload or its preview. */
const VARIANTS = new Set(['original', 'preview']);

function normalizeVariant(variant) {
  const value = String(variant || 'original');
  return VARIANTS.has(value) ? value : 'original';
}

// The variant is SIGNED. If it rode along as a bare query parameter, anyone
// holding a preview link could flip it and pull the full-resolution original.
function signaturePayload({ mediaId, version, variant, expiresAt }) {
  return `${SIGNATURE_CONTEXT}|${mediaId}|${version}|${normalizeVariant(variant)}|${expiresAt}`;
}

function signReference({ mediaId, version, variant, expiresAt, secret }) {
  return crypto
    .createHmac('sha256', normalizeSecret(secret))
    .update(signaturePayload({ mediaId, version, variant, expiresAt }))
    .digest('base64url');
}

/**
 * Build a signed, expiring URL Telegram can fetch.
 *
 * @param {object} input
 * @param {number} input.mediaId trailer_media.id
 * @param {object} input.media   row carrying checksum_sha256 (or file_data)
 * @param {string} [input.variant] 'original' (default) or 'preview'
 * @param {string} [input.baseUrl] defaults to config.renderExternalUrl
 * @param {string} [input.secret]  defaults to config.jwtSecret
 */
function buildTrailerMediaUrl({
  mediaId,
  media,
  variant = 'original',
  baseUrl,
  secret,
  now = Date.now(),
  ttlSeconds = DEFAULT_TTL_SECONDS,
}) {
  const runtimeConfig = (baseUrl === undefined || secret === undefined) ? require('../../config/config') : null;
  const resolvedBaseUrl = baseUrl === undefined ? runtimeConfig.renderExternalUrl : baseUrl;
  const resolvedSecret = secret === undefined ? runtimeConfig.jwtSecret : secret;

  const id = Number(mediaId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw referenceError('INVALID_MEDIA_ID', 'A valid media id is required.');
  }
  const ttl = Math.min(Math.max(Number(ttlSeconds) || DEFAULT_TTL_SECONDS, 30), MAX_TTL_SECONDS);
  const expiresAt = Math.floor(Number(now) / 1000) + Math.floor(ttl);
  const version = mediaVersion(media);
  const resolvedVariant = normalizeVariant(variant);
  const signature = signReference({
    mediaId: id, version, variant: resolvedVariant, expiresAt, secret: resolvedSecret,
  });

  const url = new URL(`/api/trailer-media/${id}`, `${normalizeBaseUrl(resolvedBaseUrl)}/`);
  url.searchParams.set('v', version);
  url.searchParams.set('p', resolvedVariant);
  url.searchParams.set('exp', String(expiresAt));
  url.searchParams.set('sig', signature);
  return url.toString();
}

/**
 * Verify a reference presented by Telegram (or anyone).
 * @returns {{ok: true} | {ok: false, reason: 'expired'|'invalid'|'configuration'}}
 */
function verifyTrailerMediaReference({
  mediaId, version, variant, expiresAt, signature, secret, now = Date.now(),
}) {
  const resolvedSecret = secret === undefined ? require('../../config/config').jwtSecret : secret;
  const id = Number(mediaId);
  const exp = Number(expiresAt);
  const currentSeconds = Math.floor(Number(now) / 1000);

  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(exp)) return { ok: false, reason: 'invalid' };
  if (exp < currentSeconds) return { ok: false, reason: 'expired' };
  // A far-future expiry means a forged or tampered link, not a valid one.
  if (exp > currentSeconds + MAX_TTL_SECONDS + 60) return { ok: false, reason: 'invalid' };
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(version || ''))
      || !/^[A-Za-z0-9_-]{32,64}$/.test(String(signature || ''))) {
    return { ok: false, reason: 'invalid' };
  }
  // An unrecognised variant must FAIL, not quietly fall back to 'original' —
  // otherwise a tampered value would still verify and serve the full file.
  if (variant != null && !VARIANTS.has(String(variant))) return { ok: false, reason: 'invalid' };
  const resolvedVariant = normalizeVariant(variant);

  let expected;
  try {
    expected = signReference({
      mediaId: id, version, variant: resolvedVariant, expiresAt: exp, secret: resolvedSecret,
    });
  } catch (_error) {
    return { ok: false, reason: 'configuration' };
  }
  const supplied = Buffer.from(String(signature));
  const expectedBuffer = Buffer.from(expected);
  const valid = supplied.length === expectedBuffer.length && crypto.timingSafeEqual(supplied, expectedBuffer);
  return valid ? { ok: true, variant: resolvedVariant } : { ok: false, reason: 'invalid' };
}

module.exports = {
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  VARIANTS,
  buildTrailerMediaUrl,
  verifyTrailerMediaReference,
  mediaVersion,
};
