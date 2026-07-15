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

test('screenshotStatusBanner: text→photo conversion reads as a clear success', async () => {
  const { screenshotStatusBanner } = await import(MOD);
  const b = screenshotStatusBanner('replace', {
    stored: true,
    telegram: { code: 'UPDATED', converted: true, detail: 'The existing Telegram message was converted to a photo and updated in place — no new message was sent.' },
  });
  assert.equal(b.type, 'success');
  assert.match(b.text, /converted to a photo/i);
  assert.match(b.text, /Screenshot stored\./);
});

test('screenshotStatusBanner: a limitation is a WARNING and does NOT duplicate the "no new message" sentence', async () => {
  const { screenshotStatusBanner } = await import(MOD);
  // Realistic backend detail already ends with the sentence.
  const b = screenshotStatusBanner('remove', {
    deleted: true,
    telegram: {
      code: 'PARTIAL',
      detail: 'Updated what Telegram allows — the screenshot was removed from storage, but Telegram can’t remove the image from the already-sent photo message. No new message was sent.',
    },
  });
  assert.equal(b.type, 'warning');
  const occurrences = (b.text.match(/No new message was sent/gi) || []).length;
  assert.equal(occurrences, 1, 'the sentence must appear exactly once');
});

test('screenshotStatusBanner: caption-too-long conversion is a warning that points to Send as new message', async () => {
  const { screenshotStatusBanner } = await import(MOD);
  const b = screenshotStatusBanner('replace', {
    stored: true,
    telegram: {
      code: 'CAPTION_TOO_LONG_FOR_IN_PLACE_CONVERSION',
      detail: 'The screenshot is stored, but the full route text is too long to fit in a photo caption, so the existing text message was left unchanged (converting it would drop part of the route). Use “Send as new message” to post it as a photo. No new message was sent.',
    },
  });
  assert.equal(b.type, 'warning');
  assert.match(b.text, /Send as new message/i);
});

test('screenshotStatusBanner: a hard Telegram failure is reported truthfully (single, self-contained)', async () => {
  const { screenshotStatusBanner } = await import(MOD);
  const b = screenshotStatusBanner('replace', {
    stored: true,
    telegram: { code: 'BOT_PERMISSION', detail: 'Telegram could not be updated (BOT_PERMISSION). The stored route was updated; no new message was sent.' },
  });
  assert.equal(b.type, 'warning');
  assert.match(b.text, /no new message was sent/i);
  assert.equal((b.text.match(/no new message was sent/gi) || []).length, 1);
});

test('screenshotStatusBanner: an UNCONFIRMED transport failure is a warning with safe diagnostic details', async () => {
  const { screenshotStatusBanner } = await import(MOD);
  const b = screenshotStatusBanner('replace', {
    stored: true,
    telegram: {
      ok: false, status: 'unconfirmed', code: 'TELEGRAM_CONNECTION_RESET', category: 'transport',
      operation: 'edit_media_text_to_photo', attempts: 3, ambiguousOutcome: true,
      transportCode: 'ECONNRESET', telegramErrorCode: null, correlationId: 'rc-edit-22-abc',
      detail: 'Telegram’s connection closed while it was receiving the image. The update could not be confirmed after 3 attempts. No new message was sent.',
    },
  });
  assert.equal(b.type, 'warning');
  assert.match(b.text, /could not be confirmed after 3 attempts/i);
  assert.ok(Array.isArray(b.details));
  const byLabel = Object.fromEntries(b.details.map((d) => [d.label, String(d.value)]));
  assert.equal(byLabel.Attempts, '3');
  assert.match(byLabel.Operation, /Convert existing text message to photo/);
  assert.match(byLabel['Telegram response'], /No response received/);
  assert.equal(byLabel['New message sent'], 'No');
  assert.equal(byLabel.Reference, 'rc-edit-22-abc');
});

test('screenshotStatusBanner: a permission failure surfaces the Telegram error code in details', async () => {
  const { screenshotStatusBanner } = await import(MOD);
  const b = screenshotStatusBanner('replace', {
    telegram: {
      ok: false, status: 'failed', code: 'BOT_PERMISSION', category: 'permission',
      operation: 'edit_media', attempts: 1, telegramErrorCode: 403, correlationId: 'rc-edit-1-z',
      detail: 'Telegram rejected the update because the bot does not have permission to edit the message in that group. No new message was sent.',
    },
  });
  assert.equal(b.type, 'warning');
  const byLabel = Object.fromEntries(b.details.map((d) => [d.label, String(d.value)]));
  assert.equal(byLabel['Telegram response'], 'Error 403');
});

test('screenshotStatusBanner: the "update" action has no "Screenshot stored" prefix and no details on success', async () => {
  const { screenshotStatusBanner } = await import(MOD);
  const b = screenshotStatusBanner('update', {
    telegram: { ok: true, status: 'updated', code: 'UPDATED', detail: 'Updated the existing Telegram message text in place — no new message was sent.' },
  });
  assert.equal(b.type, 'success');
  assert.doesNotMatch(b.text, /Screenshot stored/);
  assert.equal(b.details, undefined);
});
