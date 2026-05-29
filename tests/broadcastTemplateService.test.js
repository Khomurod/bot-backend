const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractBroadcastTemplateTokens,
  validateBroadcastTemplate,
  buildBroadcastTemplateContext,
  renderBroadcastTemplateStrict,
} = require('../services/broadcastTemplateService');

test('extractBroadcastTemplateTokens returns deduped normalized tokens', () => {
  const tokens = extractBroadcastTemplateTokens(
    'Hi {driver_name}, unit {unit_number}. Again {Driver_Name}'
  );
  assert.deepEqual(tokens.sort(), ['driver_name', 'unit_number']);
});

test('validateBroadcastTemplate detects unknown placeholders', () => {
  const verdict = validateBroadcastTemplate('Hello {driver_name} {bad_token}');
  assert.equal(verdict.valid, false);
  assert.deepEqual(verdict.unknownTokens, ['bad_token']);
});

test('buildBroadcastTemplateContext builds profile-backed values', () => {
  const context = buildBroadcastTemplateContext({
    profile: {
      first_name: 'Omar',
      last_name: 'Alawad',
      unit_number: '005',
      driver_type: 'company_driver',
      status: 'active',
      language: 'en',
      date_of_birth: '1990-02-01',
      date_of_start: '2026-05-01',
    },
  });
  assert.equal(context.driver_name, 'Omar Alawad');
  assert.equal(context.unit_number, '005');
  assert.equal(context.driver_type, 'company_driver');
  assert.equal(context.date_of_birth, '1990-02-01');
});

test('renderBroadcastTemplateStrict renders escaped values', () => {
  const rendered = renderBroadcastTemplateStrict('Hi {driver_name}', {
    driver_name: 'Tom & <Jane>',
  });
  assert.equal(rendered.ok, true);
  assert.equal(rendered.rendered, 'Hi Tom &amp; &lt;Jane&gt;');
});

test('renderBroadcastTemplateStrict reports missing placeholder values', () => {
  const rendered = renderBroadcastTemplateStrict('Hi {driver_name} on unit {unit_number}', {
    driver_name: 'John Doe',
    unit_number: '',
  });
  assert.equal(rendered.ok, false);
  assert.deepEqual(rendered.missingTokens, ['unit_number']);
});
