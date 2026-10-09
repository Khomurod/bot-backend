const test = require('node:test');
const assert = require('node:assert/strict');

// Ensure config's required env vars exist before requiring modules that load it.
process.env.DATABASE_URL ||= 'postgres://test';
process.env.JWT_SECRET ||= 'test-secret';
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-telegram-token';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= 'test-fb-key';

const { looksLikeDocsUrl, DEFAULT_DRIVEHOS_API_BASE } = require('../database/eldSettings');

test('looksLikeDocsUrl flags Swagger / documentation URLs', () => {
  assert.equal(looksLikeDocsUrl('https://api.drivehos.app/swagger/index.html'), true);
  assert.equal(looksLikeDocsUrl('https://api.drivehos.app/swagger-ui'), true);
  assert.equal(looksLikeDocsUrl('https://docs.drivehos.app/index.html'), true);
  assert.equal(looksLikeDocsUrl('https://api.drivehos.app/#/vehicles'), true);
  assert.equal(looksLikeDocsUrl('https://api.drivehos.app/api-docs'), true);
});

test('looksLikeDocsUrl accepts a real API host', () => {
  assert.equal(looksLikeDocsUrl('https://api.drivehos.app'), false);
  assert.equal(looksLikeDocsUrl('https://api.drivehos.app/'), false);
  assert.equal(looksLikeDocsUrl(''), false);
  assert.equal(looksLikeDocsUrl(null), false);
});

test('DEFAULT_DRIVEHOS_API_BASE is the real API host', () => {
  assert.equal(DEFAULT_DRIVEHOS_API_BASE, 'https://api.drivehos.app');
});

test('the effective ELD config is read at most once per five minutes, and at once after a save', async (t) => {
  // October 2026: at a 30-second cache the whole settings row was re-read up
  // to 2,880 times a day by the location resolver's hot path.
  const path = require('node:path');
  const modPath = path.resolve(__dirname, '../database/eldSettings.js');
  // The module reads through the `database/db.js` façade.
  const poolPath = path.resolve(__dirname, '../database/db.js');
  const samsaraPath = path.resolve(__dirname, '../database/samsaraSettings.js');
  let reads = 0;
  delete require.cache[modPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { query: async () => { reads += 1; return { rows: [{}] }; } } };
  require.cache[samsaraPath] = { id: samsaraPath, filename: samsaraPath, loaded: true, exports: { getSamsaraConfig: async () => ({}) } };
  t.after(() => { delete require.cache[modPath]; delete require.cache[poolPath]; delete require.cache[samsaraPath]; });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T00:00:00Z') });
  const eld = require(modPath);
  assert.ok(eld.CACHE_TTL_MS >= 5 * 60 * 1000);

  await eld.getEldConfig();
  t.mock.timers.tick(4 * 60 * 1000);
  await eld.getEldConfig();
  assert.equal(reads, 1, 'four minutes later it is still the cached config');
  eld.invalidateCache();
  await eld.getEldConfig();
  assert.equal(reads, 2, 'a save (which invalidates) is read at once');
});
