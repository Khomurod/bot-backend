const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.PORT ||= '3001';

const {
  extractFacebookWebhookEvents,
  buildAutoMessageNotification,
} = require('../services/facebookWebhookService');
const { buildAutoMessageSentHtml } = require('../services/facebookLeadSmsMirrorService');

test('extractFacebookWebhookEvents emits dedupable leadgen events with page ids', () => {
  const events = extractFacebookWebhookEvents({
    object: 'page',
    entry: [
      {
        id: '111',
        changes: [
          {
            field: 'leadgen',
            value: {
              leadgen_id: 'abc',
              page_id: '111',
              form_id: 'form-1',
            },
          },
        ],
      },
    ],
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].eventKey, 'leadgen:111:abc');
  assert.equal(events[0].pageId, '111');
  assert.equal(events[0].payload.leadgenId, 'abc');
});

test('extractFacebookWebhookEvents emits messenger events and falls back to sender/timestamp key', () => {
  const events = extractFacebookWebhookEvents({
    object: 'page',
    entry: [
      {
        id: '222',
        messaging: [
          {
            sender: { id: 'person-1' },
            recipient: { id: '222' },
            timestamp: 123456789,
            message: { text: 'Hello' },
          },
        ],
      },
    ],
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'messaging');
  assert.match(events[0].eventKey, /^messaging:222:/);
  assert.equal(events[0].payload.event.sender.id, 'person-1');
});

test('extractFacebookWebhookEvents ignores non-page payloads', () => {
  const events = extractFacebookWebhookEvents({
    object: 'user',
    entry: [],
  });
  assert.deepEqual(events, []);
});

test('buildAutoMessageNotification returns null on SMS success', () => {
  const text = buildAutoMessageNotification(
    { phone_number: '+15551234567' },
    { ok: true },
    'Jane Doe',
    'Working hours',
  );
  assert.equal(text, null);
});

test('buildAutoMessageSentHtml includes phone and monospace body', () => {
  const html = buildAutoMessageSentHtml('+15551234567', 'Hello Jane');
  assert.match(html, /AutoMessage sent via SMS to \+15551234567:/);
  assert.match(html, /<pre>Hello Jane<\/pre>/);
});

test('buildAutoMessageNotification reports missing phone', () => {
  const text = buildAutoMessageNotification({}, { ok: false, reason: 'no_phone' }, 'Jane');
  assert.equal(text, 'AutoMessage skipped: no phone on lead.');
});

test('buildAutoMessageNotification reports RingCentral failure', () => {
  const text = buildAutoMessageNotification(
    { phone: '+15559876543' },
    { ok: false, detail: 'rate limited' },
    'Bob',
  );
  assert.match(text, /AutoMessage failed for \+15559876543/);
  assert.match(text, /rate limited/);
});
