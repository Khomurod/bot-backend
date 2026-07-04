process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'test-bot-token';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-telegram-token';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY = process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY || 'test-fb-key';
process.env.MANAGEMENT_GROUP_ID = process.env.MANAGEMENT_GROUP_ID || '-1001234567890';
process.env.MEDIA_STORAGE_CHAT_ID = '-1002997837889';
process.env.CORS_ALLOW_ALL = 'true';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');

const { app, stagingTelegram } = require('../server/api');

// The upload route uses the dedicated staging client's callApi (with an
// AbortSignal + IPv4 agent). Drive it here per-test. It also calls
// deleteMessage/editMessageCaption on the same client for cleanup.
let sendBehavior = null;
const sendCalls = [];
stagingTelegram.callApi = async (method, payload) => {
  sendCalls.push({ method, chatId: payload.chat_id });
  return sendBehavior(payload.chat_id);
};
stagingTelegram.deleteMessage = async () => true;
stagingTelegram.editMessageCaption = async () => true;

const token = jwt.sign({ username: 'admin' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

function uploadPhoto(server, photoBytes) {
  return new Promise((resolve) => {
    const port = server.address().port;
    const boundary = '----test-boundary-xyz';
    const png = photoBytes || Buffer.from('89504e470d0a1a0a', 'hex');
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const req = http.request(
      { port, method: 'POST', path: '/api/upload-media', headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
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
test.beforeEach(() => { sendCalls.length = 0; });

test('successful upload returns highest-resolution file_id', async () => {
  sendBehavior = () => ({ message_id: 1, photo: [{ file_id: 'low' }, { file_id: 'HIGH' }] });
  const res = await uploadPhoto(server);
  assert.equal(res.status, 200);
  assert.equal(res.body.file_id, 'HIGH');
  assert.equal(res.body.media_type, 'photo');
});

test('"chat not found" surfaces an actionable error, not a generic one', async () => {
  sendBehavior = () => {
    const err = new Error('400: Bad Request: chat not found');
    err.response = { error_code: 400, description: 'Bad Request: chat not found' };
    throw err;
  };
  const res = await uploadPhoto(server);
  assert.equal(res.status, 502);
  assert.match(res.body.error, /chat not found/i);
  assert.match(res.body.error, /MEDIA_STORAGE_CHAT_ID/);
});

test('missing send permission surfaces a permissions hint', async () => {
  sendBehavior = () => {
    const err = new Error('bad rights');
    err.response = { error_code: 400, description: 'Bad Request: not enough rights to send photos to the chat' };
    throw err;
  };
  const res = await uploadPhoto(server);
  assert.equal(res.status, 502);
  assert.match(res.body.error, /admin|allow media/i);
});

test('oversize photo (>10MB) is rejected fast and never reaches Telegram', async () => {
  sendBehavior = () => ({ message_id: 1, photo: [{ file_id: 'X' }] });
  const bigPhoto = Buffer.alloc(11 * 1024 * 1024, 1); // 11MB > Telegram's 10MB photo cap
  const res = await uploadPhoto(server, bigPhoto);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /too large|10MB/i);
  assert.equal(sendCalls.length, 0, 'must not call Telegram for an oversize photo');
});

test('supergroup migration auto-retries against the new chat id', async () => {
  const NEW_ID = -1009999999999;
  let attempt = 0;
  sendBehavior = () => {
    attempt += 1;
    if (attempt === 1) {
      const err = new Error('group upgraded');
      err.response = {
        error_code: 400,
        description: 'Bad Request: group chat was upgraded to a supergroup chat',
        parameters: { migrate_to_chat_id: NEW_ID },
      };
      throw err;
    }
    return { message_id: 2, photo: [{ file_id: 'AFTER_MIGRATE' }] };
  };
  const res = await uploadPhoto(server);
  assert.equal(res.status, 200);
  assert.equal(res.body.file_id, 'AFTER_MIGRATE');
  assert.equal(sendCalls.length, 2, 'should retry once');
  assert.equal(String(sendCalls[1].chatId), String(NEW_ID), 'retry uses migrated id');
});
