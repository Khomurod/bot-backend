/**
 * Boot smoke: the HTTP app assembles with the Trailer feature enabled, and the
 * trailer route is actually mounted (a no-token request is rejected by auth, not
 * 404'd). A trailer-router construction failure would surface here.
 */
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token-2';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= 'test-key';
process.env.CORS_ALLOW_ALL ||= 'true';

const test = require('node:test');
const assert = require('node:assert/strict');

test('server/api assembles with the trailer feature (boot smoke)', async () => {
  const { app } = require('../server/api');
  assert.equal(typeof app.listen, 'function', 'express app should assemble');

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/trailers`);
    // Mounted but auth-guarded → 401/403 (NOT 404, which would mean unmounted).
    assert.ok([401, 403].includes(res.status), `expected auth rejection, got ${res.status}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
