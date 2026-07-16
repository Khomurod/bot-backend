const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createRouteScreenshotMediaRouter } = require('../server/routes/routeScreenshotMediaRoutes');
const { buildTelegramScreenshotUrl } = require('../services/routeControl/screenshotMediaReference');

const SECRET = 'test-only-route-screenshot-signing-secret';
const NOW = Date.parse('2026-07-16T12:00:00Z');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

async function withServer(getScreenshot, fn) {
  const app = express();
  app.use('/api/route-screenshot-media', createRouteScreenshotMediaRouter({
    getScreenshot,
    secret: SECRET,
    now: () => NOW,
  }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const address = server.address();
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function signedPath(baseUrl, screenshot = { file_data: PNG }) {
  const url = new URL(buildTelegramScreenshotUrl({
    assignmentId: 22,
    screenshot,
    baseUrl,
    secret: SECRET,
    now: NOW,
  }));
  return `${url.pathname}${url.search}`;
}

test('signed media endpoint returns the exact image with safe headers', async () => {
  await withServer(async (id) => ({
    assignment_id: id,
    file_data: PNG,
    mime_type: 'image/png',
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}${signedPath(baseUrl)}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('content-length'), String(PNG.length));
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  });
});

test('endpoint rejects a tampered signature before reading the database', async () => {
  let reads = 0;
  await withServer(async () => { reads += 1; return null; }, async (baseUrl) => {
    const path = signedPath(baseUrl).replace(/sig=[^&]+/, 'sig=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'SCREENSHOT_LINK_INVALID');
    assert.equal(reads, 0);
  });
});

test('endpoint rejects an expired URL before reading the database', async () => {
  let reads = 0;
  const app = express();
  app.use('/api/route-screenshot-media', createRouteScreenshotMediaRouter({
    getScreenshot: async () => { reads += 1; return null; },
    secret: SECRET,
    now: () => NOW + (11 * 60 * 1000),
  }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}${signedPath(baseUrl)}`);
    assert.equal(response.status, 410);
    assert.equal((await response.json()).code, 'SCREENSHOT_LINK_EXPIRED');
    assert.equal(reads, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('endpoint refuses a valid old URL after the screenshot is replaced', async () => {
  const replacement = Buffer.from('different-image-bytes');
  await withServer(async () => ({ file_data: replacement, mime_type: 'image/png' }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}${signedPath(baseUrl)}`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'SCREENSHOT_VERSION_REPLACED');
  });
});

test('endpoint reports a safe server error when database retrieval fails', async () => {
  await withServer(async () => { throw Object.assign(new Error('private database detail'), { code: 'DB_DOWN' }); }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}${signedPath(baseUrl)}`);
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.code, 'SCREENSHOT_MEDIA_FETCH_FAILED');
    assert.doesNotMatch(JSON.stringify(body), /private database detail/);
  });
});
