const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBatchResponse } = require('../services/translationService');

test('parseBatchResponse returns the translations array verbatim', () => {
  const raw = JSON.stringify({ translations: ['Привет', 'Мир'] });
  assert.deepEqual(parseBatchResponse(raw, 2), ['Привет', 'Мир']);
});

test('parseBatchResponse rejects non-JSON content', () => {
  assert.throws(() => parseBatchResponse('[1] Привет\n[2] Мир', 2), /not valid JSON/);
});

test('parseBatchResponse rejects missing translations key', () => {
  const raw = JSON.stringify({ results: ['a', 'b'] });
  assert.throws(() => parseBatchResponse(raw, 2), /missing "translations"/);
});

test('parseBatchResponse rejects wrong item count', () => {
  const raw = JSON.stringify({ translations: ['only one'] });
  assert.throws(() => parseBatchResponse(raw, 2), /count mismatch/);
});

test('parseBatchResponse coerces non-string entries to strings', () => {
  const raw = JSON.stringify({ translations: ['ok', 42] });
  assert.deepEqual(parseBatchResponse(raw, 2), ['ok', '42']);
});

test('parseBatchResponse throws on empty input', () => {
  assert.throws(() => parseBatchResponse('', 1), /Empty response/);
  assert.throws(() => parseBatchResponse(null, 1), /Empty response/);
});
