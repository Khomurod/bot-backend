const test = require('node:test');
const assert = require('node:assert/strict');
const {
  stripMarkdownCodeFences,
  sanitizeCompanyReportHtmlForTelegram,
} = require('../services/telegramHtml');

test('stripMarkdownCodeFences removes nested markdown fences', () => {
  const input = '```html\n```html\n<p>Hi</p>\n```\n```';
  const out = stripMarkdownCodeFences(input);
  assert.ok(!out.includes('```'));
  assert.ok(out.includes('<p>Hi</p>'));
});

test('sanitizeCompanyReportHtmlForTelegram removes document shell and paragraph tags', () => {
  const input = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><p>Hello <b>world</b></p></body></html>`;
  const out = sanitizeCompanyReportHtmlForTelegram(input);
  assert.ok(!out.includes('<!DOCTYPE'));
  assert.ok(!out.includes('<html'));
  assert.ok(!out.includes('<p>'));
  assert.ok(out.includes('Hello'));
  assert.ok(out.includes('<b>world</b>'));
});
