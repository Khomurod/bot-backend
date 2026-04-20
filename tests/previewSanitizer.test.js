const test = require('node:test');
const assert = require('node:assert/strict');

// The admin preview sanitizer is ES-module source (Vite-targeted), so we
// load it via dynamic import. Node 18+ supports importing .js files as ESM
// when the file uses `export` — we sidestep the CommonJS/ESM mismatch by
// using the dynamic import() expression.
async function loadSanitizer() {
  const mod = await import('../admin/src/telegramHtmlPreview.js');
  return mod.sanitizeTelegramHtmlForPreview;
}

test('sanitizeTelegramHtmlForPreview keeps Telegram-safe formatting', async () => {
  const fn = await loadSanitizer();
  const out = fn('<b>Hello</b> <i>world</i>');
  assert.ok(out.includes('<b>Hello</b>'));
  assert.ok(out.includes('<i>world</i>'));
});

test('sanitizeTelegramHtmlForPreview strips <script> and inline event handlers', async () => {
  const fn = await loadSanitizer();
  const out = fn('<b>hi</b><script>alert(1)</script><img src=x onerror="alert(2)">');
  assert.ok(!/<script/i.test(out));
  assert.ok(!/onerror/i.test(out));
  assert.ok(!/<img/i.test(out));
});

test('sanitizeTelegramHtmlForPreview rewrites anchors: safe href kept, javascript: dropped', async () => {
  const fn = await loadSanitizer();
  const safe = fn('<a href="https://example.com">ok</a>');
  assert.ok(safe.includes('href="https://example.com"'));
  assert.ok(safe.includes('rel="noopener noreferrer"'));

  const dangerous = fn('<a href="javascript:alert(1)">bad</a>');
  // The <a> tag without an approved href should render as a bare tag with
  // no href attribute (or be dropped entirely via attribute stripping).
  assert.ok(!/javascript:/i.test(dangerous));
});

test('sanitizeTelegramHtmlForPreview escapes stray angle brackets in text', async () => {
  const fn = await loadSanitizer();
  const out = fn('2 < 5 && 5 > 2');
  assert.ok(out.includes('&lt;'));
  assert.ok(out.includes('&gt;'));
  assert.ok(out.includes('&amp;'));
});

test('sanitizeTelegramHtmlForPreview preserves <tg-spoiler> and blockquote expandable', async () => {
  const fn = await loadSanitizer();
  const out = fn('<blockquote expandable>deep <tg-spoiler>secret</tg-spoiler></blockquote>');
  assert.ok(/<blockquote expandable>/.test(out));
  assert.ok(/<tg-spoiler>/.test(out));
});
