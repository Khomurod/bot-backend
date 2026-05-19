const test = require('node:test');
const assert = require('node:assert/strict');

const {
  renderLeadSmsTemplate,
  buildTemplateContext,
  validateTemplate,
  extractTemplateTokens,
  estimateSmsSegments,
} = require('../services/facebookLeadSmsTemplate');

test('renderLeadSmsTemplate substitutes lead and settings tokens', () => {
  const context = buildTemplateContext({
    fieldMap: { full_name: 'Jane Doe', phone_number: '+15551234567', email: 'jane@example.com' },
    settings: { rep_name: 'Tom', company_name: 'Wenze', position_label: 'OTR' },
    pageName: 'WENZE Page',
  });
  const rendered = renderLeadSmsTemplate(
    'Hi {first_name} from {company_name} re {position}. Call {phone}? Page: {page_name}',
    context
  );
  assert.match(rendered, /Jane/);
  assert.match(rendered, /Wenze/);
  assert.match(rendered, /OTR/);
  assert.match(rendered, /\+15551234567/);
});

test('validateTemplate rejects unknown placeholders', () => {
  const result = validateTemplate('Hello {first_name} and {unknown_token}');
  assert.equal(result.valid, false);
  assert.deepEqual(result.unknownTokens, ['unknown_token']);
});

test('extractTemplateTokens finds all keys', () => {
  const tokens = extractTemplateTokens('Hi {first_name} {last_name}');
  assert.deepEqual(tokens.sort(), ['first_name', 'last_name']);
});

test('estimateSmsSegments counts multipart', () => {
  const long = 'x'.repeat(200);
  const seg = estimateSmsSegments(long);
  assert.equal(seg.segments, 2);
});
