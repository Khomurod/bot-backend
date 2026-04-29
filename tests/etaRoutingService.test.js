const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeDestinationQuery } = require('../services/etaRoutingService');
const { formatDuration, computeNextRunAt } = require('../services/dispatchEtaUpdateService');

test('sanitizeDestinationQuery appends USA once and removes existing US suffix', () => {
  assert.equal(sanitizeDestinationQuery('Anderson, TN 46013'), 'Anderson, TN 46013, USA');
  assert.equal(sanitizeDestinationQuery('Anderson, TN 46013, US'), 'Anderson, TN 46013, USA');
  assert.equal(sanitizeDestinationQuery('Anderson, TN 46013, USA'), 'Anderson, TN 46013, USA');
});

test('formatDuration renders minutes and hour/minute labels', () => {
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(35), '35m');
  assert.equal(formatDuration(130), '2h 10m');
});

test('computeNextRunAt returns a future ISO timestamp', () => {
  const nowMs = Date.now();
  const nextIso = computeNextRunAt(15);
  const nextMs = Date.parse(nextIso);
  assert.ok(Number.isFinite(nextMs), 'next run should be a valid ISO timestamp');
  assert.ok(nextMs > nowMs, 'next run should be in the future');
});

