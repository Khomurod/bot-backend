'use strict';

/**
 * Audit redaction (database/adminAudit.js).
 *
 * An audit entry carries whole before/after row images, so redaction is what
 * keeps password hashes, tokens and signed-URL material out of the audit log
 * at any nesting depth. APP_BRIEF.md lists it as a preserved decision.
 */

const test = require('node:test');
const assert = require('node:assert');
const { redact } = require('../database/adminAudit');

test('top-level sensitive keys are redacted', () => {
  const out = redact({ username: 'a', password: 'p', api_key: 'k', token: 't' });
  assert.equal(out.username, 'a');
  assert.equal(out.password, '[REDACTED]');
  assert.equal(out.api_key, '[REDACTED]');
  assert.equal(out.token, '[REDACTED]');
});

test('nested sensitive keys are redacted recursively', () => {
  const out = redact({ payment: { rows: [{ signed_url: 'https://x?sig=abc', amount: 5 }] }, meta: { password_hash: 'h' } });
  assert.equal(out.payment.rows[0].signed_url, '[REDACTED]');
  assert.equal(out.payment.rows[0].amount, 5);
  assert.equal(out.meta.password_hash, '[REDACTED]');
});

test('signed-url material and hashes are caught', () => {
  const out = redact({ signature: 's', jwt: 'j', authorization: 'Bearer x', bearer: 'y' });
  assert.equal(out.signature, '[REDACTED]');
  assert.equal(out.jwt, '[REDACTED]');
  assert.equal(out.authorization, '[REDACTED]');
  assert.equal(out.bearer, '[REDACTED]');
});

test('non-sensitive checksum fields are preserved', () => {
  const out = redact({ checksum_sha256: 'abc123', username: 'operator' });
  assert.equal(out.checksum_sha256, 'abc123');
  assert.equal(out.username, 'operator');
});

test('primitives and null pass through', () => {
  assert.equal(redact(null), null);
  assert.equal(redact('x'), 'x');
  assert.equal(redact(5), 5);
});

test('deeply nested structures do not blow the stack', () => {
  let deep = { secret: 's' };
  for (let i = 0; i < 20; i += 1) deep = { child: deep };
  assert.doesNotThrow(() => redact(deep));
});
