/**
 * Unit tests for the Route Control screenshot client helpers
 * (admin/src/pages/routeScreenshot.mjs). No React/DOM needed — validation, the
 * clipboard-image extractor, and the admin status wording are pure. Imported via
 * a file:// URL so the dynamic ESM import works on Windows too.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MOD = pathToFileURL(path.resolve(__dirname, '../admin/src/pages/routeScreenshot.mjs')).href;

const MB = 1024 * 1024;

test('validateScreenshotFile accepts PNG/JPEG/WEBP within the size limit', async () => {
  const { validateScreenshotFile } = await import(MOD);
  for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
    const v = validateScreenshotFile({ type, size: 2 * MB });
    assert.equal(v.ok, true, `${type} should be accepted`);
    assert.equal(v.error, null);
  }
});

test('validateScreenshotFile rejects an unsupported type with a clear error', async () => {
  const { validateScreenshotFile } = await import(MOD);
  const v = validateScreenshotFile({ type: 'application/pdf', size: 1000 });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'BAD_TYPE');
  assert.match(v.error, /PNG, JPG or WEBP/);
});

test('validateScreenshotFile rejects an oversized file', async () => {
  const { validateScreenshotFile } = await import(MOD);
  const v = validateScreenshotFile({ type: 'image/png', size: 9 * MB });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'TOO_LARGE');
  assert.match(v.error, /limit is 8 MB/);
});

test('validateScreenshotFile rejects an empty/unreadable image and a missing file', async () => {
  const { validateScreenshotFile } = await import(MOD);
  assert.equal(validateScreenshotFile({ type: 'image/png', size: 0 }).code, 'EMPTY');
  assert.equal(validateScreenshotFile(null).code, 'NO_FILE');
});

test('imageFromClipboard returns the first image file, or null for non-image clipboards', async () => {
  const { imageFromClipboard } = await import(MOD);
  const fakeFile = { name: 'x.png', type: 'image/png' };
  const items = [
    { kind: 'string', type: 'text/plain', getAsFile: () => null },
    { kind: 'file', type: 'image/png', getAsFile: () => fakeFile },
  ];
  assert.equal(imageFromClipboard(items), fakeFile);
  assert.equal(imageFromClipboard([{ kind: 'string', type: 'text/plain', getAsFile: () => null }]), null);
  assert.equal(imageFromClipboard([]), null);
  assert.equal(imageFromClipboard(undefined), null);
});

test('screenshotStatusBanner: never-sent route reports storage-only, no send', async () => {
  const { screenshotStatusBanner } = await import(MOD);
  const b = screenshotStatusBanner('replace', { stored: true, telegram: { code: 'NOT_SENT' } });
  assert.equal(b.type, 'success');
  assert.match(b.text, /not been sent/i);
  assert.match(b.text, /nothing was sent/i);
});

test('screenshotStatusBanner: in-place update is a success that says no new message was sent', async () => {
  const { screenshotStatusBanner } = await import(MOD);
  const b = screenshotStatusBanner('replace', {
    stored: true,
    telegram: { code: 'UPDATED', detail: 'Updated the existing Telegram screenshot in place — no new message was sent.' },
  });
  assert.equal(b.type, 'success');
  assert.match(b.text, /no new message/i);
});

test('screenshotStatusBanner: a limitation is a WARNING, not a false success', async () => {
  const { screenshotStatusBanner } = await import(MOD);
  const b = screenshotStatusBanner('remove', {
    deleted: true,
    telegram: { code: 'PARTIAL', detail: 'Telegram can’t remove the image from the already-sent photo message.' },
  });
  assert.equal(b.type, 'warning');
  assert.match(b.text, /No new message was sent/i);
});

test('screenshotStatusBanner: a hard Telegram failure is reported truthfully with retry guidance', async () => {
  const { screenshotStatusBanner } = await import(MOD);
  const b = screenshotStatusBanner('replace', {
    stored: true,
    telegram: { code: 'BOT_PERMISSION', detail: 'The bot lacks permission to edit the message.' },
  });
  assert.equal(b.type, 'warning');
  assert.match(b.text, /Telegram was NOT updated/);
  assert.match(b.text, /no new message was sent/i);
});
