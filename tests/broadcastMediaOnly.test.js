process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'test-bot-token';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-telegram-token';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY = process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY || 'test-fb-key';
process.env.MANAGEMENT_GROUP_ID = process.env.MANAGEMENT_GROUP_ID || '-1001234567890';
process.env.MEDIA_STORAGE_CHAT_ID = process.env.MEDIA_STORAGE_CHAT_ID || '-1001234567890';
process.env.CORS_ALLOW_ALL = 'true';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');

// Stub Telegram + DB before the app wires them up.
const { bot } = require('../bot/bot');
const sent = [];
bot.telegram.sendMessage = async (chat, text, opts) => { sent.push({ kind: 'text', chat, text, opts }); return { message_id: 1 }; };
bot.telegram.sendPhoto = async (chat, file, opts) => { sent.push({ kind: 'photo', chat, file, opts }); return { message_id: 2, photo: [{ file_id: 'x' }] }; };
bot.telegram.sendVideo = async () => ({ message_id: 3, video: { file_id: 'v' } });
bot.telegram.sendMediaGroup = async (chat, group) => { sent.push({ kind: 'group', chat, group }); return [{}]; };
bot.telegram.deleteMessage = async () => true;

const db = require('../database/db');
const GROUP = { id: 1, telegram_group_id: '-100111', group_name: 'G1', language: 'en', active: true };
db.createBroadcast = async (b) => ({ id: 555, ...b });
db.createBroadcastDelivery = async () => ({});
db.getDriverProfileByGroupId = async () => null;

const bts = require('../services/broadcastTargetService');
bts.resolveBroadcastTargetGroups = async () => [GROUP];

const { app } = require('../server/api');
const token = jwt.sign({ username: 'admin' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

function request(server, path, payload) {
  return new Promise((resolve) => {
    const port = server.address().port;
    const body = JSON.stringify(payload);
    const req = http.request(
      { port, method: 'POST', path, headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${token}`,
      } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
      }
    );
    req.on('error', () => resolve({ status: 0, body: null }));
    req.write(body);
    req.end();
  });
}

let server;
test.before(() => new Promise((r) => { server = app.listen(0, r); }));
test.after(() => new Promise((r) => server.close(r)));

test('photo-only broadcast (no caption) is accepted', async () => {
  sent.length = 0;
  const res = await request(server, '/api/broadcast/send', {
    message_text: '',
    messages: { en: '' },
    target_type: 'all',
    media_items: [{ file_id: 'PHOTO_ABC', media_type: 'photo' }],
    media_position: 'above',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.broadcast_id, 555);
  const photoSend = sent.find((s) => s.kind === 'photo');
  assert.ok(photoSend, 'a photo should have been sent to the group');
  assert.equal(photoSend.file, 'PHOTO_ABC');
});

test('photo broadcast with caption sends caption', async () => {
  sent.length = 0;
  const res = await request(server, '/api/broadcast/send', {
    message_text: 'Weekly update',
    messages: { en: 'Weekly update' },
    target_type: 'all',
    media_items: [{ file_id: 'PHOTO_XYZ', media_type: 'photo' }],
    media_position: 'above',
  });
  assert.equal(res.status, 200);
  const photoSend = sent.find((s) => s.kind === 'photo');
  assert.equal(photoSend.opts.caption, 'Weekly update');
});

test('empty broadcast (no text, no media) is rejected clearly', async () => {
  const res = await request(server, '/api/broadcast/send', {
    message_text: '',
    messages: { en: '' },
    target_type: 'all',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /photo\/video|message/i);
});

test('invalid media item is rejected', async () => {
  const res = await request(server, '/api/broadcast/send', {
    message_text: 'hi',
    target_type: 'all',
    media_items: [{ file_id: '', media_type: 'photo' }],
  });
  assert.equal(res.status, 400);
});

test('text-only broadcast still works', async () => {
  sent.length = 0;
  const res = await request(server, '/api/broadcast/send', {
    message_text: 'Text only',
    messages: { en: 'Text only' },
    target_type: 'all',
  });
  assert.equal(res.status, 200);
  const textSend = sent.find((s) => s.kind === 'text');
  assert.equal(textSend.text, 'Text only');
});
