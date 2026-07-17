const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

process.env.DATABASE_URL ||= 'postgres://test:test@localhost/test';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-telegram-token';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef';

const { createHealthRoutes } = require('../server/routes/healthRoutes');

async function withServer(run) {
  const app = express();
  app.use(createHealthRoutes({ db: { ping: async () => true }, config: {} }));

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });

  try {
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('GET /123 serves the responsive image page', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/123`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.match(html, /<img src="\/123\/image\.png"/);
    assert.match(html, /object-fit: contain/);
  });
});

test('GET /123/image.png serves the supplied PNG', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/123/image.png`);
    const bytes = Buffer.from(await response.arrayBuffer());

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^image\/png/);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(bytes.length > 200_000);
  });
});
