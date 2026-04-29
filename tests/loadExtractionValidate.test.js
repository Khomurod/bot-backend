const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasMinimalStructuredLoad,
  groqFieldsLookComplete,
} = require('../services/loadExtractionValidate');

test('hasMinimalStructuredLoad accepts destination alone', () => {
  assert.equal(
    hasMinimalStructuredLoad({
      destinationQuery: '5151 E RAINES RD, Memphis, TN 38118',
      pickupSummary: '',
      deliverySummary: '',
    }),
    true
  );
});

test('hasMinimalStructuredLoad accepts pickup and delivery pair', () => {
  assert.equal(
    hasMinimalStructuredLoad({
      destinationQuery: '',
      pickupSummary: 'Charlotte, NC',
      deliverySummary: 'Memphis, TN',
    }),
    true
  );
});

test('groqFieldsLookComplete rejects empty', () => {
  assert.equal(groqFieldsLookComplete(null), false);
  assert.equal(groqFieldsLookComplete({ pickupLocation: '', destinationQuery: '' }), false);
});
