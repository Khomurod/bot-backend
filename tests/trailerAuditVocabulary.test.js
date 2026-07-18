/**
 * Audit-trail vocabulary: every known action renders as a plain sentence with
 * no technical jargon; unknown actions degrade gracefully.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const mod = () => import(pathToFileURL(path.resolve(
  __dirname, '../admin/src/pages/trailer/more/auditVocabulary.js',
)).href);

test('known actions render as human sentences', async () => {
  const { auditSentence } = await mod();
  assert.equal(auditSentence({ username: 'anna', action: 'payment.create' }), 'anna recorded a payment');
  assert.equal(auditSentence({ username: null, action: 'agreement.close' }), 'Someone completed a rental');
});

test('no label contains dots, underscores or jargon', async () => {
  const { AUDIT_ACTION_LABELS } = await mod();
  for (const [action, label] of Object.entries(AUDIT_ACTION_LABELS)) {
    assert.ok(!/[._]/.test(label), `${action} label "${label}" reads technical`);
    assert.ok(!/legacy|blob|backend|amendment|reconcil/i.test(label), `${action} label "${label}" has jargon`);
  }
});

test('unknown actions degrade to readable text, never crash', async () => {
  const { auditSentence } = await mod();
  assert.equal(auditSentence({ username: 'bo', action: 'weird.new_thing' }), 'bo weird new thing');
  assert.equal(auditSentence({}), 'Someone did something');
});
