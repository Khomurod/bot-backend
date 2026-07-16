const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Telegram } = require('telegraf');

async function captureTelegramRequest(run) {
  let captured;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      captured = {
        path: req.url,
        contentType: req.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: 1410 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const apiRoot = `http://127.0.0.1:${server.address().port}`;
    await run(new Telegram('12345:test-token', { apiRoot }));
    return captured;
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('Telegraf editMessageMedia with a URL sends JSON, not multipart', async () => {
  const screenshotUrl = 'https://bot-backend.example/api/route-screenshot-media/22?v=version&exp=1&sig=signed';
  const request = await captureTelegramRequest((telegram) => telegram.callApi('editMessageMedia', {
    chat_id: '-100900',
    message_id: 1410,
    media: { type: 'photo', media: screenshotUrl, caption: 'Route', parse_mode: 'HTML' },
  }));
  assert.equal(request.path, '/bot12345:test-token/editMessageMedia');
  assert.match(request.contentType, /^application\/json/);
  assert.doesNotMatch(request.contentType, /multipart/i);
  assert.equal(JSON.parse(request.body).media.media, screenshotUrl);
});

test('Telegraf sendPhoto with a URL sends JSON, protecting future route sends', async () => {
  const screenshotUrl = 'https://bot-backend.example/api/route-screenshot-media/23?v=version&exp=1&sig=signed';
  const request = await captureTelegramRequest((telegram) => telegram.sendPhoto(
    '-100900',
    screenshotUrl,
    { caption: 'Route', parse_mode: 'HTML' }
  ));
  assert.equal(request.path, '/bot12345:test-token/sendPhoto');
  assert.match(request.contentType, /^application\/json/);
  assert.doesNotMatch(request.contentType, /multipart/i);
  assert.equal(JSON.parse(request.body).photo, screenshotUrl);
});
