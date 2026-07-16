/**
 * Short-lived, signed references to stored Route Control screenshots.
 *
 * Telegram accepts an HTTPS URL anywhere it accepts an InputFile. Using a URL
 * keeps screenshot sends/edits as small JSON requests and lets Telegram fetch
 * the image from this service, avoiding the multipart upload path that can
 * stall between Render and api.telegram.org.
 */
const crypto = require('node:crypto');

const DEFAULT_TTL_SECONDS = 10 * 60;
const MAX_TTL_SECONDS = 15 * 60;
const SIGNATURE_CONTEXT = 'route-screenshot-media:v1';

function mediaReferenceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeSecret(secret) {
  const value = String(secret || '').trim();
  if (!value) {
    throw mediaReferenceError(
      'SCREENSHOT_MEDIA_SIGNING_NOT_CONFIGURED',
      'The screenshot delivery signing secret is not configured.'
    );
  }
  return value;
}

function normalizeBaseUrl(baseUrl) {
  const value = String(baseUrl || '').trim().replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_error) {
    throw mediaReferenceError(
      'SCREENSHOT_MEDIA_URL_NOT_CONFIGURED',
      'The public application URL for screenshot delivery is not configured.'
    );
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw mediaReferenceError(
      'SCREENSHOT_MEDIA_URL_NOT_CONFIGURED',
      'The public application URL for screenshot delivery is invalid.'
    );
  }
  return value;
}

function screenshotVersion(screenshot) {
  if (!Buffer.isBuffer(screenshot?.file_data) || screenshot.file_data.length === 0) {
    throw mediaReferenceError('SCREENSHOT_NOT_AVAILABLE', 'The stored screenshot is empty.');
  }
  // Content-derived versioning prevents Telegram or an intermediary from using
  // an earlier image after an admin replaces a screenshot of the same size.
  return crypto.createHash('sha256').update(screenshot.file_data).digest('base64url').slice(0, 24);
}

function signaturePayload({ assignmentId, version, expiresAt }) {
  return `${SIGNATURE_CONTEXT}|${assignmentId}|${version}|${expiresAt}`;
}

function signReference({ assignmentId, version, expiresAt, secret }) {
  return crypto
    .createHmac('sha256', normalizeSecret(secret))
    .update(signaturePayload({ assignmentId, version, expiresAt }))
    .digest('base64url');
}

function buildTelegramScreenshotUrl({
  assignmentId,
  screenshot,
  baseUrl,
  secret,
  now = Date.now(),
  ttlSeconds = DEFAULT_TTL_SECONDS,
}) {
  const runtimeConfig = (baseUrl === undefined || secret === undefined)
    ? require('../../config/config')
    : null;
  const resolvedBaseUrl = baseUrl === undefined ? runtimeConfig.renderExternalUrl : baseUrl;
  const resolvedSecret = secret === undefined ? runtimeConfig.jwtSecret : secret;
  const id = Number(assignmentId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw mediaReferenceError('INVALID_ASSIGNMENT_ID', 'A valid route assignment id is required.');
  }
  const ttl = Math.min(Math.max(Number(ttlSeconds) || DEFAULT_TTL_SECONDS, 30), MAX_TTL_SECONDS);
  const expiresAt = Math.floor(Number(now) / 1000) + Math.floor(ttl);
  const version = screenshotVersion(screenshot);
  const signature = signReference({ assignmentId: id, version, expiresAt, secret: resolvedSecret });
  const url = new URL(`/api/route-screenshot-media/${id}`, `${normalizeBaseUrl(resolvedBaseUrl)}/`);
  url.searchParams.set('v', version);
  url.searchParams.set('exp', String(expiresAt));
  url.searchParams.set('sig', signature);
  return url.toString();
}

function verifyTelegramScreenshotReference({
  assignmentId,
  version,
  expiresAt,
  signature,
  secret,
  now = Date.now(),
}) {
  const resolvedSecret = secret === undefined ? require('../../config/config').jwtSecret : secret;
  const id = Number(assignmentId);
  const exp = Number(expiresAt);
  const currentSeconds = Math.floor(Number(now) / 1000);
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(exp)) {
    return { ok: false, reason: 'invalid' };
  }
  if (exp < currentSeconds) return { ok: false, reason: 'expired' };
  if (exp > currentSeconds + MAX_TTL_SECONDS + 60) return { ok: false, reason: 'invalid' };
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(version || ''))
      || !/^[A-Za-z0-9_-]{32,64}$/.test(String(signature || ''))) {
    return { ok: false, reason: 'invalid' };
  }

  let expected;
  try {
    expected = signReference({ assignmentId: id, version, expiresAt: exp, secret: resolvedSecret });
  } catch (_error) {
    return { ok: false, reason: 'configuration' };
  }
  const suppliedBuffer = Buffer.from(String(signature));
  const expectedBuffer = Buffer.from(expected);
  const valid = suppliedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
  return valid ? { ok: true } : { ok: false, reason: 'invalid' };
}

module.exports = {
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  buildTelegramScreenshotUrl,
  verifyTelegramScreenshotReference,
  screenshotVersion,
};
