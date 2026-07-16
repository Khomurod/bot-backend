const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTelegramScreenshotUrl,
  screenshotVersion,
  verifyTelegramScreenshotReference,
} = require('../services/routeControl/screenshotMediaReference');

const SECRET = 'test-only-route-screenshot-signing-secret';
const NOW = Date.parse('2026-07-16T12:00:00Z');
const SCREENSHOT = { file_data: Buffer.from('png-image-one') };

test('signed screenshot URL is HTTPS, short-lived, and verifies', () => {
  const value = buildTelegramScreenshotUrl({
    assignmentId: 22,
    screenshot: SCREENSHOT,
    baseUrl: 'https://bot-backend.example/',
    secret: SECRET,
    now: NOW,
    ttlSeconds: 600,
  });
  const url = new URL(value);
  assert.equal(url.origin, 'https://bot-backend.example');
  assert.equal(url.pathname, '/api/route-screenshot-media/22');
  assert.equal(url.searchParams.get('exp'), String(Math.floor(NOW / 1000) + 600));
  assert.equal(url.searchParams.get('v'), screenshotVersion(SCREENSHOT));
  assert.equal(verifyTelegramScreenshotReference({
    assignmentId: 22,
    version: url.searchParams.get('v'),
    expiresAt: url.searchParams.get('exp'),
    signature: url.searchParams.get('sig'),
    secret: SECRET,
    now: NOW,
  }).ok, true);
});

test('signature rejects assignment, version, expiry, and signature tampering', () => {
  const url = new URL(buildTelegramScreenshotUrl({
    assignmentId: 22,
    screenshot: SCREENSHOT,
    baseUrl: 'https://bot-backend.example',
    secret: SECRET,
    now: NOW,
  }));
  const input = {
    assignmentId: 22,
    version: url.searchParams.get('v'),
    expiresAt: url.searchParams.get('exp'),
    signature: url.searchParams.get('sig'),
    secret: SECRET,
    now: NOW,
  };
  assert.equal(verifyTelegramScreenshotReference({ ...input, assignmentId: 23 }).ok, false);
  assert.equal(verifyTelegramScreenshotReference({ ...input, version: 'x'.repeat(24) }).ok, false);
  assert.equal(verifyTelegramScreenshotReference({ ...input, signature: 'x'.repeat(43) }).ok, false);
  assert.equal(verifyTelegramScreenshotReference({ ...input, now: NOW + (11 * 60 * 1000) }).reason, 'expired');
});

test('content-derived version changes when a screenshot is replaced', () => {
  assert.notEqual(
    screenshotVersion(SCREENSHOT),
    screenshotVersion({ file_data: Buffer.from('png-image-two') })
  );
});

test('builder fails clearly when production URL or signing secret is absent', () => {
  assert.throws(
    () => buildTelegramScreenshotUrl({ assignmentId: 22, screenshot: SCREENSHOT, baseUrl: '', secret: SECRET }),
    (error) => error.code === 'SCREENSHOT_MEDIA_URL_NOT_CONFIGURED'
  );
  assert.throws(
    () => buildTelegramScreenshotUrl({ assignmentId: 22, screenshot: SCREENSHOT, baseUrl: 'https://example.test', secret: '' }),
    (error) => error.code === 'SCREENSHOT_MEDIA_SIGNING_NOT_CONFIGURED'
  );
});
